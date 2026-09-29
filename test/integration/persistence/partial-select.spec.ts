import { type MikroORM } from '@mikro-orm/postgresql';

import { expectSameMoney } from '../support/expect-domain';
import {
  EUR_PER_USD,
  LIMIT,
  OCCURRED_AT,
  aProgram,
  anAuditContext,
  convertedThrough,
  usd,
} from '../support/factories';
import { initTestOrm, resetDatabase } from '../support/orm';
import { insertProgramRow } from '../support/rows';
import { UnknownCurrencyError } from '../../../src/capacity/domain/errors';
import { Money } from '../../../src/capacity/domain/money';
import { type Program } from '../../../src/capacity/domain/program';
import { MikroOrmCapacityEventLog } from '../../../src/capacity/infrastructure/persistence/mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmReservationRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-reservation.repository';
import { programSchema } from '../../../src/capacity/infrastructure/persistence/program.mapping';
import { reservationSchema } from '../../../src/capacity/infrastructure/persistence/reservation.mapping';

// What a partial select may hand over: a projection that asks for some amounts
// but not the facts they depend on must be refused, naming what was left out —
// but the reconciliation watermark's own two-column select must keep working,
// since it has no amount to pair and nothing to be wrong about (docs/PLAN.md
// §2.1, §2.7).
describe('a partial select', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await resetDatabase(orm);
  });

  /** The message of whatever `work` rejected with, or `null` if it resolved. */
  async function rejectionMessage(
    work: () => Promise<unknown>,
  ): Promise<string | null> {
    try {
      await work();

      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  // The error itself rather than its message, so a caller can also assert its
  // type — the owner case below needs both.
  async function rejectionOf(work: () => Promise<unknown>): Promise<unknown> {
    try {
      await work();

      return null;
    } catch (error) {
      return error;
    }
  }

  describe('of a converted hold, without the six fx columns', () => {
    /** The EUR program holding one converted USD invoice, as `seed.ts` has it. */
    beforeEach(async () => {
      const program = aProgram({ id: 'prog-hanseatic', currency: 'EUR' });
      const change = program.reserve(
        {
          invoiceId: 'inv-0002',
          amount: convertedThrough(usd(10_000_000n), EUR_PER_USD),
        },
        null,
        anAuditContext(),
      );

      const em = orm.em.fork();

      await em.transactional(async (tx) => {
        new MikroOrmProgramRepository(tx).add(program);
        new MikroOrmReservationRepository(tx).add(change.reservation);
        new MikroOrmCapacityEventLog(tx).append(change.event!);
        await tx.flush();
      });
    });

    /** Every mapped column of `reservations` except the FX group. */
    const withoutFxColumns = [
      'programId',
      'invoiceId',
      '_status',
      'originalAmount',
      'originalCurrency',
      '_reservedAmount',
      '_releasedAmount',
      'heldCurrency',
      '_reservedAt',
      '_releasedAt',
      '_releaseReason',
    ] as const;

    it('is refused with the columns it left out, rather than reported as a hold with no rate', async () => {
      // Asserted on the message, not just on throwing: a client could otherwise
      // read "no rate to explain it" for a hold that has one, which reads as
      // corrupt data instead of a query that omitted columns.
      const message = await rejectionMessage(() =>
        orm.em
          .fork()
          .find(
            reservationSchema,
            { programId: 'prog-hanseatic', invoiceId: 'inv-0002' },
            { fields: [...withoutFxColumns] },
          ),
      );

      expect(message).not.toBeNull();
      expect(message).toMatch(/fx_base/);
      expect(message).toMatch(/fx_scaled_value/);
      expect(message).not.toMatch(/no rate to explain it/);
    });

    it('is refused for an unconverted hold too, because the query cannot tell the two apart', async () => {
      const program = aProgram({
        id: 'prog-northwind',
        creditLimit: usd(LIMIT),
      });
      const change = program.reserve(
        {
          invoiceId: 'inv-0001',
          amount: {
            original: usd(1_800_000n),
            converted: usd(1_800_000n),
            rate: null,
          },
        },
        null,
        anAuditContext(),
      );

      const em = orm.em.fork();

      await em.transactional(async (tx) => {
        new MikroOrmProgramRepository(tx).add(program);
        new MikroOrmReservationRepository(tx).add(change.reservation);
        new MikroOrmCapacityEventLog(tx).append(change.event!);
        await tx.flush();
      });

      const message = await rejectionMessage(() =>
        orm.em
          .fork()
          .find(
            reservationSchema,
            { programId: 'prog-northwind', invoiceId: 'inv-0001' },
            { fields: [...withoutFxColumns] },
          ),
      );

      expect(message).not.toBeNull();
      expect(message).toMatch(/fx_base/);
    });
  });

  describe('of a program, with a currency and one amount but not the other', () => {
    beforeEach(async () => {
      await insertProgramRow(orm.em, {
        credit_limit: '1000000000',
        reserved_amount: '180000000',
      });
    });

    it('is refused with the amount column it left out', async () => {
      // Refused rather than assembled: the omitted column is what
      // `Program.rehydrate` checks the credit limit against, so there is no
      // sound aggregate to hand over.
      const message = await rejectionMessage(() =>
        orm.em
          .fork()
          .find(
            programSchema,
            { id: 'prog-northwind' },
            { fields: ['id', 'currency', '_creditLimit'] },
          ),
      );

      expect(message).not.toBeNull();
      expect(message).toMatch(/reserved_amount|_reserved/);
    });

    it('never hands over an aggregate whose amount is not Money', async () => {
      // Holds even for a future fix that chooses to assemble a partial program
      // instead of refusing it.
      const loaded = await orm.em
        .fork()
        .find(
          programSchema,
          { id: 'prog-northwind' },
          { fields: ['id', 'currency', '_creditLimit'] },
        )
        .catch(() => null);

      if (loaded === null) {
        return;
      }

      for (const program of loaded) {
        // Read through `unknown`: the declared type is the very claim being checked.
        const creditLimit: unknown = program._creditLimit;

        expect(creditLimit).toBeInstanceOf(Money);
      }
    });
  });

  // The exact projection GET /programs/:id/capacity issues (docs/PLAN.md
  // §2.7): both amounts and the currency, but not `owner_org_id`. The
  // hydrator's gate only checks currency and the two amounts, so this
  // projection used to pass the gate and fail inside the domain instead.
  describe('of a program, with both amounts and the currency but not its owner', () => {
    /**
     * The `programs` columns docs/PLAN.md 2.7's capacity response is built from.
     * `available` and `overUtilized` are derived rather than stored, and `id` is the
     * primary key, which MikroORM adds to every explicit field list of its own
     * accord (`AbstractSqlDriver.buildFields`).
     */
    const CAPACITY_RESPONSE_FIELDS = [
      'currency',
      '_creditLimit',
      '_reserved',
      'lastReconciledAt',
    ] as const;

    beforeEach(async () => {
      await insertProgramRow(orm.em, {
        credit_limit: '1000000000',
        reserved_amount: '180000000',
        last_snapshot_sequence: '9',
        last_reconciled_at: OCCURRED_AT,
      });
    });

    it('is refused with the owner column it left out, rather than dying inside the domain', async () => {
      // Both halves matter: the message must name `owner_org_id`, and the error
      // must not be the `TypeError` raised from inside `Program.rehydrate` — a
      // text-only match would pass for the wrong reason.
      const error = await rejectionOf(() =>
        orm.em
          .fork()
          .find(
            programSchema,
            { id: 'prog-northwind' },
            { fields: [...CAPACITY_RESPONSE_FIELDS] },
          ),
      );

      expect(error).not.toBeNull();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/owner_org_id/);
      expect(error).not.toBeInstanceOf(TypeError);
    });

    it('assembles the same projection once the owner is in it, so refusing everything is not the fix', async () => {
      // What stops "refuse every program projection" from being the fix for the
      // test above: this endpoint needs its own derived figures too.
      const [stored] = await orm.em
        .fork()
        .find(
          programSchema,
          { id: 'prog-northwind' },
          { fields: [...CAPACITY_RESPONSE_FIELDS, 'ownerOrgId'] },
        );

      expect(stored).toBeDefined();

      // Cast rather than through `asProgram`, whose type expects the full row
      // this projection doesn't have.
      const program = stored as unknown as Program;

      expectSameMoney(program.creditLimit, usd(LIMIT));
      expectSameMoney(program.reserved, usd(180_000_000n));
      expectSameMoney(program.available, usd(LIMIT - 180_000_000n));
      expect(program.overUtilized).toBe(false);
      expect(program.currency).toBe('USD');
      expect(program.ownerOrgId).toBe('org-northwind');
      // MikroORM always includes the primary key, even outside an explicit
      // field list — the one hole of this kind that can't occur.
      expect(program.id).toBe('prog-northwind');
      // Not on the aggregate; read off the row instead.
      expect(stored!.lastReconciledAt?.toISOString()).toBe(
        OCCURRED_AT.toISOString(),
      );
    });
  });

  describe('of the reconciliation watermark, which must keep working', () => {
    it('answers for a program whose currency this build cannot state, while the full read refuses it', async () => {
      // The one partial select production actually issues
      // (`MikroOrmProgramRepository.findWatermark`) — asserted beside the full
      // read so that "refuse every partial select" can't pass as a fix for the
      // cases above.
      await insertProgramRow(orm.em, {
        currency: 'XXX',
        last_snapshot_sequence: '9',
        last_reconciled_at: OCCURRED_AT,
      });

      const repository = new MikroOrmProgramRepository(orm.em.fork());
      const watermark = await repository.findWatermark('prog-northwind');

      expect(watermark?.appliedSequence).toBe(9n);
      expect(watermark?.reconciledAt?.toISOString()).toBe(
        OCCURRED_AT.toISOString(),
      );

      await expect(
        new MikroOrmProgramRepository(orm.em.fork()).findById('prog-northwind'),
      ).rejects.toThrow(UnknownCurrencyError);
    });

    it('answers for a program whose counter has drifted past its limit, which is corruption and not a state', async () => {
      // Reconciliation reads this as COUNTER_DRIFT and refuses the snapshot
      // over it (docs/PLAN.md §2.1); staleness still has to be decidable.
      await insertProgramRow(orm.em, {
        currency: 'XXX',
        credit_limit: '1',
        reserved_amount: '9007199254740993',
        last_snapshot_sequence: '4',
        last_reconciled_at: OCCURRED_AT,
      });

      const watermark = await new MikroOrmProgramRepository(
        orm.em.fork(),
      ).findWatermark('prog-northwind');

      expect(watermark?.appliedSequence).toBe(4n);
    });
  });
});

import { type MikroORM } from '@mikro-orm/postgresql';

import { expectSameMoney } from '../support/expect-domain';
import {
  EUR_PER_USD,
  LATER,
  LIMIT,
  OCCURRED_AT,
  aProgram,
  anAuditContext,
  convertedThrough,
  eur,
  unconverted,
  usd,
} from '../support/factories';
import { expectCapacityInvariant } from '../support/invariant';
import { initTestOrm, resetDatabase } from '../support/orm';
import { execute, selectRow } from '../support/rows';
import { UnknownCurrencyError } from '../../../src/capacity/domain/errors';
import { Money } from '../../../src/capacity/domain/money';
import { type Program } from '../../../src/capacity/domain/program';
import { type Reservation } from '../../../src/capacity/domain/reservation';
import { MikroOrmCapacityEventLog } from '../../../src/capacity/infrastructure/persistence/mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmReservationRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-reservation.repository';

// Every other spec forks a fresh EntityManager per operation. This file
// deliberately reuses ONE instead, because that's the shape production runs
// in (one request-scoped EntityManager per HTTP request, forked with
// `clear: false` inside a transaction) — and a second read into an entity
// already in the identity map is exactly where a hydration gate keyed on
// "which columns arrived" (rather than on the entity's resulting state) can
// go blind to a corrupt or stale value. Do not turn these forks into
// `orm.em.fork()`; that would delete the only coverage of this shape.
describe('a second read through the same EntityManager', () => {
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

  /** Commits a program, and optionally one hold with the event that explains it. */
  async function store(
    program: Program,
    hold?: { reservation: Reservation; event: unknown },
  ): Promise<void> {
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      new MikroOrmProgramRepository(tx).add(program);

      if (hold !== undefined) {
        new MikroOrmReservationRepository(tx).add(hold.reservation);
        new MikroOrmCapacityEventLog(tx).append(
          hold.event as Parameters<MikroOrmCapacityEventLog['append']>[0],
        );
      }

      await tx.flush();
    });
  }

  /** A committed change made by somebody else, exactly as a concurrent request would. */
  async function commitElsewhere(
    sql: string,
    params: unknown[] = [],
  ): Promise<void> {
    await execute(orm.em, sql, params);
  }

  describe('a program', () => {
    it('is still an assembled aggregate after the row is read a second time', async () => {
      // The second read is the locking one every capacity change goes
      // through, and what it hands over is what a credit decision is taken
      // against.
      const program = aProgram({ creditLimit: usd(LIMIT) });

      await store(program);

      // Deliberately one EntityManager for both reads — see the file docblock.
      const em = orm.em.fork();
      const first = await new MikroOrmProgramRepository(em).findById(
        program.id,
      );

      expectSameMoney(first!.reserved, usd(0n));

      await commitElsewhere(
        `update "programs" set "reserved_amount" = '180000000' where "id" = ?`,
        [program.id],
      );

      const second = await em.transactional((tx) =>
        new MikroOrmProgramRepository(tx).findForCapacityChange(program.id),
      );

      expectSameMoney(second!.creditLimit, usd(LIMIT));
      expectSameMoney(second!.reserved, usd(180_000_000n));
      expectSameMoney(second!.available, usd(LIMIT - 180_000_000n));
    });

    it('takes a hold on a program the same EntityManager had already read', async () => {
      const program = aProgram({ creditLimit: usd(LIMIT) });

      await store(program);

      // Deliberately one EntityManager — see the file docblock.
      const em = orm.em.fork();

      await new MikroOrmProgramRepository(em).findById(program.id);

      await commitElsewhere(
        `update "programs" set "reserved_amount" = '180000000' where "id" = ?`,
        [program.id],
      );

      await em.transactional(async (tx) => {
        const locked = await new MikroOrmProgramRepository(
          tx,
        ).findForCapacityChange(program.id);
        const change = locked!.reserve(
          { invoiceId: 'inv-0001', amount: unconverted(usd(1_800_000n)) },
          null,
          anAuditContext(),
        );

        new MikroOrmReservationRepository(tx).add(change.reservation);
        new MikroOrmCapacityEventLog(tx).append(change.event!);
      });

      const row = await selectRow<{ reserved_amount: string }>(
        orm.em,
        `select "reserved_amount" from "programs" where "id" = ?`,
        [program.id],
      );

      expect(row?.reserved_amount).toBe('181800000');

      const reloaded = await new MikroOrmProgramRepository(
        orm.em.fork(),
      ).findById(program.id);

      expectSameMoney(reloaded!.reserved, usd(181_800_000n));
    });

    it('still refuses a currency this build does not support when the row is read a second time', async () => {
      const program = aProgram({ creditLimit: usd(LIMIT) });

      await store(program);

      // Deliberately one EntityManager — see the file docblock.
      const em = orm.em.fork();

      await new MikroOrmProgramRepository(em).findById(program.id);

      await commitElsewhere(
        `update "programs" set "currency" = 'XXX' where "id" = ?`,
        [program.id],
      );

      const rereading = async (): Promise<Program | null> =>
        em.transactional((tx) =>
          new MikroOrmProgramRepository(tx).findForCapacityChange(program.id),
        );

      await expect(rereading()).rejects.toThrow(UnknownCurrencyError);
    });

    it('refuses the same corrupt currency on a first read, which is the contrast', async () => {
      const program = aProgram({ creditLimit: usd(LIMIT) });

      await store(program);
      await commitElsewhere(
        `update "programs" set "currency" = 'XXX' where "id" = ?`,
        [program.id],
      );

      const reading = async (): Promise<Program | null> =>
        new MikroOrmProgramRepository(orm.em.fork()).findById(program.id);

      await expect(reading()).rejects.toThrow(UnknownCurrencyError);
    });
  });

  describe('a reservation', () => {
    /** The EUR program holding one converted USD invoice, as `seed.ts` has it. */
    async function storeConvertedHold(): Promise<void> {
      const program = aProgram({ id: 'prog-hanseatic', currency: 'EUR' });
      const change = program.reserve(
        {
          invoiceId: 'inv-0002',
          amount: convertedThrough(usd(10_000_000n), EUR_PER_USD),
        },
        null,
        anAuditContext(),
      );

      await store(program, {
        reservation: change.reservation,
        event: change.event,
      });
    }

    it('comes back with Money amounts and its rate after a committed correction', async () => {
      // `findForReconciliation` is an `em.find`, so it always queries — the
      // same EntityManager cycle 8 uses after an idempotency lookup for the
      // same invoice.
      await storeConvertedHold();

      // Deliberately one EntityManager — see the file docblock.
      const em = orm.em.fork();
      const repository = new MikroOrmReservationRepository(em);

      const first = await repository.findForInvoice(
        'prog-hanseatic',
        'inv-0002',
      );

      expectSameMoney(first!.reservedAmount, eur(9_235_000n));

      await commitElsewhere(
        `update "reservations" set "reserved_amount" = '9300000' where "program_id" = ? and "invoice_id" = ?`,
        ['prog-hanseatic', 'inv-0002'],
      );

      const [reloaded] = await repository.findForReconciliation(
        'prog-hanseatic',
        ['inv-0002'],
      );

      expectSameMoney(reloaded!.reservedAmount, eur(9_300_000n));
      expectSameMoney(reloaded!.originalAmount, usd(10_000_000n));
      expectSameMoney(reloaded!.releasedAmount, eur(0n));
      // The frozen rate has to survive with the amount: a readable figure
      // with no evidence behind it is worse than an unreadable one.
      expect(reloaded!.fxRate?.toDecimalString()).toBe('0.9235');
      // What the drift check sums, which is the reason this read exists.
      expectSameMoney(reloaded!.outstandingAmount, eur(9_300_000n));
    });

    it('comes back released and holding nothing after a committed release', async () => {
      // outstandingAmount is what reconcileProgram's counter-drift gate sums,
      // so an unreadable one takes the whole program out of reconciliation.
      await storeConvertedHold();

      // Deliberately one EntityManager — see the file docblock.
      const em = orm.em.fork();
      const repository = new MikroOrmReservationRepository(em);

      await repository.findForInvoice('prog-hanseatic', 'inv-0002');

      await commitElsewhere(
        `update "reservations"
            set "status" = 'RELEASED',
                "released_amount" = "reserved_amount",
                "released_at" = ?,
                "release_reason" = 'REPAID'
          where "program_id" = ? and "invoice_id" = ?`,
        [LATER, 'prog-hanseatic', 'inv-0002'],
      );

      const [reloaded] = await repository.findForReconciliation(
        'prog-hanseatic',
        ['inv-0002'],
      );

      expect(reloaded!.status).toBe('RELEASED');
      expectSameMoney(reloaded!.releasedAmount, eur(9_235_000n));
      expectSameMoney(reloaded!.outstandingAmount, eur(0n));
    });
  });

  describe('strongly consistent, which means not from the identity map', () => {
    it('reports the committed figure when findById is asked a second time', async () => {
      // `findById` promises a single-row read that isn't served from the
      // identity map (docs/PLAN.md §2.8): a stale answer here is a client
      // reading capacity that is already spent. The EntityManager is reused
      // deliberately — in production there is exactly one per request, and a
      // handler reading capacity twice is the ordinary case.
      const program = aProgram({ creditLimit: usd(LIMIT) });

      await store(program);

      const em = orm.em.fork();
      const repository = new MikroOrmProgramRepository(em);

      expectSameMoney(
        (await repository.findById(program.id))!.reserved,
        usd(0n),
      );

      await commitElsewhere(
        `update "programs" set "reserved_amount" = '180000000' where "id" = ?`,
        [program.id],
      );

      const again = await repository.findById(program.id);

      expectSameMoney(again!.reserved, usd(180_000_000n));
      expectSameMoney(again!.available, usd(LIMIT - 180_000_000n));
    });

    it('reports a limit somebody else lowered, so an over-utilised program cannot read as healthy', async () => {
      const program = aProgram({ creditLimit: usd(LIMIT) });
      const hold = program.reserve(
        { invoiceId: 'inv-0001', amount: unconverted(usd(900_000_000n)) },
        null,
        anAuditContext(),
      );

      await store(program, {
        reservation: hold.reservation,
        event: hold.event,
      });
      await expectCapacityInvariant(orm, program.id);

      const em = orm.em.fork();
      const repository = new MikroOrmProgramRepository(em);
      const before = await repository.findById(program.id);

      expect(before!.overUtilized).toBe(false);

      await commitElsewhere(
        `update "programs" set "credit_limit" = '500000000' where "id" = ?`,
        [program.id],
      );

      const after = await repository.findById(program.id);

      expectSameMoney(
        after!.creditLimit,
        Money.fromMinorUnits(500_000_000n, 'USD'),
      );
      expectSameMoney(after!.available, usd(-400_000_000n));
      expect(after!.overUtilized).toBe(true);
    });

    it('reports the committed watermark when findWatermark follows a read of the same program', async () => {
      // A stale watermark here makes reconciliation redo an already-applied
      // snapshot, then fail at commit because the fresh-reading write
      // disagrees about how far the program has got — the message loops
      // forever, blaming the caller. The EntityManager is reused because
      // cycle 8 reads the program and its watermark in the same transaction.
      const program = aProgram({ creditLimit: usd(LIMIT) });

      await store(program);

      // Already reconciled once: the ordinary state of a live program, and
      // the only state in which a stale answer is wrong rather than null.
      await commitElsewhere(
        `update "programs" set "last_snapshot_sequence" = '7', "last_reconciled_at" = ? where "id" = ?`,
        [OCCURRED_AT, program.id],
      );

      const em = orm.em.fork();
      const repository = new MikroOrmProgramRepository(em);

      // The read that puts the program in the identity map.
      expect(await repository.findById(program.id)).not.toBeNull();

      expect(
        (await repository.findWatermark(program.id))?.appliedSequence,
      ).toBe(7n);

      await commitElsewhere(
        `update "programs" set "last_snapshot_sequence" = '9', "last_reconciled_at" = ? where "id" = ?`,
        [LATER, program.id],
      );

      const watermark = await repository.findWatermark(program.id);

      expect(watermark?.appliedSequence).toBe(9n);
      // The instant moves with the sequence, or capacity responses would pair
      // a fresh sequence with a stale `lastReconciledAt`.
      expect(watermark?.reconciledAt?.toISOString()).toBe(LATER.toISOString());
    });
  });
});

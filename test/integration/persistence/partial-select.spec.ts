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

/**
 * What a **partial select** may hand over.
 *
 * # The three cases, and why they belong in one file
 *
 * `DomainHydrator` gates assembly on whether the incoming columns carry everything
 * the assembly reads, and gives one reason for it: `findWatermark` is a deliberate
 * two-column select that has to keep answering for a program whose amounts cannot be
 * hydrated, because "answering stale beats failing the message" (docs/PLAN.md 2.1's
 * governing rule applied to reconciliation). That reasoning is sound for a row with
 * **nothing to pair** — no amount was asked for, so no amount can be wrong.
 *
 * It is not sound for a partial select that asks for *some* of the facts an aggregate
 * is made of. Three such selects exist as soon as anybody writes a projection, and
 * each of them once produced something the domain's types say is impossible:
 *
 * 1. the non-FX columns of a converted hold — the amounts without the evidence;
 * 2. a currency and one amount but not the other;
 * 3. both amounts and the currency, but not `owner_org_id` — which is not a
 *    hypothetical projection but the exact column list docs/PLAN.md 2.7 specifies for
 *    `GET /programs/:id/capacity`, so the one error class the gate exists to raise was
 *    bypassed by the one projection the plan actually asks cycle 6 for.
 *
 * So they are tested together with the watermark: whoever fixes the first three must
 * not fix them by making every partial select throw, and the watermark tests below are
 * what stops that.
 *
 * # The call this file makes about what "correct" is
 *
 * **A partial select that asks for amounts but not the facts they depend on is
 * refused, with a message naming what was left out.** The alternative — hand back a
 * sound-looking aggregate — is not available: the missing columns are exactly the
 * ones that decide whether the row is valid, so there is nothing to validate against
 * and nothing honest to report. Silently answering "there is no rate" for a hold
 * whose rate simply was not selected is worse than either, because it is a true
 * sentence about the query and a false one about the invoice, and it arrives as
 * `InvalidReservationError` — the same error a genuinely unexplained hold raises.
 *
 * The assertions below are therefore about the **message**, not only about the
 * throwing: pinning "it throws" would pass today, for the wrong reason.
 */
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

  /**
   * The error object itself, rather than its message — `null` if `work` resolved.
   *
   * The twin of {@link rejectionMessage} rather than a replacement for it, because
   * the owner case below has to assert the error's **type** as well as what it says:
   * a projection that omits `owner_org_id` used to die as a `TypeError` from inside
   * `Program.rehydrate`, whose message names neither the column nor the projection,
   * so a test that only matched on text would have passed for that reason.
   */
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
      // B1. The row is a perfectly good converted hold — `reservation-repository`
      // reads it back with its rate, and `hydration.spec.ts` proves that a hold
      // genuinely missing its evidence is refused. What must not happen is the two
      // becoming the same answer: a projection that omits `fx_*` today produces
      // "USD is held as EUR with no rate to explain it", which reads as a corrupt
      // row and would send somebody looking for a data fault that does not exist.
      //
      // The assertion names the columns deliberately. Asserting only that it throws
      // would pass right now, for precisely the reason this test exists to rule out.
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
      // The six columns the read did not ask for, by name, so the message tells a
      // reader which projection to widen.
      expect(message).toMatch(/fx_base/);
      expect(message).toMatch(/fx_scaled_value/);
      // And not the sentence that describes a corrupt row, which this row is not.
      expect(message).not.toMatch(/no rate to explain it/);
    });

    it('is refused for an unconverted hold too, because the query cannot tell the two apart', async () => {
      // The same projection over a hold that genuinely has no rate. It is tempting
      // to let this one through — all six columns really are null — but the read
      // cannot distinguish "null in the row" from "not in the select", which is the
      // whole reason `fxRateFromColumns` treats `undefined` as absent. Letting it
      // through would make the refusal depend on data rather than on the query, so
      // a projection would work in testing and fail on the first converted invoice.
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
      // B2. Today this resolves, and what it resolves to is an aggregate whose
      // `creditLimit` getter returns the `bigint` `1000000000n` although its type
      // says `Money` — so `program.creditLimit.toDecimalString()` is a `TypeError`
      // and `program.available` is a `CurrencyMismatchError` naming `undefined`.
      // Neither failure mentions the projection that caused it.
      //
      // Refused rather than assembled, and the reason is not symmetry with B1: the
      // omitted column is `reserved_amount`, which is the figure `Program.rehydrate`
      // checks the row against (same currency, never negative) and the figure every
      // derived answer subtracts. There is no sound aggregate to hand over, and a
      // half-assembled one that throws later, somewhere else, is the worst of the
      // three outcomes.
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
      // Named so the message points at the projection, not at the row.
      expect(message).toMatch(/reserved_amount|_reserved/);
    });

    it('never hands over an aggregate whose amount is not Money', async () => {
      // The property underneath the refusal, stated on its own so that a future
      // implementation which chooses to *assemble* a partial program instead of
      // refusing it is also held to something. Either outcome satisfies this; only
      // today's silent `bigint` fails it.
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
        // Read through `unknown`, because the declared type is the very claim
        // being checked: the schema says `Money` and this is what actually arrives.
        const creditLimit: unknown = program._creditLimit;

        expect(creditLimit).toBeInstanceOf(Money);
      }
    });
  });

  /**
   * # The projection docs/PLAN.md 2.7 actually asks for
   *
   * The two cases above omit a figure or the evidence behind one, which is the shape
   * somebody writes by accident. This one omits `owner_org_id`, which is the shape the
   * plan asks for on purpose: `GET /programs/:id/capacity` answers with limit,
   * reserved, available, currency, `lastReconciledAt` and `overUtilized`, and not one
   * of those is the owner.
   *
   * `assembleProgram` reads `stored.ownerOrgId` and hands it to `Program.rehydrate`,
   * which trims it — but the hydrator's gate lists only the currency and the two
   * amounts, so this projection passes the gate and dies inside the domain instead.
   * The one error class the hydrator has, whose entire purpose is to turn an unusable
   * projection into a message naming the column to add, was therefore bypassed by the
   * one projection cycle 6 is specified to issue.
   *
   * # The call this file makes about which way that is fixed
   *
   * **Refusal, and a wider projection at the call site** — not tolerance. The rule the
   * gate implements is "a projection that selects any amount must also select
   * everything the assembly reads", `ownerOrgId` is one of those, and making it
   * optional would mean teaching the assembly to work without the field the domain
   * validates. It also costs that endpoint nothing: §2.7 checks `program.ownerOrgId
   * === user.org` before answering at all, so the capacity read needs the column in
   * its projection regardless of what the hydrator demands.
   */
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
      // B4, and the blocker: today this rejects, but with `TypeError: Cannot read
      // properties of undefined (reading 'trim')` raised by `trimmedIdentifier`
      // inside `Program.rehydrate`. That message names neither the column nor the
      // query, so a reader gets a stack trace through the ORM's hydrator into the
      // domain and no clue that the cause is a `fields` list four lines long.
      //
      // Both halves of the assertion are load-bearing. The message has to name
      // `owner_org_id`, because naming the column is the entire value of the gate;
      // and it must not be a `TypeError`, because that is precisely the outcome this
      // test exists to rule out and the one that would let a text match pass by
      // accident.
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
      // Named, so the message points at the projection to widen. Asserted before
      // the type, so a failure prints the sentence a reader would actually get.
      expect((error as Error).message).toMatch(/owner_org_id/);
      // And not the failure from inside the domain, which is what happens today.
      expect(error).not.toBeInstanceOf(TypeError);
    });

    it('assembles the same projection once the owner is in it, so refusing everything is not the fix', async () => {
      // The companion, and it is the assertion that constrains *how* the test above
      // is made to pass: a gate that refused every program projection would satisfy
      // B4 and break the endpoint it was written for. One column wider, and the
      // capacity response has every figure it renders — including the two that are
      // derived rather than stored, which are the ones a half-assembled aggregate
      // turns into an exception (docs/PLAN.md 2.7, 2.8).
      const [stored] = await orm.em.fork().find(
        programSchema,
        { id: 'prog-northwind' },
        // The one addition, which §2.7's ownership check needs anyway.
        { fields: [...CAPACITY_RESPONSE_FIELDS, 'ownerOrgId'] },
      );

      expect(stored).toBeDefined();

      // Seen as the aggregate, which is what the instance is: MikroORM returns a
      // real `Program` with a real prototype. The view is taken here rather than
      // through `asProgram` because a projection's `Loaded<…>` type knows it omits
      // `lastSnapshotSequence`, and `asProgram` is typed for the full row
      // production reads.
      const program = stored as unknown as Program;

      expectSameMoney(program.creditLimit, usd(LIMIT));
      expectSameMoney(program.reserved, usd(180_000_000n));
      expectSameMoney(program.available, usd(LIMIT - 180_000_000n));
      expect(program.overUtilized).toBe(false);
      expect(program.currency).toBe('USD');
      expect(program.ownerOrgId).toBe('org-northwind');
      // The primary key arrives although the projection never asked for it, which is
      // the fact that makes `owner_org_id` the *only* hole of this kind: MikroORM
      // adds every primary key to an explicit field list of its own accord, so a
      // `reservations` projection always carries `program_id` and `invoice_id` and
      // `assembleReservation` can never meet them undefined.
      expect(program.id).toBe('prog-northwind');
      // The reconciliation instant the response also carries, read off the row
      // rather than the aggregate: it is a column the program does not have.
      expect(stored!.lastReconciledAt?.toISOString()).toBe(
        OCCURRED_AT.toISOString(),
      );
    });
  });

  describe('of the reconciliation watermark, which must keep working', () => {
    it('answers for a program whose currency this build cannot state, while the full read refuses it', async () => {
      // B3. The one partial select the service actually issues, and the reason the
      // hydrator has a gate at all: the watermark is what tells cycle 8 whether a
      // snapshot is stale, and a program that cannot be hydrated must not take the
      // whole message down with it (`MikroOrmProgramRepository.findWatermark`).
      //
      // It is asserted **beside** the full read in one test on purpose. B1 and B2
      // above can be made to pass by refusing every partial select, and this is the
      // assertion that makes that fix visibly wrong: two columns that carry no
      // amount have nothing to pair and no invariant to judge, so there is nothing
      // for a refusal to be about.
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
      // A second shape of "the amounts cannot be trusted", chosen because it is the
      // one reconciliation reads as `COUNTER_DRIFT` and refuses the snapshot over
      // (docs/PLAN.md 2.1). Deciding staleness still has to be possible, or the
      // program stops reconciling with nothing to explain why.
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

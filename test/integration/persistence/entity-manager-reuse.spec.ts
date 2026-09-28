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

/**
 * Reading the same row **twice through one `EntityManager`**.
 *
 * # Read this before changing anything below
 *
 * Every other spec in this directory takes a fresh `orm.em.fork()` per operation,
 * and `support/invariant.ts` says why: "so nothing here can be right only because
 * MikroORM's identity map still held the object that wrote it". That discipline is
 * what makes the suite trustworthy, and it is also what makes it blind to this whole
 * family of defects.
 *
 * **The reuse of one `EntityManager` in this file is the subject of the tests, not an
 * oversight.** Turning any of these `em`s into a fork would make every test below
 * pass while deleting the only coverage the service has of the shape production
 * actually runs in: `@mikro-orm/nestjs` gives one request-scoped `EntityManager` per
 * HTTP request, and `em.transactional()` forks it with `clear: false` — so the
 * entities a `GET` put in the identity map are still there when the following
 * `POST /reservations` locks the same row, and are merged back afterwards.
 *
 * # The mechanism these tests are about
 *
 * `DomainHydrator.hydrate` **used to** decide whether to assemble an aggregate by
 * asking whether the incoming `data` carried every column the assembly reads. That is
 * true of a first read, whose `data` is the whole row. It was **not** true of a second
 * read of a row already in the identity map: `EntityFactory.mergeData` computes the
 * diff between what the entity holds and what the database just returned, and calls
 * the hydrator with **only the changed columns**. The gate was then `false`, the
 * assembly never ran, and `ObjectHydrator` had already written the raw `bigint` that
 * `MoneyAmountType` produces into a property the domain declares as `Money`.
 *
 * What that cost, concretely: `program.available` threw instead of answering,
 * `program.reserve` threw instead of deciding, and a corrupt row was no longer
 * refused. None of it was visible to a suite that forks, which is why it was found by
 * review rather than by the tests beside this file.
 *
 * The gate is now `assemblyOf(entity, meta, …)`, a question about the **entity's
 * resulting state** and never about which keys arrived — so a diff-shaped hydration
 * assembles from what the entity is now made of, whenever any part of it arrived. It
 * answers three ways rather than two, because "not one amount is present" (the
 * watermark read) and "some amount is present and something else is missing" are
 * different situations; `partial-select.spec.ts` covers that third answer.
 *
 * # So why this file still reuses one `EntityManager`
 *
 * Because the shape is what production runs in, not because the defect is still
 * there. The gate was rewritten once; nothing stops a later change to the hydrator,
 * to `refresh`, or to `flushMode` from reintroducing a fault that only a reused
 * context can see, and the fresh-fork discipline every other spec follows is exactly
 * what makes the rest of the suite unable to see it. These tests are the standing
 * cost of that discipline being paid somewhere.
 */
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
      // A1. The sequence is the ordinary one for a request that reads capacity and
      // then changes it: `GET /capacity` loads the program, something else commits,
      // and the reservation that follows re-reads the same row under the lock.
      //
      // The second read is the locking one, and that is not a detail. When this
      // test was written a plain `findById` never reached the database at all once
      // the entity was in the identity map — `em.findOne` returns the managed
      // instance when no pessimistic lock is asked for — so
      // `findForCapacityChange` was the only read in the service that could observe
      // a changed column arriving into an existing entity. That was a *separate*
      // defect, fixed by `refresh: true`, and the "strongly consistent" tests at
      // the bottom of this file are what hold it fixed.
      //
      // The locking read is still the right one to assert here, for a reason that
      // does not depend on the other defect: it is the read every capacity change
      // goes through, and what it hands over is what a funder's credit decision is
      // taken against.
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

      // Both amounts are `Money`, not the `bigint` the column produced: `Money`
      // is the only shape the aggregate's arithmetic accepts, and a `bigint`
      // sitting in `_reserved` makes every figure `GET /capacity` reports either
      // wrong or an exception (docs/PLAN.md 2.3, 2.6).
      expectSameMoney(second!.creditLimit, usd(LIMIT));
      expectSameMoney(second!.reserved, usd(180_000_000n));
      // And the derived figure answers rather than throwing, which is what the
      // caller of a capacity change is about to decide against.
      expectSameMoney(second!.available, usd(LIMIT - 180_000_000n));
    });

    it('takes a hold on a program the same EntityManager had already read', async () => {
      // A2. The same hydration path end to end, in the shape cycle 5 and cycle 6
      // will run:
      // one request-scoped `EntityManager`, a read, then the transactional capacity
      // change. The assertion is on the stored counter, so a hold that was
      // "accepted" without moving the column cannot pass either.
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
      // A3. `hydration.spec.ts` proves the refusal for a row read once, and that
      // is the whole guarantee the strict hydration decision bought
      // (docs/PLAN.md 2.1: a hold whose currency cannot be trusted must not be
      // summed into an exposure figure). A gate that asked about the incoming
      // columns handed that guarantee back the moment the row had been read before:
      // the new `currency` was written onto the entity and nothing checked it.
      // Asking the entity's resulting state is what closed that, and this is the
      // test that says the guarantee now holds on a second read too.
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
      // A3's other half, in its own test so the difference between the two is on
      // record rather than being something a reader has to reconstruct: the refusal
      // used to work only for a context that had not seen the row, and both tests
      // passing is the statement that it no longer depends on that.
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
      // A4. The reservation half of the same gate, which was blind in the same way
      // and is asserted here so it stays sighted. The second read is
      // `findForReconciliation`, which is an `em.find` and therefore always issues
      // its query — so this is not a hypothetical path but the one cycle 8 runs on
      // every snapshot, against an `EntityManager` that has already answered an
      // idempotency lookup for the same invoice.
      //
      // The correction is what treasury does when it restates a held amount
      // (docs/PLAN.md 2.1), and it is committed from elsewhere so that the second
      // read really has a changed column to merge.
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
      // The frozen evidence has to survive with it: a hold whose amount is
      // readable and whose rate is not is a figure with nothing behind it
      // (docs/PLAN.md 2.3).
      expect(reloaded!.fxRate?.toDecimalString()).toBe('0.9235');
      // The figure the drift check sums, which is the reason the read exists.
      expectSameMoney(reloaded!.outstandingAmount, eur(9_300_000n));
    });

    it('comes back released and holding nothing after a committed release', async () => {
      // The other committed change a reservation can undergo, and the one that
      // moves four columns at once. `outstandingAmount` is the figure
      // `reconcileProgram`'s counter-drift gate sums, so an unreadable one takes
      // the program out of reconciliation altogether.
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
      // C1. `ProgramRepository.findById` promises "a strongly consistent single-row
      // read", and docs/PLAN.md 2.8 names the failure this is about in as many
      // words: caching availability is an anti-pattern here because "a client could
      // make a credit decision against a stale, overstated figure". A primary-key
      // `findOne` used to answer the second call from the identity map without
      // issuing a query at all, which is exactly that cache — and nothing in the
      // port's contract says a caller has to fork to be told the truth.
      // `refresh: true` is what closed it, and this test is what keeps it closed:
      // the option is one word to drop and nothing else in the suite would notice.
      //
      // The reuse of one `EntityManager` is the subject of the test: in production
      // there is exactly one per request, and an SSE stream or a handler that reads
      // capacity twice is the ordinary case rather than a contrived one.
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
      // The same freshness question with the sign that matters: a limit reduced by
      // reconciliation takes availability below zero and the program has to report
      // `overUtilized` (docs/PLAN.md 2.1). A stale read says the opposite, which is
      // the one answer that lets a funder keep lending against a limit it has
      // already withdrawn.
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
      // C2. `findById` was given `refresh: true` for exactly the staleness C1 pins.
      // `findWatermark` was not, and it is a primary-key `findOne` too — so once the
      // program is in the identity map it issues **no query at all** and hands back
      // whatever sequence the earlier read happened to see.
      //
      // The failure that causes is worth stating, because it is not "a slightly old
      // number". Cycle 8 reads a stale watermark, judges an already-applied snapshot
      // as news, does the entire reconciliation, and then `advanceWatermark` throws
      // "refusing to move … from 9 to 8" at the end of the transaction — because
      // `findForCapacityChange` *does* refresh, so the decision and the write
      // disagree about how far the program has got. The transaction rolls back, the
      // message is redelivered, and the loop repeats for ever, with an error that
      // blames the caller for a decision the repository made.
      //
      // The `EntityManager` is reused deliberately: cycle 8 reads the program and its
      // watermark in one transaction, which is what the port's own note about reading
      // both "in the same transaction" describes.
      const program = aProgram({ creditLimit: usd(LIMIT) });

      await store(program);

      // Already reconciled once, which is the ordinary state of a live program and
      // the only state in which a stale answer is a wrong answer rather than a null.
      await commitElsewhere(
        `update "programs" set "last_snapshot_sequence" = '7', "last_reconciled_at" = ? where "id" = ?`,
        [OCCURRED_AT, program.id],
      );

      const em = orm.em.fork();
      const repository = new MikroOrmProgramRepository(em);

      // The read that puts the program in the identity map — a capacity read, an
      // idempotency check, anything at all.
      expect(await repository.findById(program.id)).not.toBeNull();

      // The premise: at this point 7 is both what the repository says and what is
      // committed, so the assertion below is about freshness and nothing else.
      expect(
        (await repository.findWatermark(program.id))?.appliedSequence,
      ).toBe(7n);

      await commitElsewhere(
        `update "programs" set "last_snapshot_sequence" = '9', "last_reconciled_at" = ? where "id" = ?`,
        [LATER, program.id],
      );

      const watermark = await repository.findWatermark(program.id);

      expect(watermark?.appliedSequence).toBe(9n);
      // The instant moves with the sequence: the pair means one thing, and a
      // sequence read fresh beside a stale `asOf` would put a wrong
      // `lastReconciledAt` in every capacity response (docs/PLAN.md 2.7).
      expect(watermark?.reconciledAt?.toISOString()).toBe(LATER.toISOString());
    });
  });
});

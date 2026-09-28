import { type EntityManager, type MikroORM } from '@mikro-orm/postgresql';

import {
  LIMIT,
  aProgram,
  anAuditContext,
  unconverted,
  usd,
} from '../support/factories';
import { expectCapacityInvariant } from '../support/invariant';
import { initTestOrm, resetDatabase } from '../support/orm';
import { countRows, selectRow } from '../support/rows';
import { captureSql, writeStatements } from '../support/sql-log';
import { type ReservationChange } from '../../../src/capacity/domain/program';
import { MikroOrmCapacityEventLog } from '../../../src/capacity/infrastructure/persistence/mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmReservationRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-reservation.repository';

/**
 * A read issued while a capacity change is still unflushed.
 *
 * # Why this is a different file from `read-amplification.spec.ts`
 *
 * That file asks whether reading a **clean** row writes it back, and the mechanism it
 * guards is the change-detection snapshot: `DomainHydrator` validating without
 * adopting, `MoneyAmountType.compareAsType()` comparing minor units. Nothing there is
 * about a unit of work that has real work in it.
 *
 * This file asks the opposite question. `buildOrmOptions` sets no `flushMode`, so
 * MikroORM's default `auto` applies, and `EntityManager.findOne` calls `tryFlush`
 * **before** the identity-map short-circuit (`EntityManager.js`). `tryFlush` asks
 * `UnitOfWork.shouldAutoFlush(meta)`, which answers yes when the queried entity's
 * class has a queued `persist` or when any tracked instance of it is touched — and
 * every scalar assignment on a tracked aggregate touches it, because
 * `EntityHelper.defineProperties` installs a setter that says so. `Program.reserve`
 * assigns `_reserved`. So does every other capacity operation.
 *
 * # What that costs, which is more than an extra statement
 *
 * A read issued between "the domain decided" and "the repositories wrote" commits the
 * decision on its own: `begin / update programs / commit`, a moved counter with **no**
 * `reservations` row and **no** `capacity_events` row. That is docs/PLAN.md 2.4's
 * invariant — `reserved_amount == SUM(active holds) == SUM(deltas)` — broken in
 * committed state, not in memory, and docs/PLAN.md 2.1 says counter drift is never
 * healed automatically: the program is rejected as `COUNTER_DRIFT` by every later
 * snapshot, for ever, with no record of what moved it.
 *
 * It is not a contrived sequence. One request-scoped `EntityManager` per HTTP request
 * is what `@mikro-orm/nestjs` gives cycle 6, and "decide the hold, then read something
 * before writing it" is the ordinary shape of a handler that answers with the new
 * capacity, checks another invoice for idempotency, or logs the audit page it is
 * about to extend.
 *
 * # The two things each test asserts, and why one is not enough
 *
 * The statement log says a write was issued; the committed rows say what it cost.
 * Asserting only the log would pass a fix that moved the write somewhere else, and
 * asserting only the rows would miss a write that happened to be idempotent. Each
 * test also guards the capture itself — `statements.length` above zero — so "no
 * writes" cannot pass because nothing was recorded at all.
 *
 * The statements come through MikroORM's own `onQuery` hook; `support/sql-log.ts` says
 * why that and not a second ORM with a capturing logger.
 */
describe('a read while a capacity change is unflushed', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await resetDatabase(orm);
    await store();
  });

  const PROGRAM_ID = 'prog-northwind';
  const INVOICE_ID = 'inv-0001';
  /** A second invoice, so a read can ask about one the change does not touch. */
  const OTHER_INVOICE_ID = 'inv-0002';
  const HOLD = 1_800_000n;

  /** The program, committed with nothing reserved against it. */
  async function store(): Promise<void> {
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      new MikroOrmProgramRepository(tx).add(
        aProgram({ id: PROGRAM_ID, creditLimit: usd(LIMIT) }),
      );
      await tx.flush();
    });
  }

  /**
   * One `EntityManager` holding a program whose counter the domain has just moved,
   * with nothing flushed and nothing staged.
   *
   * The mutation goes through `Program.reserve` rather than a bare assignment,
   * because the point is that an ordinary domain operation is enough: no test-only
   * poking at a private field, no `em.persist`, just the aggregate doing its job in
   * the half-second before its caller writes the result.
   */
  async function midChange(): Promise<{
    em: EntityManager;
    change: ReservationChange;
  }> {
    const em = orm.em.fork();
    const program = await new MikroOrmProgramRepository(em).findById(
      PROGRAM_ID,
    );

    expect(program).not.toBeNull();

    return {
      em,
      change: program!.reserve(
        { invoiceId: INVOICE_ID, amount: unconverted(usd(HOLD)) },
        null,
        anAuditContext(),
      ),
    };
  }

  interface CommittedState {
    reserved: string | undefined;
    reservations: number;
    events: number;
  }

  /**
   * The three figures a half-flushed capacity change makes disagree, read as raw
   * committed rows through the global `EntityManager` — which has no part in the
   * unit of work under test and therefore cannot be told a comfortable answer by it.
   */
  async function committedState(): Promise<CommittedState> {
    const row = await selectRow<{ reserved_amount: string }>(
      orm.em,
      `select "reserved_amount" from "programs" where "id" = ?`,
      [PROGRAM_ID],
    );

    return {
      reserved: row?.reserved_amount,
      reservations: await countRows(orm.em, 'reservations'),
      events: await countRows(orm.em, 'capacity_events'),
    };
  }

  /** Nothing has been written: the state every test below must still find. */
  const NOTHING_WRITTEN: CommittedState = {
    reserved: '0',
    reservations: 0,
    events: 0,
  };

  /**
   * What a read did, as one value: the statements that would change a row, and the
   * state those statements left committed.
   *
   * One object rather than two `expect`s because Jest stops at the first failing
   * assertion, and the two halves are only useful together — the statement names the
   * write, the rows say what it cost. Asserting them separately would report the
   * `update` and leave a reader to guess whether it committed.
   */
  async function damageOf(statements: readonly string[]): Promise<{
    writes: string[];
    committed: CommittedState;
  }> {
    return {
      writes: writeStatements(statements),
      committed: await committedState(),
    };
  }

  /** Nothing was written and nothing landed: what every read below must produce. */
  const NO_DAMAGE = { writes: [], committed: NOTHING_WRITTEN };

  it('issues no write when findById is asked about the program the domain has just changed', async () => {
    // The reported case, and the worst of them: nothing is staged yet, so the flush
    // this read triggers commits the moved counter **alone** — no hold to account for
    // it and no audit row to explain it. Both legs of docs/PLAN.md 2.4's invariant
    // break at once, and by 2.1 nothing will ever repair them.
    const { em } = await midChange();

    const { statements } = await captureSql(orm, () =>
      new MikroOrmProgramRepository(em).findById(PROGRAM_ID),
    );

    // A guard on the capture, asserted first because it is the premise: "no writes"
    // means nothing unless the read itself was seen.
    expect(statements.length).toBeGreaterThan(0);
    expect(await damageOf(statements)).toEqual(NO_DAMAGE);
  });

  it('issues no write when findWatermark is asked about it either', async () => {
    // The same exposure through the watermark read, which is worth its own test
    // because it is a *partial* select and therefore looks harmless: two columns, no
    // amounts, no assembly. `tryFlush` runs before any of that and asks only which
    // table is being queried, so a reconciliation that reads how far it has got
    // commits a counter move it has not decided yet.
    const { em } = await midChange();

    const { statements } = await captureSql(orm, () =>
      new MikroOrmProgramRepository(em).findWatermark(PROGRAM_ID),
    );

    expect(statements.length).toBeGreaterThan(0);
    expect(await damageOf(statements)).toEqual(NO_DAMAGE);
  });

  it('issues no write when a reservation read follows the hold being staged', async () => {
    // The other half of the exposure, and the reason it is not only about `programs`:
    // `shouldAutoFlush` answers yes for a queued `persist` of the queried class too,
    // so staging the hold arms every later `reservations` read. The idempotency
    // lookup of a second invoice in the same request is exactly such a read, and the
    // flush it triggers commits the counter and the hold while the audit row — staged
    // last, because the log is appended after the change is assembled — is still only
    // in memory.
    const { em, change } = await midChange();

    new MikroOrmReservationRepository(em).add(change.reservation);

    const { statements } = await captureSql(orm, () =>
      new MikroOrmReservationRepository(em).findForInvoice(
        PROGRAM_ID,
        OTHER_INVOICE_ID,
      ),
    );

    expect(statements.length).toBeGreaterThan(0);
    expect(await damageOf(statements)).toEqual(NO_DAMAGE);
  });

  it('issues no write when the audit log is read after an event was appended', async () => {
    // And through the log, which is the one table where a premature write is not just
    // wrong but unrepairable: `capacity_events` is append-only behind a trigger, so a
    // row committed here for a change that is then abandoned cannot be deleted. The
    // audit trail is the answer to "why did available capacity drop at 10:32?"
    // (docs/PLAN.md 2.8), and this is how it comes to hold an entry for a reservation
    // that never existed.
    const { em, change } = await midChange();

    new MikroOrmCapacityEventLog(em).append(change.event!);

    // The read's own outcome is captured rather than allowed to propagate, and
    // asserted last. Today the premature flush does not only write the row — it then
    // hands the row straight back out of the identity map, where `delta` is still the
    // `Money` the write put there rather than the `bigint` a read produces, so
    // `capacityEventFromRow` throws the `TypeError` its sibling `discrepancyFromRow`
    // documents that boundary for. Letting that surface here would replace this
    // test's failure with an unrelated one and hide the write entirely. Once no write
    // is issued the page is empty, nothing is converted, and the read simply answers.
    let pageFailure: unknown = null;

    const { statements } = await captureSql(orm, async () => {
      try {
        await new MikroOrmCapacityEventLog(em).findByProgram(PROGRAM_ID, {
          limit: 10,
        });
      } catch (error) {
        pageFailure = error;
      }
    });

    expect(statements.length).toBeGreaterThan(0);
    expect(await damageOf(statements)).toEqual(NO_DAMAGE);
    expect(pageFailure).toBeNull();
  });

  it('commits every row of the change when the same read happens inside the transaction', async () => {
    // Where the real boundary is, pinned so that a fix cannot be "forbid reads near
    // writes". Inside `em.transactional` an early flush is harmless: the statements
    // join the transaction the caller already opened, the commit is still atomic, and
    // all three rows land together. What makes the cases above damaging is not the
    // flush but the autocommit around it.
    //
    // This is also the shape cycle 8 runs — lock, decide, stage, and read again
    // before the transaction ends — so it has to stay legal.
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      const locked = await new MikroOrmProgramRepository(
        tx,
      ).findForCapacityChange(PROGRAM_ID);
      const change = locked!.reserve(
        { invoiceId: INVOICE_ID, amount: unconverted(usd(HOLD)) },
        null,
        anAuditContext(),
      );

      new MikroOrmReservationRepository(tx).add(change.reservation);
      new MikroOrmCapacityEventLog(tx).append(change.event!);

      // The read that flushes. Asserted on rather than avoided: it is the same call
      // the tests above forbid outside a transaction.
      expect(
        await new MikroOrmProgramRepository(tx).findById(PROGRAM_ID),
      ).not.toBeNull();
    });

    expect(await committedState()).toEqual({
      reserved: HOLD.toString(),
      reservations: 1,
      events: 1,
    });
    // The three figures agreeing is the statement that matters, and it is the one
    // the cases above break.
    await expectCapacityInvariant(orm, PROGRAM_ID);
  });
});

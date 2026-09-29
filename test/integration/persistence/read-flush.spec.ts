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

// A read issued while a capacity change is still unflushed. MikroORM's
// default `auto` flush mode runs `tryFlush` before the identity-map
// short-circuit, so any read on a touched entity class can commit an
// in-progress domain decision on its own — a moved counter with no
// `reservations` row and no `capacity_events` row, breaking the invariant of
// docs/PLAN.md §2.4 in committed state, which §2.1 never heals automatically.
// Each test asserts both the write statement and the committed rows, since
// either alone could pass for the wrong reason. Contrast with
// `read-amplification.spec.ts`, which is about a *clean* row, not one with a
// pending change.
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

  // A program whose counter `Program.reserve` has just moved, with nothing
  // flushed and nothing staged — an ordinary domain operation, no test-only
  // poking at a private field.
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

  // Read through the global EntityManager, which has no part in the unit of
  // work under test and so cannot be handed a comfortable answer by it.
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

  // One object rather than two `expect`s, so a failure shows both the write
  // and what it committed rather than leaving one to guess at the other.
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
    // The worst case: nothing is staged yet, so a triggered flush commits the
    // moved counter alone — no hold and no audit row to explain it, and
    // nothing ever repairs that drift.
    const { em } = await midChange();

    const { statements } = await captureSql(orm, () =>
      new MikroOrmProgramRepository(em).findById(PROGRAM_ID),
    );

    // Guards the capture itself: "no writes" means nothing unless the read
    // was actually seen.
    expect(statements.length).toBeGreaterThan(0);
    expect(await damageOf(statements)).toEqual(NO_DAMAGE);
  });

  it('issues no write when findWatermark is asked about it either', async () => {
    // Worth its own test because a partial, two-column select looks harmless;
    // `tryFlush` runs before assembly and only asks which table is queried.
    const { em } = await midChange();

    const { statements } = await captureSql(orm, () =>
      new MikroOrmProgramRepository(em).findWatermark(PROGRAM_ID),
    );

    expect(statements.length).toBeGreaterThan(0);
    expect(await damageOf(statements)).toEqual(NO_DAMAGE);
  });

  it('issues no write when a reservation read follows the hold being staged', async () => {
    // Not only `programs` is exposed: staging the hold arms every later
    // `reservations` read too, such as an idempotency lookup for a second
    // invoice in the same request — while the audit row, staged last, is
    // still only in memory.
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
    // `capacity_events` is append-only behind a trigger: a row committed here
    // for a change that's later abandoned can never be deleted, unlike the
    // other two tables.
    const { em, change } = await midChange();

    new MikroOrmCapacityEventLog(em).append(change.event!);

    // Captured rather than allowed to propagate: a premature flush can hand
    // the just-written row back out of the identity map with `delta` still a
    // `Money` instead of the `bigint` a read produces, which would fail with
    // an unrelated TypeError and hide the write this test is actually about.
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
    // Pins the real boundary, so a fix can't be "forbid reads near writes":
    // inside `em.transactional` an early flush just joins the open
    // transaction and all three rows still land together atomically.
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

      // The same call the tests above forbid outside a transaction.
      expect(
        await new MikroOrmProgramRepository(tx).findById(PROGRAM_ID),
      ).not.toBeNull();
    });

    expect(await committedState()).toEqual({
      reserved: HOLD.toString(),
      reservations: 1,
      events: 1,
    });
    await expectCapacityInvariant(orm, PROGRAM_ID);
  });
});

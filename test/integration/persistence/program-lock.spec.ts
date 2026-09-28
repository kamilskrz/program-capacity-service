import { type MikroORM } from '@mikro-orm/postgresql';

import { expectSameMoney } from '../support/expect-domain';
import {
  LIMIT,
  aProgram,
  anAuditContext,
  unconverted,
  usd,
} from '../support/factories';
import { expectCapacityInvariant } from '../support/invariant';
import { initTestOrm, resetDatabase } from '../support/orm';
import { type Money } from '../../../src/capacity/domain/money';
import { type Program } from '../../../src/capacity/domain/program';
import { MikroOrmCapacityEventLog } from '../../../src/capacity/infrastructure/persistence/mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmReservationRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-reservation.repository';

/**
 * The lock actually locks.
 *
 * # Why this is the most important test in the persistence suite
 *
 * `ProgramRepository.findForCapacityChange` promises a *property*: "from the moment
 * this resolves until the caller's transaction ends, no other transaction can read
 * this program for a capacity change — so the reserved total the caller decides
 * against is the one it will write against" (docs/PLAN.md 2.4). Everything else about
 * correctness under concurrency rests on it, and nothing asserted it. The adapter's
 * own tests prove that it refuses to run outside a transaction and that it hands the
 * program over inside one; neither of those would fail if the `lockMode` argument
 * were deleted.
 *
 * What a missing or ineffective lock looks like is not an error. It is two
 * transactions that both read a reserved total of zero, both decide there is room and
 * both commit — a limit oversold, which is the single defect this service exists to
 * prevent. Cycle 5 bets its central test (50 concurrent reservations, exact success
 * count, invariant intact) on this property, so it is worth proving on its own,
 * against the real container, first.
 *
 * ## What it would catch
 *
 * - **`lockMode` dropped from the `findOne` call.** `B` then never waits: it acquires
 *   while `A` still holds the row and reads the pre-image.
 * - **`FOR UPDATE` issued in autocommit.** Postgres releases the lock as the statement
 *   ends, so again `B` proceeds at once against the pre-image. The adapter's
 *   `em.isInTransaction()` guard is what prevents that today; this is the test that
 *   would notice if the guard were satisfied while the read itself escaped the
 *   transaction — a fork that lost its transaction context, say.
 * - **A lock broader than the row.** The second test rules that out from the other
 *   side: a table lock or an advisory lock on a constant would pass the first test
 *   and turn "hundreds per second per program" into "hundreds per second, globally".
 *
 * ## How it stays non-flaky
 *
 * No assertion is about elapsed time. The claim — "`B` had not acquired before `A`
 * committed" — is recorded as a **marker taken while `A` is still holding the row**:
 * at that instant the log must read "A acquired, B asked" and nothing more. Comparing
 * two markers written by two racing promises after the commit would be the flaky
 * version of the same idea, and is deliberately avoided.
 *
 * One timing value appears, and it is only a bound: long enough for `B`'s blocked
 * `select … for update` to have reached the server. If it were too short the test
 * would fail on "B asked", which names its own cause rather than flaking.
 */
describe('the program row lock', () => {
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

  async function createProgram(program: Program): Promise<Program> {
    const em = orm.em.fork();

    await em.transactional((tx) => {
      new MikroOrmProgramRepository(tx).add(program);
    });

    return program;
  }

  /** A promise plus the function that settles it — the gate `A` is held open by. */
  function gate(): { open: () => void; opened: Promise<void> } {
    let open = (): void => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });

    return { open, opened };
  }

  /** Long enough for a blocked `select … for update` to have reached the server. */
  const ENOUGH_TO_BE_WAITING_MS = 300;

  const sleep = async (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Waits until `condition` holds, so the two transactions are sequenced by what has
   * actually happened rather than by the order two promises were constructed in.
   */
  async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 10_000;

    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error('the first transaction never acquired the row lock');
      }

      await sleep(10);
    }
  }

  it('makes a second capacity change wait, and then shows it the committed total', async () => {
    const program = await createProgram(aProgram({ creditLimit: usd(LIMIT) }));

    const markers: string[] = [];
    const held = gate();

    // `A` takes the lock, records that it has it, and then deliberately does
    // nothing until the test lets it go — which is what gives `B` a window in which
    // it can only be blocked or wrong.
    const first = orm.em.fork().transactional(async (tx) => {
      const locked = await new MikroOrmProgramRepository(
        tx,
      ).findForCapacityChange(program.id);

      markers.push('A acquired');
      await held.opened;

      const change = locked!.reserve(
        { invoiceId: 'inv-0001', amount: unconverted(usd(180_000_000n)) },
        null,
        anAuditContext(),
      );

      new MikroOrmReservationRepository(tx).add(change.reservation);
      new MikroOrmCapacityEventLog(tx).append(change.event!);
    });

    await until(() => markers.includes('A acquired'));

    // `B` asks for the same program. The marker goes in *before* the call, so the
    // record distinguishes "asked" from "acquired" — which is the whole assertion.
    const second: Promise<Money> = orm.em.fork().transactional(async (tx) => {
      markers.push('B asked');

      const locked = await new MikroOrmProgramRepository(
        tx,
      ).findForCapacityChange(program.id);

      markers.push('B acquired');

      return locked!.reserved;
    });

    await sleep(ENOUGH_TO_BE_WAITING_MS);

    // Taken while `A` still holds the row, which is what makes it a fact about
    // blocking and not about who won a race after the commit.
    expect(markers).toEqual(['A acquired', 'B asked']);

    held.open();
    await first;

    const seenByB = await second;

    expect(markers).toEqual(['A acquired', 'B asked', 'B acquired']);

    // And the figure, which is what the blocking is *for*: `B` decides against the
    // total `A` wrote, not against the pre-image it would have read at the moment
    // it asked.
    expectSameMoney(seenByB, usd(180_000_000n));
    await expectCapacityInvariant(orm, program.id);
  });

  it('lets two different programs change capacity at the same time', async () => {
    // The cost side of the same decision, stated as a test: "reservations against
    // one program serialize; different programs never block each other"
    // (docs/PLAN.md 2.4).
    const northwind = await createProgram(
      aProgram({ id: 'prog-northwind', creditLimit: usd(LIMIT) }),
    );
    const hanseatic = await createProgram(
      aProgram({ id: 'prog-hanseatic', creditLimit: usd(LIMIT) }),
    );

    const markers: string[] = [];
    const held = gate();

    const first = orm.em.fork().transactional(async (tx) => {
      await new MikroOrmProgramRepository(tx).findForCapacityChange(
        northwind.id,
      );
      markers.push('northwind acquired');
      await held.opened;
    });

    await until(() => markers.includes('northwind acquired'));

    const second = orm.em.fork().transactional(async (tx) => {
      const locked = await new MikroOrmProgramRepository(
        tx,
      ).findForCapacityChange(hanseatic.id);

      markers.push('hanseatic acquired');

      return locked!.id;
    });

    // Awaiting this *is* the assertion: it resolves while the transaction holding
    // `prog-northwind` is still open, so the lock cannot have been on anything
    // wider than the one row. A test timeout is the failure mode of a lock that is
    // too broad, which is why this file's timeout is the suite's 60s rather than
    // something clever.
    await expect(second).resolves.toBe(hanseatic.id);
    expect(markers).toEqual(['northwind acquired', 'hanseatic acquired']);

    held.open();
    await first;
  });
});

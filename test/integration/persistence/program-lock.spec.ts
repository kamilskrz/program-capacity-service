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

// The lock actually locks. `findForCapacityChange` promises that no other
// transaction can read the same program for a capacity change until this
// one ends (docs/PLAN.md §2.4) — a missing or ineffective lock isn't an
// error, it's two transactions both deciding there's room and both
// committing, i.e. a sold-past limit. Sequencing is by markers recorded
// while the first transaction still holds the row, never by elapsed time,
// to stay non-flaky. The one timing value below is a deliberately generous
// lower bound (time for a blocked `select for update` to reach the server),
// not a race window — too short fails on "B asked", not flakily.
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

  // Sequences the two transactions by what actually happened, not by promise
  // construction order.
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

    // `A` takes the lock and deliberately does nothing until the test lets it
    // go, giving `B` a window in which it can only be blocked or wrong.
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

    // Marker goes in before the call, so the record distinguishes "asked"
    // from "acquired".
    const second: Promise<Money> = orm.em.fork().transactional(async (tx) => {
      markers.push('B asked');

      const locked = await new MikroOrmProgramRepository(
        tx,
      ).findForCapacityChange(program.id);

      markers.push('B acquired');

      return locked!.reserved;
    });

    await sleep(ENOUGH_TO_BE_WAITING_MS);

    // Taken while `A` still holds the row: a fact about blocking, not a race won after commit.
    expect(markers).toEqual(['A acquired', 'B asked']);

    held.open();
    await first;

    const seenByB = await second;

    expect(markers).toEqual(['A acquired', 'B asked', 'B acquired']);

    // What the blocking is for: `B` decides against the total `A` wrote, not
    // the pre-image it would have read when it asked.
    expectSameMoney(seenByB, usd(180_000_000n));
    await expectCapacityInvariant(orm, program.id);
  });

  it('lets two different programs change capacity at the same time', async () => {
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

    // Awaiting this is the assertion: it resolves while the transaction
    // holding `prog-northwind` is still open. A lock too broad would time out
    // here rather than fail cleanly, hence the suite's ordinary 60s timeout.
    await expect(second).resolves.toBe(hanseatic.id);
    expect(markers).toEqual(['northwind acquired', 'hanseatic acquired']);

    held.open();
    await first;
  });
});

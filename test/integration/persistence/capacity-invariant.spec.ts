import { type MikroORM } from '@mikro-orm/postgresql';

import { expectSameMoney } from '../support/expect-domain';
import {
  BEYOND_SAFE_INTEGER,
  EUR_PER_USD,
  LATER,
  aProgram,
  anAuditContext,
  convertedThrough,
  eur,
  unconverted,
  usd,
} from '../support/factories';
import {
  expectCapacityInvariant,
  readCapacityFigures,
} from '../support/invariant';
import { initTestOrm, resetDatabase } from '../support/orm';
import { execute } from '../support/rows';
import { type Money } from '../../../src/capacity/domain/money';
import { type Program } from '../../../src/capacity/domain/program';
import { MikroOrmCapacityEventLog } from '../../../src/capacity/infrastructure/persistence/mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmReservationRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-reservation.repository';

/**
 * `reserved_amount == SUM(active reservations) == SUM(deltas in capacity_events)`
 * — the invariant docs/PLAN.md 2.4 says is asserted in an integration test.
 *
 * It is here rather than in the repository specs because it is not a property of
 * any one table: each of the three figures is maintained by a different write, and
 * the whole design of the denormalized counter rests on them never disagreeing.
 * Reconciliation reads the same disagreement as `COUNTER_DRIFT` and refuses the
 * snapshot outright (docs/PLAN.md 2.1), so this is also the one invariant whose
 * failure takes a program out of service.
 *
 * Every sequence below runs through separate transactions, the way the service
 * does, so the figures are compared over committed state and not over one unit of
 * work's view of itself.
 */
describe('the capacity invariant', () => {
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

  /** One committed capacity change, exactly as a use case will perform it. */
  async function changeCapacity(
    programId: string,
    change: (
      program: Program,
      reservations: MikroOrmReservationRepository,
      log: MikroOrmCapacityEventLog,
    ) => Promise<void> | void,
  ): Promise<void> {
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      const locked = await new MikroOrmProgramRepository(
        tx,
      ).findForCapacityChange(programId);

      await change(
        locked!,
        new MikroOrmReservationRepository(tx),
        new MikroOrmCapacityEventLog(tx),
      );
    });
  }

  async function createProgram(program: Program): Promise<Program> {
    const em = orm.em.fork();

    // Sync callback: `add` only queues the row into the unit of work, which
    // `em.transactional` flushes and commits on its own. `transactional`'s
    // callback type is `T | Promise<T>`, so a plain (non-async) function is
    // enough and changes nothing about when the write lands.
    await em.transactional((tx) => {
      new MikroOrmProgramRepository(tx).add(program);
    });

    return program;
  }

  async function reserve(
    programId: string,
    invoiceId: string,
    amount: Money,
  ): Promise<void> {
    // Sync callback for the same reason as `createProgram` above: `reserve`,
    // `add` and `append` are all synchronous domain/repository calls.
    await changeCapacity(programId, (program, reservations, log) => {
      const change = program.reserve(
        { invoiceId, amount: unconverted(amount) },
        null,
        anAuditContext(),
      );

      reservations.add(change.reservation);
      log.append(change.event!);
    });
  }

  async function release(programId: string, invoiceId: string): Promise<void> {
    await changeCapacity(programId, async (program, reservations, log) => {
      const existing = await reservations.findForInvoice(programId, invoiceId);
      const change = program.release(
        existing!,
        'REPAID',
        anAuditContext({ occurredAt: LATER }),
      );

      log.append(change.event!);
    });
  }

  it('holds for a program that has done nothing yet', async () => {
    const program = await createProgram(aProgram());

    const figures = await expectCapacityInvariant(orm, program.id);

    expect(figures.counter.isZero()).toBe(true);
  });

  it('holds after a single reservation', async () => {
    const program = await createProgram(aProgram());

    await reserve(program.id, 'inv-0001', usd(1_800_000n));

    const figures = await expectCapacityInvariant(orm, program.id);

    expectSameMoney(figures.counter, usd(1_800_000n));
  });

  it('holds after a reservation is released, with the log summing back down', async () => {
    const program = await createProgram(aProgram());

    await reserve(program.id, 'inv-0001', usd(1_800_000n));
    await release(program.id, 'inv-0001');

    const figures = await expectCapacityInvariant(orm, program.id);

    expect(figures.counter.isZero()).toBe(true);
    // The released hold no longer counts towards the counter, and the two
    // deltas cancel — which is the whole reason `delta` may only ever mean the
    // change to the reserved total (docs/PLAN.md 2.8).
    expect(figures.activeHolds.isZero()).toBe(true);
  });

  it('holds across a mixed lifetime of reservations, releases and a limit change', async () => {
    const program = await createProgram(
      aProgram({ creditLimit: usd(1_000_000_000n) }),
    );

    await reserve(program.id, 'inv-0001', usd(250_000_000n));
    await reserve(program.id, 'inv-0002', usd(120_000_000n));
    await reserve(program.id, 'inv-0003', usd(60_000_000n));
    await release(program.id, 'inv-0002');
    await reserve(program.id, 'inv-0004', usd(40_000_000n));

    // Sync callback: `changeCreditLimit` and `append` are synchronous.
    await changeCapacity(program.id, (locked, _reservations, log) => {
      // A limit change moves no capacity, so its delta is zero and the invariant
      // is unaffected — the assertion below is what proves that.
      const change = locked.changeCreditLimit(
        usd(500_000_000n),
        anAuditContext(),
      );

      log.append(change.event!);
    });

    const figures = await expectCapacityInvariant(orm, program.id);

    expectSameMoney(figures.counter, usd(350_000_000n));
  });

  it('holds after a reconciliation correction, which restates a hold without touching its rate', async () => {
    const program = await createProgram(
      aProgram({ id: 'prog-hanseatic', currency: 'EUR' }),
    );

    // Sync callback: `reserve`, `add` and `append` are synchronous.
    await changeCapacity(program.id, (locked, reservations, log) => {
      const change = locked.reserve(
        {
          invoiceId: 'inv-0002',
          amount: convertedThrough(usd(10_000_000n), EUR_PER_USD),
        },
        null,
        anAuditContext(),
      );

      reservations.add(change.reservation);
      log.append(change.event!);
    });

    await changeCapacity(program.id, async (locked, reservations, log) => {
      const existing = await reservations.findForInvoice(
        program.id,
        'inv-0002',
      );
      const change = locked.correctReservation(
        existing!,
        eur(9_300_000n),
        anAuditContext({
          source: 'TREASURY_SNAPSHOT',
          actor: 'treasury:kafka',
          occurredAt: LATER,
        }),
      );

      log.append(change.event!);
    });

    const figures = await expectCapacityInvariant(orm, program.id);

    expectSameMoney(figures.counter, eur(9_300_000n));
  });

  it('holds while the program is over-utilised, which is a state it has to keep reporting', async () => {
    const program = await createProgram(
      aProgram({ creditLimit: usd(1_000_000_000n) }),
    );

    await reserve(program.id, 'inv-0001', usd(900_000_000n));

    // Sync callback: `changeCreditLimit` and `append` are synchronous.
    await changeCapacity(program.id, (locked, _reservations, log) => {
      const change = locked.changeCreditLimit(
        usd(500_000_000n),
        anAuditContext({
          source: 'TREASURY_SNAPSHOT',
          actor: 'treasury:kafka',
        }),
      );

      log.append(change.event!);
    });

    const figures = await expectCapacityInvariant(orm, program.id);

    expectSameMoney(figures.counter, usd(900_000_000n));

    const loaded = await new MikroOrmProgramRepository(orm.em.fork()).findById(
      program.id,
    );

    expect(loaded!.overUtilized).toBe(true);
    expectSameMoney(loaded!.available, usd(-400_000_000n));
  });

  it('holds at amounts no JS number could add up', async () => {
    const program = await createProgram(
      aProgram({ creditLimit: usd(BEYOND_SAFE_INTEGER * 4n) }),
    );

    await reserve(program.id, 'inv-0001', usd(BEYOND_SAFE_INTEGER));
    await reserve(program.id, 'inv-0002', usd(BEYOND_SAFE_INTEGER));

    const figures = await expectCapacityInvariant(orm, program.id);

    expectSameMoney(figures.counter, usd(BEYOND_SAFE_INTEGER * 2n));
  });

  it('separates programs, so one program’s holds never count towards another', async () => {
    const northwind = await createProgram(aProgram({ id: 'prog-northwind' }));
    const hanseatic = await createProgram(aProgram({ id: 'prog-hanseatic' }));

    await reserve(northwind.id, 'inv-0001', usd(1_000_000n));
    await reserve(hanseatic.id, 'inv-0001', usd(7_000_000n));

    const first = await expectCapacityInvariant(orm, northwind.id);
    const second = await expectCapacityInvariant(orm, hanseatic.id);

    expectSameMoney(first.counter, usd(1_000_000n));
    expectSameMoney(second.counter, usd(7_000_000n));
  });

  it('is what catches a counter somebody moved behind the domain’s back', async () => {
    // The check has to be able to fail, or it is decoration. This is the
    // `COUNTER_DRIFT` state of docs/PLAN.md 2.1 — corruption in this service,
    // which reconciliation refuses to heal silently — staged by the only means
    // that can produce it: a write that did not go through the aggregate.
    const program = await createProgram(aProgram());

    await reserve(program.id, 'inv-0001', usd(1_800_000n));
    await execute(
      orm.em,
      `update "programs" set "reserved_amount" = '2500000' where "id" = ?`,
      [program.id],
    );

    const figures = await readCapacityFigures(orm, program.id);

    expectSameMoney(figures.counter, usd(2_500_000n));
    expectSameMoney(figures.activeHolds, usd(1_800_000n));
    expectSameMoney(figures.deltas!, usd(1_800_000n));
    await expect(expectCapacityInvariant(orm, program.id)).rejects.toThrow();
  });
});

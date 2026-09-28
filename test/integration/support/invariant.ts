import { type MikroORM } from '@mikro-orm/postgresql';

import { selectRow } from './rows';
import { type Money } from '../../../src/capacity/domain/money';
import { MikroOrmCapacityEventLog } from '../../../src/capacity/infrastructure/persistence/mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { moneyFromColumns } from '../../../src/capacity/infrastructure/persistence/money-amount.type';

/**
 * The invariant of docs/PLAN.md 2.4, read off real rows:
 *
 * ```
 * reserved_amount == SUM(active reservations) == SUM(deltas in capacity_events)
 * ```
 *
 * Three figures maintained by three different writes, which is exactly why it is
 * worth asserting: the counter is denormalized so that availability is an O(1)
 * read, the reservations are what it summarises, and the log is what explains it.
 * Any two of them agreeing proves nothing about the third.
 *
 * Kept in `support/` rather than in the one spec that asserts it because cycle 5's
 * concurrency test — 50 parallel reservations against one program, exact success
 * count, invariant intact — is its other caller, and because `sumDeltas` exists on
 * the `CapacityEventLog` port for precisely this reason.
 */

/** The three figures, each read the way the system would read it. */
export interface CapacityFigures {
  /** `programs.reserved_amount`, through the aggregate. */
  readonly counter: Money;
  /** `SUM(reserved_amount - released_amount)` over the program's active holds. */
  readonly activeHolds: Money;
  /** `SUM(delta)` over the program's whole log, or `null` if it has none. */
  readonly deltas: Money | null;
}

/**
 * Reads all three figures for one program, each through its own path and each in
 * its own fresh context — so nothing here can be right only because MikroORM's
 * identity map still held the object that wrote it.
 *
 * @throws {Error} if the program does not exist: an invariant over a program that
 * is not there is a test that would pass by accident.
 */
export async function readCapacityFigures(
  orm: MikroORM,
  programId: string,
): Promise<CapacityFigures> {
  const program = await new MikroOrmProgramRepository(orm.em.fork()).findById(
    programId,
  );

  if (program === null) {
    throw new Error(`no program ${programId} to check the invariant against`);
  }

  // Summed in SQL over the columns, not over loaded aggregates: this is the
  // figure a reviewer would compute by hand, and computing it through the same
  // mapping the counter came through would make the comparison circular.
  const holds = await selectRow<{ held: string | null }>(
    orm.em,
    `select coalesce(sum("reserved_amount" - "released_amount"), 0)::text as held
       from "reservations"
      where "program_id" = ? and "status" = 'ACTIVE'`,
    [programId],
  );

  const deltas = await new MikroOrmCapacityEventLog(orm.em.fork()).sumDeltas(
    programId,
  );

  return {
    counter: program.reserved,
    activeHolds: moneyFromColumns(BigInt(holds?.held ?? '0'), program.currency),
    deltas,
  };
}

/**
 * Asserts the invariant for one program.
 *
 * Compared through `Money.toString()` so a failure names the three figures in the
 * program's currency rather than reporting `false`.
 */
export async function expectCapacityInvariant(
  orm: MikroORM,
  programId: string,
): Promise<CapacityFigures> {
  const figures = await readCapacityFigures(orm, programId);

  expect(figures.activeHolds.toString()).toBe(figures.counter.toString());

  if (figures.deltas === null) {
    // A program that has recorded no events has held nothing: a sum of nothing
    // has no currency, which is why the port answers `null` rather than a
    // guessed zero, and the invariant is then that the counter is zero too.
    expect(figures.counter.isZero()).toBe(true);

    return figures;
  }

  expect(figures.deltas.toString()).toBe(figures.counter.toString());

  return figures;
}

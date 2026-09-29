import { type MikroORM } from '@mikro-orm/postgresql';

import { selectRow } from './rows';
import { type Money } from '../../../src/capacity/domain/money';
import { MikroOrmCapacityEventLog } from '../../../src/capacity/infrastructure/persistence/mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { moneyFromColumns } from '../../../src/capacity/infrastructure/persistence/money-amount.type';

// The invariant of docs/PLAN.md §2.4, read off real rows:
//   reserved_amount == SUM(active reservations) == SUM(deltas in capacity_events)

/** The three figures, each read the way the system would read it. */
export interface CapacityFigures {
  /** `programs.reserved_amount`, through the aggregate. */
  readonly counter: Money;
  /** `SUM(reserved_amount - released_amount)` over the program's active holds. */
  readonly activeHolds: Money;
  /** `SUM(delta)` over the program's whole log, or `null` if it has none. */
  readonly deltas: Money | null;
}

// Reads all three figures through their own path and a fresh fork each, so
// nothing here is right only because the identity map still held the object
// that wrote it.
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

  // Summed in SQL over the columns, not over loaded aggregates, so this isn't
  // circular with the counter it's compared against.
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

/** Asserts the invariant for one program. */
export async function expectCapacityInvariant(
  orm: MikroORM,
  programId: string,
): Promise<CapacityFigures> {
  const figures = await readCapacityFigures(orm, programId);

  expect(figures.activeHolds.toString()).toBe(figures.counter.toString());

  if (figures.deltas === null) {
    // No events recorded means nothing was ever held; the counter must be zero.
    expect(figures.counter.isZero()).toBe(true);

    return figures;
  }

  expect(figures.deltas.toString()).toBe(figures.counter.toString());

  return figures;
}

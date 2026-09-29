import { type MikroORM } from '@mikro-orm/postgresql';

import {
  SEED_PROGRAMS,
  SEED_RATE_AS_OF,
  SEED_RATE_SOURCE,
  SEED_RATES,
  seedDatabase,
} from '../../../src/capacity/infrastructure/persistence/seed';
import { Money } from '../../../src/capacity/domain/money';
import { FxRate } from '../../../src/fx/fx-rate';
import { initTestOrm, resetDatabase } from '../support/orm';
import { countRows, execute, selectRow } from '../support/rows';

// The seed a fresh clone comes up with (docs/PLAN.md §2.9). Asserted against
// the raw row, not through the repositories, so a seed failure and a
// repository-read failure can't report as the same red test. `SEED_PROGRAMS`
// and `SEED_RATES` are read directly rather than restated as literals.
describe('the seed', () => {
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

  /** Runs the seed exactly as `seed.cli.ts` does: one transaction, one call. */
  async function runSeed() {
    const em = orm.em.fork();

    return em.transactional((tx) => seedDatabase(tx));
  }

  interface ProgramRow {
    id: string;
    currency: string;
    credit_limit: string;
    reserved_amount: string;
  }

  async function loadProgramRows(): Promise<ProgramRow[]> {
    return execute<ProgramRow[]>(
      orm.em,
      `select "id", "currency", "credit_limit", "reserved_amount" from "programs" order by "id"`,
    );
  }

  it('creates exactly the programs it declares, with the declared currency and credit limit', async () => {
    await runSeed();

    const rows = await loadProgramRows();

    expect(rows.map((row) => row.id).sort()).toEqual(
      [...SEED_PROGRAMS].map((program) => program.id).sort(),
    );

    for (const program of SEED_PROGRAMS) {
      const row = rows.find((candidate) => candidate.id === program.id);
      const expectedLimit = Money.fromDecimalString(
        program.creditLimit,
        program.currency,
      );

      expect(row?.currency).toBe(program.currency);
      expect(BigInt(row!.credit_limit)).toBe(expectedLimit.minorUnits);
    }
  });

  it('includes at least one program outside USD and one close enough to exhaustion that the next reservation is refused (docs/PLAN.md 2.9)', async () => {
    await runSeed();

    const rows = await loadProgramRows();

    expect(rows.some((row) => row.currency !== 'USD')).toBe(true);

    const ratios = rows.map((row) => {
      const limit = BigInt(row.credit_limit);
      const reserved = BigInt(row.reserved_amount);
      const available = limit - reserved;

      // Must still be positive, or there's nothing left to show succeeding.
      expect(available > 0n).toBe(true);

      return Number(available) / Number(limit);
    });

    // A fraction of its own limit, not an absolute figure, so this doesn't
    // depend on which program or scale the seed picks.
    expect(Math.min(...ratios)).toBeLessThan(0.01);
  });

  it('seeds every reservation from SEED_PROGRAMS, so the counter is never written directly (docs/PLAN.md 2.4)', async () => {
    await runSeed();

    for (const program of SEED_PROGRAMS) {
      const count = await selectRow<{ count: string }>(
        orm.em,
        `select count(*) as count from "reservations" where "program_id" = ?`,
        [program.id],
      );

      expect(Number(count?.count)).toBe(program.holds.length);
    }

    const rows = await loadProgramRows();

    for (const row of rows) {
      const held = await selectRow<{ held: string | null }>(
        orm.em,
        `select coalesce(sum("reserved_amount" - "released_amount"), 0)::text as held
           from "reservations" where "program_id" = ? and "status" = 'ACTIVE'`,
        [row.id],
      );

      expect(BigInt(held?.held ?? '0')).toBe(BigInt(row.reserved_amount));
    }
  });

  it('seeds both directions of every pair a foreign-currency hold needs, and never an inverted quote (docs/PLAN.md 2.3)', async () => {
    await runSeed();

    const rows = await execute<
      { base: string; quote: string; scaled_value: string; scale: number }[]
    >(
      orm.em,
      `select "base", "quote", "scaled_value", "scale" from "fx_rates" order by "base", "quote"`,
    );

    expect(rows).toHaveLength(SEED_RATES.length);

    for (const rate of SEED_RATES) {
      const expected = FxRate.fromDecimalString({
        base: rate.base,
        quote: rate.quote,
        value: rate.value,
        source: SEED_RATE_SOURCE,
        asOf: SEED_RATE_AS_OF,
      });
      const row = rows.find(
        (candidate) =>
          candidate.base === rate.base && candidate.quote === rate.quote,
      );

      expect(row).toBeDefined();
      expect(BigInt(row!.scaled_value)).toBe(expected.scaledValue);
      expect(row!.scale).toBe(FxRate.SCALE_EXPONENT);
    }

    // Confirms the two rows are independent, not one derived from the other
    // by inversion.
    const pairs = new Map(
      SEED_RATES.map((rate) => [`${rate.base}/${rate.quote}`, rate.value]),
    );

    for (const rate of SEED_RATES) {
      const reverse = pairs.get(`${rate.quote}/${rate.base}`);

      if (reverse !== undefined) {
        const forward = Number(rate.value);
        const back = Number(reverse);

        // A real spread, not an exact inversion (which would be ~1e-15 from 1).
        expect(Math.abs(forward * back - 1)).toBeGreaterThan(1e-6);
      }
    }
  });

  it('is idempotent: a second run touches no existing program or reservation, and only restates the rates', async () => {
    const first = await runSeed();

    expect([...first.programsInserted].sort()).toEqual(
      SEED_PROGRAMS.map((program) => program.id).sort(),
    );
    expect(first.programsLeftAlone).toHaveLength(0);
    expect(first.ratesUpserted).toBe(SEED_RATES.length);

    const beforeProgramRows = await loadProgramRows();
    const beforeReservationCount = await countRows(orm.em, 'reservations');
    const beforeFxCount = await countRows(orm.em, 'fx_rates');

    const second = await runSeed();

    expect(second.programsInserted).toHaveLength(0);
    expect([...second.programsLeftAlone].sort()).toEqual(
      SEED_PROGRAMS.map((program) => program.id).sort(),
    );
    expect(second.reservationsInserted).toBe(0);
    expect(second.ratesUpserted).toBe(SEED_RATES.length);

    const afterProgramRows = await loadProgramRows();
    const afterReservationCount = await countRows(orm.em, 'reservations');
    const afterFxCount = await countRows(orm.em, 'fx_rates');

    // A developer's reserving and releasing against a seeded program must
    // survive a restart untouched.
    expect(afterProgramRows).toEqual(beforeProgramRows);
    expect(afterReservationCount).toBe(beforeReservationCount);
    expect(afterFxCount).toBe(beforeFxCount);
  });
});

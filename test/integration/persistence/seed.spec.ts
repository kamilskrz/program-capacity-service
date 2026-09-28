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

/**
 * The seed a fresh clone comes up with (docs/PLAN.md 2.9, 2.10) — what a demo,
 * `requests.http` and a reviewer all depend on being there without anyone
 * setting it up by hand.
 *
 * Asserted against the row, not through the repositories: whether `seedDatabase`
 * did its job is a fact about what landed in the tables, and tying it to
 * `MikroOrmProgramRepository`/`MikroOrmReservationRepository` as well would mean
 * a seed failure and a repository-read failure report as the same red test.
 * `SEED_PROGRAMS` and `SEED_RATES` are read directly rather than restated as
 * literals here, so this file keeps testing "does the seed write what it
 * declares" even if the declared data changes.
 */
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

      // Both must hold for the boundary to be demonstrable from either side
      // (docs/PLAN.md 2.9): something must still fit, or there is nothing left
      // to show succeeding, and it must be close, or "near exhaustion" is not
      // actually near.
      expect(available > 0n).toBe(true);

      return Number(available) / Number(limit);
    });

    // Read as a fraction of its own limit, not an absolute figure, so this
    // does not depend on which program the seed happens to pick or at what
    // scale. One percent of headroom is "the next real invoice will not fit."
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

    // The invariant docs/PLAN.md 2.4 states — reserved_amount == SUM(active
    // reservations) — read directly off the rows the seed wrote, so a seed
    // that wrote a plausible-looking counter without going through the
    // aggregate fails here rather than only in cycle 5's dedicated test.
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

    // "Both directions" only means something if the two rows are independent:
    // a base/quote pair whose reverse row is the exact inverse would pass every
    // test that divides by a rate instead of looking up its own direction.
    const pairs = new Map(
      SEED_RATES.map((rate) => [`${rate.base}/${rate.quote}`, rate.value]),
    );

    for (const rate of SEED_RATES) {
      const reverse = pairs.get(`${rate.quote}/${rate.base}`);

      if (reverse !== undefined) {
        const forward = Number(rate.value);
        const back = Number(reverse);

        // A real spread (0.9235 against 1.0828 is off by ~3.4e-5), not an
        // exact inversion, which would land within floating-point noise
        // (~1e-15) of 1 instead.
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
    // Rates are reference data with a natural key: re-running restates them
    // rather than skipping them, which is the point of "upserted."
    expect(second.ratesUpserted).toBe(SEED_RATES.length);

    const afterProgramRows = await loadProgramRows();
    const afterReservationCount = await countRows(orm.em, 'reservations');
    const afterFxCount = await countRows(orm.em, 'fx_rates');

    // Not restated, not reset: a developer's ten minutes of reserving and
    // releasing against a seeded program must survive a restart untouched.
    expect(afterProgramRows).toEqual(beforeProgramRows);
    expect(afterReservationCount).toBe(beforeReservationCount);
    expect(afterFxCount).toBe(beforeFxCount);
  });
});

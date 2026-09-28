import { MikroORM } from '@mikro-orm/postgresql';

import { databaseUrl } from './postgres-container';
import { buildOrmOptions } from '../../../src/shared/database/mikro-orm.options';

/**
 * The migrations table, which is not an entity and must survive truncation: the
 * schema is created once per run and every test relies on it still being there.
 */
const MIGRATIONS_TABLE = 'mikro_orm_migrations';

/**
 * Opens a MikroORM instance against the run's container, with **the production
 * options**.
 *
 * `buildOrmOptions` is the same function the Nest application and the MikroORM CLI
 * call, so the suite exercises the real naming strategy, the real `forceUtcTimezone`
 * and the real {@link DomainHydrator}. An integration test that configured its own
 * ORM would be testing a second mapping that nothing deploys.
 *
 * `debug: false`, because a passing run should be readable; a spec that needs the
 * SQL can set it per test with `orm.config.set('debug', true)`.
 */
export async function initTestOrm(): Promise<MikroORM> {
  return MikroORM.init(
    buildOrmOptions({ databaseUrl: databaseUrl(), debug: false }),
  );
}

/**
 * Every table the mappings own, in an order that is safe to truncate.
 *
 * Read from the ORM's metadata rather than listed by hand, so a table added in a
 * later cycle cannot be forgotten here — a forgotten table is a test that passes
 * because of rows another test left behind.
 */
export function mappedTables(orm: MikroORM): string[] {
  return Object.values(orm.getMetadata().getAll())
    .filter((meta) => !meta.embeddable && !meta.virtual)
    .map((meta) => meta.tableName)
    .filter((table) => table !== MIGRATIONS_TABLE);
}

/**
 * Empties every mapped table and clears the identity map.
 *
 * # Decision: truncation between tests, not a transaction per test
 *
 * The three candidates were a transaction rolled back after each test, a schema per
 * worker, and this.
 *
 * **A transaction per test is ruled out by the work it would have to support.**
 * Cycle 5's central test runs 50 concurrent reservations against one program and
 * asserts the exact number that succeed with the counter intact (docs/PLAN.md 2.4,
 * 2.10). Fifty transactions contending for one row lock cannot happen *inside* one
 * transaction: they would all share it, `SELECT … FOR UPDATE` would be
 * uncontended, and the test would prove the opposite of what it claims. The same
 * applies to anything that tests a commit — the audit row written in the same
 * transaction as the change, a unique-constraint violation surfacing at `flush()`,
 * a transaction rolled back leaving the counter untouched. Rollback isolation is
 * fast precisely because it never commits, which is the one thing this service's
 * hard part depends on.
 *
 * **A schema per worker solves a problem this suite does not have.** Integration
 * tests run with `--runInBand` (see `jest.integration.config.js`), because shared
 * containers plus concurrency assertions need a predictable database, so there is
 * one worker and a per-worker schema would be a per-run schema with extra
 * migration cost.
 *
 * **Truncation, then.** `TRUNCATE … RESTART IDENTITY CASCADE` in one statement over
 * all mapped tables: one round trip, no ordering problem with the foreign keys, and
 * `capacity_events.id` restarting at 1 so a test can assert on a cursor without
 * depending on how many events earlier tests wrote. It is also the strategy
 * docs/PLAN.md 2.10 records, and the only one that leaves every test looking at real
 * committed state.
 *
 * What truncation alone does **not** clear is MikroORM's identity map: it would
 * otherwise hand the next test the entity objects of the previous one, complete
 * with the rows that no longer exist. Each test therefore works through its own
 * `orm.em.fork()` — which is what docs/PLAN.md 2.6 requires of production code too,
 * every capacity-changing operation starting from a fresh fork — rather than this
 * function reaching into the global context, which MikroORM rightly refuses
 * (`allowGlobalContext`).
 *
 * The cost is that tests may not run in parallel against one database. That is
 * already true for the concurrency tests, and stating it once here is cheaper than
 * a suite that is flaky only on CI.
 */
export async function resetDatabase(orm: MikroORM): Promise<void> {
  const tables = mappedTables(orm)
    .map((table) => `"${table}"`)
    .join(', ');

  await orm.em
    .getConnection()
    .execute(`truncate table ${tables} restart identity cascade`);
}

import { type MikroORM } from '@mikro-orm/postgresql';

/**
 * Every statement MikroORM issued while a block of work ran.
 *
 * # Why through `onQuery` and not through a second ORM
 *
 * `support/orm.ts` opens the ORM with `debug: false` so that a passing run is
 * readable, and records that a spec needing the SQL sets it per test. The obvious
 * reading of that is `orm.config.set('debug', true)` plus a `logger` writer — but
 * the writer is captured by `DefaultLogger` when the `Configuration` is built, so
 * setting `logger` on a live instance changes nothing, and building a *second* ORM
 * with a capturing logger would be a second mapping that nothing deploys (the very
 * thing `initTestOrm` exists to avoid).
 *
 * `onQuery` is read back off the configuration on **every** statement
 * (`AbstractSqlConnection.execute`), which is the one funnel every select, insert,
 * update and delete passes through, so overriding it on the live instance works and
 * covers exactly what a write-amplification test has to see. It is MikroORM's own
 * documented hook rather than infrastructure invented here.
 *
 * `begin`, `commit` and `rollback` do **not** pass through it — they are logged
 * directly — which is a feature here: what the caller gets is the data statements
 * and nothing else.
 */
export type OnQuery = (sql: string, params: unknown[]) => string;

/**
 * Runs `work` with every statement recorded, and restores the previous hook
 * afterwards.
 *
 * Restored in a `finally` rather than after the call, so a failing assertion inside
 * `work` cannot leave the rest of the run capturing into a dead array — which would
 * surface as a leak in an unrelated spec file rather than as this test failing.
 */
export async function captureSql<T>(
  orm: MikroORM,
  work: () => Promise<T>,
): Promise<{ statements: string[]; result: T }> {
  const statements: string[] = [];
  const previous = orm.config.get('onQuery');

  orm.config.set('onQuery', (sql: string, params: unknown[]): string => {
    statements.push(sql);

    return previous(sql, params);
  });

  try {
    const result = await work();

    return { statements, result };
  } finally {
    orm.config.set('onQuery', previous);
  }
}

/**
 * The statements that would change a row: `insert`, `update` and `delete`.
 *
 * Matched on the leading keyword after normalising whitespace, so a `select … from
 * "reservations" where …` that merely contains the word `update` (as `for update`
 * does) is not counted. `for update` is precisely the statement a locking read
 * issues, so getting this wrong would make the write-amplification assertion fail
 * on the one read the service most depends on.
 */
export function writeStatements(statements: readonly string[]): string[] {
  return statements.filter((sql) =>
    /^\s*(insert|update|delete)\b/i.test(sql.replace(/^[\s(]+/, '')),
  );
}

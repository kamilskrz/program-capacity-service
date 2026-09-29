import { type MikroORM } from '@mikro-orm/postgresql';

// Every statement MikroORM issued while a block of work ran, captured via
// `onQuery` (the one funnel every statement passes through) rather than a
// second ORM instance with its own logger, which would be a second mapping
// nothing deploys. `begin`/`commit`/`rollback` don't pass through it.
export type OnQuery = (sql: string, params: unknown[]) => string;

// Runs `work` with every statement recorded, restoring the previous hook in a
// `finally` so a failing assertion can't leave capture leaking into another spec.
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

// Matches the leading keyword only, so a `select … for update` isn't counted
// as an update — that locking read is what the write-amplification assertion
// must not penalize.
export function writeStatements(statements: readonly string[]): string[] {
  return statements.filter((sql) =>
    /^\s*(insert|update|delete)\b/i.test(sql.replace(/^[\s(]+/, '')),
  );
}

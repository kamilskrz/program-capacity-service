import { MikroORM } from '@mikro-orm/postgresql';

import { databaseUrl } from './postgres-container';
import { buildOrmOptions } from '../../../src/shared/database/mikro-orm.options';

// Not an entity; must survive truncation between tests.
const MIGRATIONS_TABLE = 'mikro_orm_migrations';

// Same options the app and CLI use, so the suite exercises the real mapping.
export async function initTestOrm(): Promise<MikroORM> {
  return MikroORM.init(
    buildOrmOptions({ databaseUrl: databaseUrl(), debug: false }),
  );
}

// Read from ORM metadata rather than listed by hand, so a new mapping can't be
// forgotten here.
export function mappedTables(orm: MikroORM): string[] {
  return Object.values(orm.getMetadata().getAll())
    .filter((meta) => !meta.embeddable && !meta.virtual)
    .map((meta) => meta.tableName)
    .filter((table) => table !== MIGRATIONS_TABLE);
}

// Isolation between tests: TRUNCATE rather than a rolled-back transaction,
// because the concurrency tests need real contention and commits (docs/PLAN.md
// §2.10). Each test still forks its own EntityManager (see callers), since
// truncation alone doesn't clear MikroORM's identity map.
export async function resetDatabase(orm: MikroORM): Promise<void> {
  const tables = mappedTables(orm)
    .map((table) => `"${table}"`)
    .join(', ');

  await orm.em
    .getConnection()
    .execute(`truncate table ${tables} restart identity cascade`);
}

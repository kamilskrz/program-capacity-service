import { MikroORM } from '@mikro-orm/postgresql';

import { startPostgres } from './support/postgres-container';
import { buildOrmOptions } from '../../src/shared/database/mikro-orm.options';

// Brings up Postgres once per run and applies the migrations the same way a
// deployment would (`getMigrator().up()`, never `schema:create`/`schema:update`
// — docs/PLAN.md §2.6), so a broken migration fails here rather than as
// unexplained failures across the whole suite.
export default async function globalSetup(): Promise<void> {
  await startPostgres();

  const orm = await MikroORM.init(
    buildOrmOptions({
      // Read back from the environment, not the local variable, so this file
      // proves the same handoff the spec files rely on.
      databaseUrl: process.env.DATABASE_URL ?? '',
      debug: false,
    }),
  );

  try {
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }
}

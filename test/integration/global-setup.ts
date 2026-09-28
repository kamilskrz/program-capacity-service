import { MikroORM } from '@mikro-orm/postgresql';

import { startPostgres } from './support/postgres-container';
import { buildOrmOptions } from '../../src/shared/database/mikro-orm.options';

/**
 * Brings up the infrastructure the integration suite needs, once per run
 * (docs/PLAN.md 2.10).
 *
 * Two steps, and the second is the interesting one:
 *
 * 1. start Postgres in a container. First run pulls the image; the plan's own risk
 *    list says to pull it in the background early (docs/PLAN.md 4).
 * 2. **apply the migrations, exactly as a deployment would.** `getMigrator().up()`
 *    is the same code path as `npm run migration:up` and as the one-shot `migrate`
 *    container in `docker-compose.yml`. Nothing in this suite ever calls
 *    `schema:create` or `schema:update` (docs/PLAN.md 2.6), which is what makes
 *    "the migration applies to an empty database" a fact the whole suite depends
 *    on rather than a claim one test makes: if the migration is broken, the run
 *    fails here, before a single assertion.
 *
 * Redpanda joins this file in cycle 7, started the same way and beside Postgres, so
 * the broker is also paid for once per run.
 */
export default async function globalSetup(): Promise<void> {
  await startPostgres();

  const orm = await MikroORM.init(
    buildOrmOptions({
      // Read back from the environment rather than passed along, so this file
      // proves the handoff the spec files rely on actually works.
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

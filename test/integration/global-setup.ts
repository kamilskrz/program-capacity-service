import { MikroORM } from '@mikro-orm/postgresql';

import { startPostgres } from './support/postgres-container';
import { startRedpanda } from './support/redpanda-container';
import { buildOrmOptions } from '../../src/shared/database/mikro-orm.options';

// How the started broker's address reaches the spec files — the same env var
// `AppConfigService`/`Env` already read (`KAFKA_BROKERS`), so a test that
// wires the real config service needs no separate knob.
export const KAFKA_BROKERS_ENV = 'KAFKA_BROKERS';

// Brings up Postgres once per run and applies the migrations the same way a
// deployment would (`getMigrator().up()`, never `schema:create`/`schema:update`
// — docs/PLAN.md §2.6), so a broken migration fails here rather than as
// unexplained failures across the whole suite.
export default async function globalSetup(): Promise<void> {
  await startPostgres();

  const redpanda = await startRedpanda();

  process.env[KAFKA_BROKERS_ENV] = redpanda.getBootstrapServers();

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

// Throws with an explanation rather than failing on a missing broker — the
// usual cause is running a spec file without the project's globalSetup.
// Kept here, not in `support/redpanda-container.ts`, so this is the only
// other file (besides `postgres-container.ts`) that reads `process.env` for
// the integration harness.
export function kafkaBrokers(): string {
  const brokers = process.env[KAFKA_BROKERS_ENV];

  if (brokers === undefined || brokers === '') {
    throw new Error(
      `${KAFKA_BROKERS_ENV} is not set: the integration harness did not run. Use "npm run test:integration", which loads jest.integration.config.js and its globalSetup.`,
    );
  }

  return brokers;
}

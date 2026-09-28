import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

/**
 * The image the suite runs against.
 *
 * Pinned to the same tag as `docker-compose.yml`, so the tests, the local stack
 * and CI all exercise one Postgres version. A test suite that passes on a
 * different major version than production runs is a test suite that can be green
 * while the migration it just applied is invalid.
 */
export const POSTGRES_IMAGE = 'postgres:16-alpine';

/**
 * Where the started container's connection string is handed to the test files.
 *
 * `globalSetup` runs in its own module registry, so it cannot simply export a
 * value to the specs. An environment variable is how Jest propagates anything to
 * its workers — they inherit `process.env` when they are forked, and with
 * `--runInBand` there is only the one process — and it is also what a Nest
 * application booted by a later cycle's e2e test will read.
 */
export const DATABASE_URL_ENV = 'DATABASE_URL';

/** Where `globalSetup` leaves the container for `globalTeardown` to stop. */
const CONTAINER_KEY = '__capacityPostgresContainer__';

interface ContainerRegistry {
  [CONTAINER_KEY]?: StartedPostgreSqlContainer;
}

/**
 * Starts one Postgres container for the whole run and publishes its URL.
 *
 * **Once per run, in `globalSetup`** (docs/PLAN.md 2.10). A container per test
 * file would pay the start-up cost per file for no isolation the truncation
 * strategy does not already give, and a container per test would make the suite
 * unusable. The consequence — every file shares one database — is what
 * `resetDatabase` exists to handle.
 *
 * The credentials are fixed rather than random: they appear in failure output and
 * in the URL a developer copies to inspect the database while a test is paused,
 * and there is nothing to protect in a container that lives for one test run.
 *
 * No `withReuse()`. A reused container keeps whatever state the last run left,
 * which is exactly the kind of hidden coupling an integration suite exists to
 * rule out; the few seconds it saves are not worth a test that only passes second.
 */
export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('capacity')
    .withUsername('capacity')
    .withPassword('capacity')
    .start();

  (globalThis as ContainerRegistry)[CONTAINER_KEY] = container;
  process.env[DATABASE_URL_ENV] = container.getConnectionUri();

  return container;
}

/**
 * Stops the container started by {@link startPostgres}, if there is one.
 *
 * Tolerates its absence: a `globalSetup` that failed half-way still runs
 * `globalTeardown`, and an error here would replace the real failure with a
 * misleading one.
 */
export async function stopPostgres(): Promise<void> {
  const registry = globalThis as ContainerRegistry;
  const container = registry[CONTAINER_KEY];

  delete registry[CONTAINER_KEY];

  await container?.stop();
}

/**
 * The connection string of the running container.
 *
 * @throws {Error} if the harness has not run. Thrown with an explanation rather
 * than letting a spec fail on a malformed URL: the usual cause is running a spec
 * file directly, without the project's `globalSetup`.
 */
export function databaseUrl(): string {
  const url = process.env[DATABASE_URL_ENV];

  if (url === undefined || url === '') {
    throw new Error(
      `${DATABASE_URL_ENV} is not set: the integration harness did not run. Use "npm run test:integration", which loads jest.integration.config.js and its globalSetup.`,
    );
  }

  return url;
}

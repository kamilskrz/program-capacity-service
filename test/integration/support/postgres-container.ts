import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

// Pinned to the same tag as docker-compose.yml, so tests, local stack and CI
// all run one Postgres version.
export const POSTGRES_IMAGE = 'postgres:16-alpine';

// How the started container's URL reaches the spec files: `globalSetup` runs
// in its own module registry, so an env var is the only propagation Jest gives.
export const DATABASE_URL_ENV = 'DATABASE_URL';

/** Where `globalSetup` leaves the container for `globalTeardown` to stop. */
const CONTAINER_KEY = '__capacityPostgresContainer__';

interface ContainerRegistry {
  [CONTAINER_KEY]?: StartedPostgreSqlContainer;
}

// One container for the whole run, started in `globalSetup` (docs/PLAN.md
// §2.10) — a container per file or per test would make the suite unusable.
// Credentials are fixed on purpose: there's nothing to protect in a container
// that lives for one run, and fixed values are easier to copy into a debugger.
// No `withReuse()`: a reused container keeps state from the last run, which is
// exactly the hidden coupling this suite exists to rule out.
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

// Tolerates a missing container: a `globalSetup` that failed halfway still
// runs `globalTeardown`, and an error here would hide the real failure.
export async function stopPostgres(): Promise<void> {
  const registry = globalThis as ContainerRegistry;
  const container = registry[CONTAINER_KEY];

  delete registry[CONTAINER_KEY];

  await container?.stop();
}

// Throws with an explanation rather than failing on a malformed URL — the
// usual cause is running a spec file without the project's globalSetup.
export function databaseUrl(): string {
  const url = process.env[DATABASE_URL_ENV];

  if (url === undefined || url === '') {
    throw new Error(
      `${DATABASE_URL_ENV} is not set: the integration harness did not run. Use "npm run test:integration", which loads jest.integration.config.js and its globalSetup.`,
    );
  }

  return url;
}

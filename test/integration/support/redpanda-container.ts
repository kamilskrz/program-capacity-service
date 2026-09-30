import {
  RedpandaContainer,
  type StartedRedpandaContainer,
} from '@testcontainers/redpanda';

// Pinned to the same tag as docker-compose.yml, so tests, local stack and CI
// all run one Redpanda version.
export const REDPANDA_IMAGE = 'redpandadata/redpanda:v25.3.17';

/** Where `globalSetup` leaves the container for `globalTeardown` to stop. */
const CONTAINER_KEY = '__treasuryRedpandaContainer__';

interface ContainerRegistry {
  [CONTAINER_KEY]?: StartedRedpandaContainer;
}

// One container for the whole run, started in `globalSetup` alongside
// Postgres (docs/PLAN.md §2.2, §2.10) — the broker address it exposes is
// published to `process.env` by `globalSetup` itself, not here, so every
// `process.env` access for the integration harness stays in the same two
// files ESLint already exempts.
export async function startRedpanda(): Promise<StartedRedpandaContainer> {
  const container = await new RedpandaContainer(REDPANDA_IMAGE).start();

  (globalThis as ContainerRegistry)[CONTAINER_KEY] = container;

  return container;
}

// Tolerates a missing container, the same reason `stopPostgres` does.
export async function stopRedpanda(): Promise<void> {
  const registry = globalThis as ContainerRegistry;
  const container = registry[CONTAINER_KEY];

  delete registry[CONTAINER_KEY];

  await container?.stop();
}

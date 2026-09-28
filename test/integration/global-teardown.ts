import { stopPostgres } from './support/postgres-container';

/**
 * Stops the run's containers.
 *
 * Testcontainers' Ryuk sidecar would eventually reap them anyway, which is the
 * safety net for a process killed mid-run; stopping them here is what keeps a
 * developer's Docker clean between runs and what makes the suite's resource
 * footprint bounded on CI.
 */
export default async function globalTeardown(): Promise<void> {
  await stopPostgres();
}

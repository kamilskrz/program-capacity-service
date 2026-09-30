import { stopPostgres } from './support/postgres-container';
import { stopRedpanda } from './support/redpanda-container';

// Stops the run's containers, so Docker stays clean between runs; Ryuk would
// eventually reap them anyway if the process is killed mid-run.
export default async function globalTeardown(): Promise<void> {
  await stopPostgres();
  await stopRedpanda();
}

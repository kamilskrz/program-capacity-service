import { MikroORM } from '@mikro-orm/postgresql';

import { seedDatabase } from './seed';
import { loadSeedEnv } from '../../../shared/config/env.schema';
import { buildOrmOptions } from '../../../shared/database/mikro-orm.options';

/**
 * The hosts a `DATABASE_URL` may point at without being told: loopback, or the
 * compose service name.
 */
const LOCAL_HOSTS = ['localhost', '::1', 'postgres'];

/** The host of a connection string, or `null` if it is not one that parses. */
function hostOf(databaseUrl: string): string | null {
  try {
    return new URL(databaseUrl).hostname.replace(/^\[|]$/g, '');
  } catch {
    return null;
  }
}

/**
 * Whether this database may be seeded (docs/PLAN.md 2.9): an explicit `SEED_ALLOW=1`,
 * or a host that is a local database by construction.
 */
function mayBeSeeded(
  host: string | null,
  seedAllow: string | undefined,
): boolean {
  if (seedAllow === '1') {
    return true;
  }

  return (
    host !== null && (LOCAL_HOSTS.includes(host) || host.startsWith('127.'))
  );
}

/**
 * `npm run seed` — the entry point the local stack and a developer share.
 *
 * Runs outside the Nest container, like the MikroORM CLI, so it validates the
 * environment on its own with the database slice of the same schema: a seed job has
 * no business holding the JWT secret or the broker list. The production image cannot
 * run it at all — `ts-node` is a devDependency and the runtime stage ships no `src/`
 * — which is why `docker-compose.yml` runs the migrations and nothing else.
 *
 * Everything happens in one transaction, so a failure half-way leaves the database as
 * it was. Exits non-zero with the error on stderr.
 */
async function main(): Promise<void> {
  const env = loadSeedEnv();
  const host = hostOf(env.DATABASE_URL);

  // Refused before anything connects: the seed writes `capacity_events` rows and
  // that table refuses `DELETE`, so seeding the wrong database cannot be undone.
  if (!mayBeSeeded(host, env.SEED_ALLOW)) {
    throw new Error(
      `refusing to seed the database at ${host ?? env.DATABASE_URL}: it is neither a loopback address nor the compose service name, and the seed writes capacity_events rows that cannot be removed afterwards (the trigger refuses DELETE), so a real program would carry actor = "seed" entries in its audit log for ever. If this database really may be seeded, run the command again with SEED_ALLOW=1. This is a guard against a mistake and not a security control.`,
    );
  }

  const orm = await MikroORM.init(
    buildOrmOptions({
      databaseUrl: env.DATABASE_URL,
      debug: env.NODE_ENV === 'development',
    }),
  );

  try {
    const outcome = await orm.em.transactional((em) => seedDatabase(em));

    // `console` rather than a logger: nothing here runs inside the application.
    console.log(
      `seed: inserted ${outcome.programsInserted.length} program(s) [${outcome.programsInserted.join(', ')}], left ${outcome.programsLeftAlone.length} alone, ${outcome.reservationsInserted} reservation(s), ${outcome.ratesUpserted} rate(s)`,
    );
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

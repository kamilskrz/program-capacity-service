import { MikroORM } from '@mikro-orm/postgresql';

import { seedDatabase } from './seed';
import { loadSeedEnv } from '../../../shared/config/env.schema';
import { buildOrmOptions } from '../../../shared/database/mikro-orm.options';

/** Hosts a `DATABASE_URL` may point at without being told: loopback, or the compose service name. */
const LOCAL_HOSTS = ['localhost', '::1', 'postgres'];

/** The host of a connection string, or `null` if it does not parse. */
function hostOf(databaseUrl: string): string | null {
  try {
    return new URL(databaseUrl).hostname.replace(/^\[|]$/g, '');
  } catch {
    return null;
  }
}

/** Whether this database may be seeded: an explicit `SEED_ALLOW=1`, or a host that is local by construction. */
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

/** `npm run seed`. Runs in one transaction; exits non-zero with the error on stderr. */
async function main(): Promise<void> {
  const env = loadSeedEnv();
  const host = hostOf(env.DATABASE_URL);

  // Guarded because `capacity_events` refuses DELETE: seeding the wrong
  // database cannot be undone (docs/PLAN.md 2.9).
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

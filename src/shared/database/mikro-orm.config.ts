import { loadDatabaseEnv } from '../config/env.schema';
import { buildOrmOptions } from './mikro-orm.options';

/**
 * Entry point for the MikroORM CLI (`npm run migration:create`, `migration:up`).
 *
 * The CLI runs outside the Nest container, so it validates the environment on
 * its own, using the database slice of the same schema: a migration run and the
 * service can never disagree about which database they mean, and the migration
 * job is not handed secrets it has no use for. The CLI loads `.env` before it
 * requires this file.
 */
const env = loadDatabaseEnv();

export default buildOrmOptions({
  databaseUrl: env.DATABASE_URL,
  debug: env.NODE_ENV === 'development',
});

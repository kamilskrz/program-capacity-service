import { loadDatabaseEnv } from '../config/env.schema';
import { buildOrmOptions } from './mikro-orm.options';

/**
 * Entry point for the MikroORM CLI (`npm run migration:create`, `migration:up`).
 * Runs outside the Nest container, so it validates the environment on its
 * own, using only the database slice of the same schema.
 */
const env = loadDatabaseEnv();

export default buildOrmOptions({
  databaseUrl: env.DATABASE_URL,
  debug: env.NODE_ENV === 'development',
});

import { Migrator } from '@mikro-orm/migrations';
import {
  defineConfig,
  PostgreSqlDriver,
  type Options,
} from '@mikro-orm/postgresql';

export interface OrmOptionsInput {
  readonly databaseUrl: string;
  readonly debug: boolean;
}

/**
 * The one description of how this service talks to Postgres, shared by the Nest
 * application and by the MikroORM CLI (see `mikro-orm.config.ts`).
 *
 * Deliberate choices:
 * - entities are registered explicitly as `EntitySchema` instances, so domain
 *   classes stay free of decorators (docs/PLAN.md 2.6). The list is empty in
 *   this cycle; `warnWhenNoEntities` keeps discovery from treating that as an
 *   error and is removed as soon as the first schema lands.
 * - the schema is owned by migrations only. There is no `synchronize` here and
 *   `schema:update` is never run, in any environment.
 */
export function buildOrmOptions(input: OrmOptionsInput): Options {
  return defineConfig({
    // Stated explicitly: @mikro-orm/nestjs cannot infer it through forRootAsync.
    driver: PostgreSqlDriver,
    clientUrl: input.databaseUrl,
    debug: input.debug,

    // EntitySchema instances go here, one per aggregate, from cycle 2 onwards.
    entities: [],
    discovery: { warnWhenNoEntities: false },

    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      path: './dist/capacity/infrastructure/persistence/migrations',
      pathTs: './src/capacity/infrastructure/persistence/migrations',
      transactional: true,
      allOrNothing: true,
      emit: 'ts',
      snapshot: false,
    },

    // Amounts and timestamps are compared across systems (treasury snapshots
    // carry `asOf`), so the driver must not reinterpret them in a local zone.
    forceUtcTimezone: true,
  });
}

import { join } from 'node:path';

import { Migrator } from '@mikro-orm/migrations';
import {
  defineConfig,
  FlushMode,
  PostgreSqlDriver,
  type Options,
} from '@mikro-orm/postgresql';

import { capacityEventSchema } from '../../capacity/infrastructure/persistence/capacity-event.mapping';
import { DomainHydrator } from '../../capacity/infrastructure/persistence/domain-hydrator';
import { programSchema } from '../../capacity/infrastructure/persistence/program.mapping';
import { reservationSchema } from '../../capacity/infrastructure/persistence/reservation.mapping';
import { fxRateSchema } from '../../fx/persistence/fx-rate.mapping';
import { discrepancySchema } from '../../treasury-sync/infrastructure/persistence/discrepancy.mapping';

/**
 * Where the migration files live, relative to this file. See the `migrations`
 * block below for why it is derived from `__dirname`.
 */
const MIGRATIONS_DIR = join(
  __dirname,
  '..',
  '..',
  'capacity',
  'infrastructure',
  'persistence',
  'migrations',
);

export interface OrmOptionsInput {
  readonly databaseUrl: string;
  readonly debug: boolean;
}

/**
 * Every table this service owns, as `EntitySchema` instances.
 *
 * Listed explicitly rather than discovered from a glob: discovery by path would
 * make the set of mapped tables depend on the build layout (`src` versus `dist`,
 * with and without test files), and a schema that silently failed to be discovered
 * is a schema whose migration looks like drift.
 *
 * The order is the order the migration creates the tables in, which is also the
 * order they can be truncated in without fighting the foreign keys.
 */
export const ENTITY_SCHEMAS = [
  programSchema,
  reservationSchema,
  capacityEventSchema,
  discrepancySchema,
  fxRateSchema,
];

/**
 * The one description of how this service talks to Postgres, shared by the Nest
 * application and by the MikroORM CLI (see `mikro-orm.config.ts`).
 *
 * Deliberate choices:
 * - entities are registered explicitly as `EntitySchema` instances, so domain
 *   classes stay free of decorators (docs/PLAN.md 2.6). See
 *   {@link ENTITY_SCHEMAS}.
 * - the schema is owned by migrations only. There is no `synchronize` here and
 *   `schema:update` is never run, in any environment.
 * - hydration goes through {@link DomainHydrator}, which rebuilds the value
 *   objects a row's columns describe and refuses a row the domain would not have
 *   produced (docs/PLAN.md 2.6).
 * - `flushMode: COMMIT`, so a read never flushes a dirty unit of work
 *   (docs/PLAN.md 2.6). Every write path flushes explicitly inside
 *   `em.transactional`.
 */
export function buildOrmOptions(input: OrmOptionsInput): Options {
  return defineConfig({
    // Stated explicitly: @mikro-orm/nestjs cannot infer it through forRootAsync.
    driver: PostgreSqlDriver,
    clientUrl: input.databaseUrl,
    debug: input.debug,

    entities: ENTITY_SCHEMAS,
    hydrator: DomainHydrator,

    // A read must not commit a change nobody has flushed: the default `auto`
    // flushes the unit of work inside `findOne` (docs/PLAN.md 2.6).
    flushMode: FlushMode.COMMIT,

    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      // Resolved from this file rather than from the working directory, and the
      // same value for both: `__dirname` already says which build is running —
      // `src/shared/database` under ts-node and Jest, `dist/shared/database` in
      // the container — so the migrations directory beside it is always the right
      // one. The original `./dist` + `./src` pair depended on MikroORM detecting
      // ts-node, which Jest's own module registry does not look like, and the
      // integration harness would then have applied nothing to a database the
      // whole suite assumes is migrated.
      path: MIGRATIONS_DIR,
      pathTs: MIGRATIONS_DIR,
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

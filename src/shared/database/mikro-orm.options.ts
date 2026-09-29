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

/** Derived from `__dirname` — see the `migrations` block below. */
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
 * Every table this service owns. Listed explicitly rather than discovered
 * from a glob, so the mapped set does not depend on the build layout. Order
 * is the order the migration creates the tables in, and so the order they
 * can be truncated in without fighting the foreign keys.
 */
export const ENTITY_SCHEMAS = [
  programSchema,
  reservationSchema,
  capacityEventSchema,
  discrepancySchema,
  fxRateSchema,
];

/**
 * The one description of how this service talks to Postgres, shared by the
 * Nest application and the MikroORM CLI (see `mikro-orm.config.ts`).
 */
export function buildOrmOptions(input: OrmOptionsInput): Options {
  return defineConfig({
    // @mikro-orm/nestjs cannot infer the driver through forRootAsync.
    driver: PostgreSqlDriver,
    clientUrl: input.databaseUrl,
    debug: input.debug,

    entities: ENTITY_SCHEMAS,
    hydrator: DomainHydrator,

    // The default `auto` flushes the unit of work inside `findOne`, so a
    // read could commit an uncommitted change (docs/PLAN.md 2.6).
    flushMode: FlushMode.COMMIT,

    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      // Both `path` and `pathTs` point at the same `__dirname`-derived
      // directory, rather than a `./dist` + `./src` pair: that pair depends
      // on MikroORM detecting ts-node, which Jest's module registry does
      // not look like, so the integration harness would apply no migrations
      // to a database the suite assumes is migrated.
      path: MIGRATIONS_DIR,
      pathTs: MIGRATIONS_DIR,
      transactional: true,
      allOrNothing: true,
      emit: 'ts',
      snapshot: false,
    },

    // Amounts and timestamps are compared across systems (treasury
    // snapshots carry `asOf`), so the driver must not reinterpret them in a
    // local zone.
    forceUtcTimezone: true,
  });
}

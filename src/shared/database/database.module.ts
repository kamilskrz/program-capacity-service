import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { buildOrmOptions } from './mikro-orm.options';

/**
 * `MikroOrmModule.forRoot*` registers a global module of its own, so
 * `MikroORM` and `EntityManager` are injectable everywhere without this module
 * re-exporting anything.
 */
@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      // Repeated here because @mikro-orm/nestjs cannot see the factory result
      // when it resolves driver-specific imports.
      driver: PostgreSqlDriver,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        buildOrmOptions({
          databaseUrl: config.databaseUrl,
          debug: !config.isProduction,
        }),
    }),
  ],
})
export class DatabaseModule {}

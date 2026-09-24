import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import { AppConfigService } from './app-config.service';
import { parseEnv } from './env.schema';

/**
 * Configuration is global and validated once, at startup: `parseEnv` runs
 * while the module is being resolved, so a missing or malformed variable
 * aborts the bootstrap instead of surfacing on the first request.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      cache: true,
      envFilePath: ['.env'],
      // Container environments supply variables directly; a missing .env file
      // is not an error, a missing variable is.
      ignoreEnvFile: false,
      validate: parseEnv,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}

import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AppConfigModule } from './shared/config/config.module';
import { DatabaseModule } from './shared/database/database.module';
import { HealthModule } from './shared/health/health.module';
import { LoggerModule } from './shared/observability/logger.module';
import { ObservabilityModule } from './shared/observability/observability.module';
import { ProblemDetailsFilter } from './shared/http/problem-details.filter';
import { RequestIdMiddleware } from './shared/http/request-id.middleware';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { CapacityModule } from './capacity/capacity.module';
import { TreasurySyncModule } from './treasury-sync/treasury-sync.module';

/**
 * Cycle 0 wired only the shell; docs/PLAN.md 2.7's second half adds the
 * business modules and the cross-cutting concerns every route needs:
 * rate-limiting before authentication (`ThrottlerGuard` runs first, so a
 * request that was never going to be let through spends no verification
 * effort), then `JwtAuthGuard`, then the RFC 7807 filter, then a request id
 * on every route. `LoggerModule`/`ObservabilityModule` come first among the
 * feature modules so a failure in anything after them is already logged
 * (docs/PLAN.md 2.8).
 */
@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    ObservabilityModule,
    DatabaseModule,
    HealthModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    AuthModule,
    CapacityModule,
    TreasurySyncModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // `{*path}`, not `'*'`: the bare star is the pre-`path-to-regexp`-8 form
    // and logs a deprecation warning on every boot.
    consumer
      .apply(RequestIdMiddleware)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}

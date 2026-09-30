import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AppConfigModule } from './shared/config/config.module';
import { DatabaseModule } from './shared/database/database.module';
import { HealthModule } from './shared/health/health.module';
import { ProblemDetailsFilter } from './shared/http/problem-details.filter';
import { RequestIdMiddleware } from './shared/http/request-id.middleware';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { CapacityModule } from './capacity/capacity.module';

/**
 * Cycle 0 wired only the shell; docs/PLAN.md 2.7's second half adds the
 * business modules and the cross-cutting concerns every route needs:
 * rate-limiting before authentication (`ThrottlerGuard` runs first, so a
 * request that was never going to be let through spends no verification
 * effort), then `JwtAuthGuard`, then the RFC 7807 filter, then a request id
 * on every route.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    HealthModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    AuthModule,
    CapacityModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  MikroOrmHealthIndicator,
  type HealthCheckResult,
} from '@nestjs/terminus';

import { Public } from '../../auth/public.decorator';

/**
 * Probes live outside `/api/v1`: they belong to the deployment, not to the
 * versioned business API, and orchestrators should not have to track versions.
 * `@Public()` on both, for the same reason: an orchestrator's probe has no
 * bearer token and never will.
 */
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: MikroOrmHealthIndicator,
  ) {}

  /**
   * Liveness. No dependency checks on purpose: a database outage must not make
   * the orchestrator restart or kill a process that is otherwise healthy.
   */
  @Get()
  @Public()
  @HealthCheck()
  liveness(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  /**
   * Readiness. Fails while a dependency the service cannot work without is
   * unavailable, so traffic is routed elsewhere.
   */
  @Get('ready')
  @Public()
  @HealthCheck()
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.database.pingCheck('postgres', { timeout: 1_500 }),
    ]);
  }
}

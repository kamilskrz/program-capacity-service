import { Controller, Get, Header, VERSION_NEUTRAL } from '@nestjs/common';

import { MetricsService } from './metrics.service';
import { Public } from '../../auth/public.decorator';

/**
 * `/metrics` (docs/PLAN.md 2.8). Outside `/api/v1` and `@Public()` for the same
 * reason the probes are: a scraper belongs to the deployment, not to the
 * business API, and Prometheus carries no bearer token. In production the port
 * is reached only from inside the cluster — network policy, not a guard.
 */
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Public()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.scrape();
  }
}

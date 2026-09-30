import { Global, Module } from '@nestjs/common';

import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * `@Global()` so every module that wants to record a metric can inject
 * `MetricsService` without each one importing this — the alternative is the
 * same import line in every feature module for one stateless collector.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class ObservabilityModule {}

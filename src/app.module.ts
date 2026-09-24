import { Module } from '@nestjs/common';

import { AppConfigModule } from './shared/config/config.module';
import { DatabaseModule } from './shared/database/database.module';
import { HealthModule } from './shared/health/health.module';

/**
 * Cycle 0 wires only the shell. The feature modules named in docs/PLAN.md 3
 * (`capacity`, `treasury-sync`, `fx`, `auth`) are added by the cycles that
 * implement them; their folders already exist so the intended layout is visible.
 */
@Module({
  imports: [AppConfigModule, DatabaseModule, HealthModule],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AppConfigService } from '../shared/config/app-config.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ProgramOwnershipGuard } from './program-ownership.guard';
import { TokenController } from './token.controller';

/**
 * Not yet wired into `AppModule` (docs/PLAN.md block 4's second half wires
 * `APP_GUARD` alongside the business controllers this cycle doesn't add).
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.jwtSecret,
      }),
    }),
  ],
  controllers: [TokenController],
  providers: [JwtAuthGuard, ProgramOwnershipGuard],
  exports: [JwtAuthGuard, ProgramOwnershipGuard, JwtModule],
})
export class AuthModule {}

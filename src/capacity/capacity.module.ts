import { Module } from '@nestjs/common';

import { CapacityQueryService } from './application/capacity-query.service';
import { CreateProgramUseCase } from './application/create-program.use-case';
import { CLOCK } from './application/ports/clock';
import { TRANSACTION_RUNNER } from './application/ports/transaction-runner';
import { ReleaseReservationUseCase } from './application/release-reservation.use-case';
import { ReserveInvoiceUseCase } from './application/reserve-invoice.use-case';
import { ProgramsController } from './infrastructure/http/programs.controller';
import { MikroOrmTransactionRunner } from './infrastructure/persistence/mikro-orm-transaction-runner';
import { AuthModule } from '../auth/auth.module';
import { SystemClock } from '../shared/system-clock';

/**
 * Wires the controllers on top of block 4's first-half infrastructure
 * (docs/PLAN.md 2.7). Deliberately not yet imported by `AppModule` — that
 * happens once the use cases and query service are for real, not stubs.
 * Imports `AuthModule` because `ProgramsController` reaches for
 * `ProgramOwnershipGuard`/`@Scopes`, which have to be resolvable from this
 * module's own injector — a per-route `@UseGuards(SomeClass)` is instantiated
 * against the enclosing module, not the one the guard happens to be declared in.
 */
@Module({
  imports: [AuthModule],
  controllers: [ProgramsController],
  providers: [
    { provide: TRANSACTION_RUNNER, useClass: MikroOrmTransactionRunner },
    { provide: CLOCK, useClass: SystemClock },
    CreateProgramUseCase,
    ReserveInvoiceUseCase,
    ReleaseReservationUseCase,
    CapacityQueryService,
  ],
})
export class CapacityModule {}

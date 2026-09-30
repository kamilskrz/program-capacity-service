import { Module } from '@nestjs/common';

import { ApplyInvoiceRepaidUseCase } from './application/apply-invoice-repaid.use-case';
import { ApplyLimitChangeUseCase } from './application/apply-limit-change.use-case';
import { ApplySnapshotUseCase } from './application/apply-snapshot.use-case';
import { DISCREPANCY_REPOSITORY } from './application/ports/discrepancy.repository';
import { TREASURY_TRANSACTION_RUNNER } from './application/ports/treasury-transaction-runner';
import { TreasuryKafkaConsumer } from './infrastructure/kafka/treasury-kafka-consumer';
import { MikroOrmDiscrepancyRepository } from './infrastructure/persistence/mikro-orm-discrepancy.repository';
import { MikroOrmTreasuryTransactionRunner } from './infrastructure/persistence/mikro-orm-treasury-transaction-runner';
import { CapacityModule } from '../capacity/capacity.module';

/**
 * Wires block 5's second half (docs/PLAN.md 2.2) on top of the first half's
 * use cases. Imports `CapacityModule` for `TRANSACTION_RUNNER`/`CLOCK`, which
 * `ApplyLimitChangeUseCase`/`ApplyInvoiceRepaidUseCase` need directly.
 *
 * Importing this module starts a Kafka consumer on `onModuleInit`: the API and
 * the consumer are one process in this deployment (see `docker-compose.yml`'s
 * single `api` service), so that is the honest production wiring.
 */
@Module({
  imports: [CapacityModule],
  providers: [
    {
      provide: TREASURY_TRANSACTION_RUNNER,
      useClass: MikroOrmTreasuryTransactionRunner,
    },
    {
      provide: DISCREPANCY_REPOSITORY,
      useClass: MikroOrmDiscrepancyRepository,
    },
    ApplySnapshotUseCase,
    ApplyLimitChangeUseCase,
    ApplyInvoiceRepaidUseCase,
    TreasuryKafkaConsumer,
  ],
})
export class TreasurySyncModule {}

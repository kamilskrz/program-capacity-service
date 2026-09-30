import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { MikroOrmDiscrepancyRepository } from './mikro-orm-discrepancy.repository';
import {
  type TreasuryRepositories,
  type TreasuryTransactionRunner,
} from '../../application/ports/treasury-transaction-runner';
import { MikroOrmCapacityEventLog } from '../../../capacity/infrastructure/persistence/mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from '../../../capacity/infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmReservationRepository } from '../../../capacity/infrastructure/persistence/mikro-orm-reservation.repository';
import { DatabaseFxRateProvider } from '../../../fx/persistence/database-fx-rate.provider';

/**
 * `TreasuryTransactionRunner` over MikroORM — a deliberate near-duplicate of
 * `MikroOrmTransactionRunner` (docs/PLAN.md 2.2), not a wrapper around it:
 * each forks its own `EntityManager` and opens its own transaction
 * independently, so `capacity`'s runner never has to know a treasury-only
 * repository exists. That keeps the dependency direction §3 draws
 * (`treasury-sync` → `capacity`, never the reverse) intact — the same
 * reasoning that keeps `reserve` and `recordTreasuryHold` two methods on
 * `Program` instead of one with a flag.
 */
@Injectable()
export class MikroOrmTreasuryTransactionRunner implements TreasuryTransactionRunner {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: (repos: TreasuryRepositories) => Promise<T>): Promise<T> {
    const fork = this.em.fork();

    return fork.transactional((tx) =>
      work({
        programs: new MikroOrmProgramRepository(tx),
        reservations: new MikroOrmReservationRepository(tx),
        events: new MikroOrmCapacityEventLog(tx),
        rates: new DatabaseFxRateProvider(tx),
        discrepancies: new MikroOrmDiscrepancyRepository(tx),
      }),
    );
  }
}

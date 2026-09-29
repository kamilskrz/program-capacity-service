import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { MikroOrmCapacityEventLog } from './mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from './mikro-orm-program.repository';
import { MikroOrmReservationRepository } from './mikro-orm-reservation.repository';
import {
  type CapacityRepositories,
  type TransactionRunner,
} from '../../application/ports/transaction-runner';
import { DatabaseFxRateProvider } from '../../../fx/persistence/database-fx-rate.provider';

/**
 * `TransactionRunner` over MikroORM (docs/PLAN.md 2.4). Injected with the
 * request-scoped `EntityManager` only to fork it — every read and write
 * still goes through the fork `run` hands to `work`, never through the
 * injected instance itself, so this is not the repository-captures-the-global-`EntityManager`
 * mistake the repositories are built to avoid.
 */
@Injectable()
export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: (repos: CapacityRepositories) => Promise<T>): Promise<T> {
    const fork = this.em.fork();

    return fork.transactional((tx) =>
      work({
        programs: new MikroOrmProgramRepository(tx),
        reservations: new MikroOrmReservationRepository(tx),
        events: new MikroOrmCapacityEventLog(tx),
        rates: new DatabaseFxRateProvider(tx),
      }),
    );
  }
}

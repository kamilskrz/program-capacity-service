import { InMemoryDiscrepancyRepository } from './in-memory-discrepancy-repository';
import {
  type TreasuryRepositories,
  type TreasuryTransactionRunner,
} from '../ports/treasury-transaction-runner';
import {
  InMemoryCapacityRepositories,
  InMemoryTransactionRunner,
} from '../../../capacity/application/testing/in-memory-capacity-repositories';

/**
 * Wraps `InMemoryTransactionRunner` rather than reimplementing its
 * flush-after-`work` dance: `capacity`'s fakes are composed here, not
 * duplicated, mirroring how the real `MikroOrmTreasuryTransactionRunner`
 * builds its own repositories instead of asking `capacity`'s runner to widen
 * itself.
 */
export class InMemoryTreasuryTransactionRunner implements TreasuryTransactionRunner {
  private readonly capacityRunner: InMemoryTransactionRunner;
  readonly discrepancies = new InMemoryDiscrepancyRepository();

  constructor(
    readonly capacity: InMemoryCapacityRepositories = new InMemoryCapacityRepositories(),
  ) {
    this.capacityRunner = new InMemoryTransactionRunner(capacity);
  }

  async run<T>(work: (repos: TreasuryRepositories) => Promise<T>): Promise<T> {
    return this.capacityRunner.run((repos) =>
      work({ ...repos, discrepancies: this.discrepancies }),
    );
  }
}

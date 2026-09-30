import { type DiscrepancyRepository } from './discrepancy.repository';
import { type CapacityRepositories } from '../../../capacity/application/ports/transaction-runner';

/**
 * The four capacity ports plus `treasury-sync`'s own discrepancy port, all
 * bound to the same transaction (docs/PLAN.md 2.2). `capacity`'s
 * `TransactionRunner`/`CapacityRepositories` stay ignorant of
 * `DiscrepancyRepository` on purpose — see
 * `MikroOrmTreasuryTransactionRunner`'s docblock for why the duplication that
 * buys is deliberate.
 */
export interface TreasuryRepositories extends CapacityRepositories {
  readonly discrepancies: DiscrepancyRepository;
}

/** Opens one transaction and hands back {@link TreasuryRepositories}. */
export interface TreasuryTransactionRunner {
  run<T>(work: (repos: TreasuryRepositories) => Promise<T>): Promise<T>;
}

/** Injection token for {@link TreasuryTransactionRunner}. */
export const TREASURY_TRANSACTION_RUNNER = Symbol('TreasuryTransactionRunner');

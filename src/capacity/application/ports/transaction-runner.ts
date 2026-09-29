import { type CapacityEventLog } from './capacity-event.log';
import { type ProgramRepository } from './program.repository';
import { type ReservationRepository } from './reservation.repository';
import { type FxRateProvider } from '../../../fx/fx-rate.provider';

/** The four ports a capacity change needs, all bound to the same transaction (docs/PLAN.md 2.4). */
export interface CapacityRepositories {
  readonly programs: ProgramRepository;
  readonly reservations: ReservationRepository;
  readonly events: CapacityEventLog;
  readonly rates: FxRateProvider;
}

/**
 * Opens the one transaction a capacity change runs in and hands back the
 * repositories bound to it (docs/PLAN.md 2.4) — the seam that keeps MikroORM
 * out of the application layer.
 */
export interface TransactionRunner {
  run<T>(work: (repos: CapacityRepositories) => Promise<T>): Promise<T>;
}

/** Injection token for {@link TransactionRunner}. */
export const TRANSACTION_RUNNER = Symbol('TransactionRunner');

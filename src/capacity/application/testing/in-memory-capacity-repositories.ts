import { UniqueConstraintViolationException } from '@mikro-orm/core';

import {
  type CapacityEventPage,
  type CapacityEventPageRequest,
  type CapacityEventLog,
} from '../ports/capacity-event.log';
import {
  type ProgramRepository,
  type ReconciliationWatermark,
} from '../ports/program.repository';
import {
  type ReservationPage,
  type ReservationRepository,
} from '../ports/reservation.repository';
import {
  type CapacityRepositories,
  type TransactionRunner,
} from '../ports/transaction-runner';
import { type CapacityEvent } from '../../domain/capacity-event';
import { type CurrencyCode } from '../../domain/currency';
import { type Money } from '../../domain/money';
import { type Program } from '../../domain/program';
import { type Reservation } from '../../domain/reservation';
import { type FxRate } from '../../../fx/fx-rate';
import { type FxRateProvider } from '../../../fx/fx-rate.provider';

function notImplemented(what: string): never {
  throw new Error(`in-memory fake: ${what} is not implemented`);
}

function reservationKey(programId: string, invoiceId: string): string {
  return `${programId}\u0000${invoiceId}`;
}

/**
 * Single-threaded, so `findForCapacityChange` needs no real lock. `add` writes
 * straight through — unlike `FakeReservationRepository`, nothing here stages
 * for a later flush, since no test adds a program mid-transaction.
 */
class FakeProgramRepository implements ProgramRepository {
  private readonly programs = new Map<string, Program>();

  seed(program: Program): void {
    this.programs.set(program.id, program);
  }

  findById(programId: string): Promise<Program | null> {
    return Promise.resolve(this.programs.get(programId) ?? null);
  }

  findForCapacityChange(programId: string): Promise<Program | null> {
    return Promise.resolve(this.programs.get(programId) ?? null);
  }

  add(program: Program): void {
    this.programs.set(program.id, program);
  }

  findWatermark(): Promise<ReconciliationWatermark | null> {
    return notImplemented('ProgramRepository.findWatermark');
  }

  advanceWatermark(): void {
    notImplemented('ProgramRepository.advanceWatermark');
  }
}

/**
 * `add` stages rather than writing straight into the seeded map, and only
 * commits when {@link flush} runs — the in-memory analogue of MikroORM's
 * `persist` + implicit flush, so the backstop can be made to surface only
 * after `work` has returned (docs/PLAN.md 2.4's "one backstop the use case owns").
 */
class FakeReservationRepository implements ReservationRepository {
  private readonly reservations = new Map<string, Reservation>();
  private pending: Reservation | null = null;
  private forcedViolation = false;

  seed(reservation: Reservation): void {
    this.reservations.set(
      reservationKey(reservation.programId, reservation.invoiceId),
      reservation,
    );
  }

  /** Makes the next {@link flush} raise `UniqueConstraintViolationException`, whatever was staged. */
  forceUniqueViolationOnNextAdd(): void {
    this.forcedViolation = true;
  }

  findForInvoice(
    programId: string,
    invoiceId: string,
  ): Promise<Reservation | null> {
    return Promise.resolve(
      this.reservations.get(reservationKey(programId, invoiceId)) ?? null,
    );
  }

  findForReconciliation(): Promise<Reservation[]> {
    return notImplemented('ReservationRepository.findForReconciliation');
  }

  listByProgram(): Promise<ReservationPage> {
    return notImplemented('ReservationRepository.listByProgram');
  }

  add(reservation: Reservation): void {
    this.pending = reservation;
  }

  /**
   * Commits the staged `add`, or raises the exception the real unique
   * constraint would raise at flush time. Called by the fake runner after
   * `work` resolves, never from inside it.
   */
  flush(): void {
    const staged = this.pending;

    this.pending = null;

    if (this.forcedViolation) {
      this.forcedViolation = false;

      throw new UniqueConstraintViolationException(
        new Error(
          'duplicate key value violates unique constraint "reservations_program_id_invoice_id_key"',
        ),
      );
    }

    if (staged === null) {
      return;
    }

    const key = reservationKey(staged.programId, staged.invoiceId);

    if (this.reservations.has(key)) {
      throw new UniqueConstraintViolationException(
        new Error(
          'duplicate key value violates unique constraint "reservations_program_id_invoice_id_key"',
        ),
      );
    }

    this.reservations.set(key, staged);
  }
}

class FakeCapacityEventLog implements CapacityEventLog {
  readonly appended: CapacityEvent[] = [];

  append(event: CapacityEvent): void {
    if (event === null || event === undefined) {
      throw new TypeError(
        'CapacityEventLog.append was handed no event: the caller has to branch on the domain returning null rather than forward it',
      );
    }

    this.appended.push(event);
  }

  findByProgram(
    _programId: string,
    _options?: CapacityEventPageRequest,
  ): Promise<CapacityEventPage> {
    return notImplemented('CapacityEventLog.findByProgram');
  }

  sumDeltas(): Promise<Money | null> {
    return notImplemented('CapacityEventLog.sumDeltas');
  }
}

class FakeFxRateProvider implements FxRateProvider {
  private readonly rates = new Map<string, FxRate>();

  seed(rate: FxRate): void {
    this.rates.set(`${rate.base}/${rate.quote}`, rate);
  }

  getRate(base: CurrencyCode, quote: CurrencyCode): Promise<FxRate | null> {
    return Promise.resolve(this.rates.get(`${base}/${quote}`) ?? null);
  }
}

/** The four fakes a use case test seeds and inspects, held together like `CapacityRepositories`. */
export class InMemoryCapacityRepositories implements CapacityRepositories {
  readonly programs = new FakeProgramRepository();
  readonly reservations = new FakeReservationRepository();
  readonly events = new FakeCapacityEventLog();
  readonly rates = new FakeFxRateProvider();
}

/**
 * Runs `work` once against one `InMemoryCapacityRepositories`, then flushes
 * the reservation repository — the one place staged work can still fail,
 * mirroring where `em.transactional`'s implicit flush sits relative to a real
 * use case's callback (docs/PLAN.md 2.4).
 */
export class InMemoryTransactionRunner implements TransactionRunner {
  constructor(readonly repos: InMemoryCapacityRepositories) {}

  async run<T>(work: (repos: CapacityRepositories) => Promise<T>): Promise<T> {
    const result = await work(this.repos);

    this.repos.reservations.flush();

    return result;
  }
}

/** Errors raised by the capacity aggregates — `Program` and `Reservation`. */

import { DomainError } from './errors';
import { type Money } from './money';

/** The `409` of docs/PLAN.md 2.7. `available` may be negative (an over-utilised program). */
export class InsufficientCapacityError extends DomainError {
  readonly code = 'INSUFFICIENT_CAPACITY';

  constructor(
    readonly programId: string,
    readonly requested: Money,
    readonly available: Money,
  ) {
    super(
      `Program ${programId} has ${available.toString()} available, which does not cover ${requested.toString()}`,
    );
  }
}

/**
 * A different-payload replay or a re-reservation of a released invoice; `409`
 * (docs/PLAN.md 2.5). An identical-payload replay is not this error.
 */
export class DuplicateInvoiceError extends DomainError {
  readonly code = 'DUPLICATE_INVOICE';

  constructor(
    readonly programId: string,
    readonly invoiceId: string,
    readonly reason: string,
  ) {
    super(
      `Invoice ${invoiceId} is already reserved in program ${programId}: ${reason}`,
    );
  }
}

/**
 * An operation the reservation's current state does not allow (`ACTIVE →
 * RELEASED` is terminal, docs/PLAN.md 2.5). A repeated release is a no-op, not
 * this error — see `Program.release`.
 */
export class ReservationStateError extends DomainError {
  readonly code = 'RESERVATION_STATE_CONFLICT';

  constructor(
    readonly invoiceId: string,
    readonly status: string,
    readonly attempted: string,
  ) {
    super(
      `Cannot ${attempted} invoice ${invoiceId}: the reservation is ${status}`,
    );
  }
}

/** A reservation handed to a program it does not belong to — a wiring fault. */
export class ReservationNotInProgramError extends DomainError {
  readonly code = 'RESERVATION_PROGRAM_MISMATCH';

  constructor(
    readonly programId: string,
    readonly reservationProgramId: string,
    readonly invoiceId: string,
  ) {
    super(
      `Reservation for invoice ${invoiceId} belongs to program ${reservationProgramId}, not ${programId}`,
    );
  }
}

/**
 * A reservation that cannot exist: a zero or negative amount, a blank
 * identifier, FX evidence contradicting the amounts, or a stored row whose
 * status and amounts disagree.
 */
export class InvalidReservationError extends DomainError {
  readonly code = 'INVALID_RESERVATION';

  constructor(readonly reason: string) {
    super(`Invalid reservation: ${reason}`);
  }
}

/** Negative, or in the wrong currency. Zero is legal — it suspends the program. */
export class InvalidCreditLimitError extends DomainError {
  readonly code = 'INVALID_CREDIT_LIMIT';

  constructor(readonly reason: string) {
    super(`Invalid credit limit: ${reason}`);
  }
}

/**
 * A blank identifier/organisation, a reserved total in the wrong currency, or
 * a negative reserved total (mirrors `CHECK (reserved_amount >= 0)`,
 * docs/PLAN.md 2.4). `available < 0` is legal and not checked here.
 */
export class InvalidProgramError extends DomainError {
  readonly code = 'INVALID_PROGRAM';

  constructor(readonly reason: string) {
    super(`Invalid program: ${reason}`);
  }
}

/** A capacity change offered without the provenance the audit trail requires (docs/PLAN.md 2.8). */
export class MissingAuditContextError extends DomainError {
  readonly code = 'MISSING_AUDIT_CONTEXT';

  constructor(readonly field: string) {
    super(`Capacity changes must be attributable: ${field} is missing`);
  }
}

/**
 * `reserved_amount == SUM(active reservations)` (docs/PLAN.md 2.4) does not
 * hold: releasing would drive the total below zero. Refused, not clamped —
 * clamping would manufacture capacity out of a data fault.
 */
export class CapacityInvariantError extends DomainError {
  readonly code = 'CAPACITY_INVARIANT_VIOLATED';

  constructor(readonly reason: string) {
    super(`Capacity invariant violated: ${reason}`);
  }
}

/**
 * Errors raised by the capacity aggregates — `Program` and `Reservation`.
 *
 * They live beside the aggregates rather than in `errors.ts`, which cycle 1
 * filled with the errors of the value objects (`Money`, currency codes). A
 * reader of `program.ts` should find what it can throw next to it, and the two
 * files have different audiences: one is about representing an amount, the
 * other about what may be done with a credit limit.
 *
 * Everything here extends the same {@link DomainError} base, so one exception
 * filter still maps every domain failure to RFC 7807 by its {@link
 * DomainError.code} (docs/PLAN.md 2.6, 2.7).
 *
 * Error construction is real code rather than a stub, exactly as in cycle 1: an
 * error carries no behaviour to implement, and the tests have to be able to
 * name these classes and assert their codes.
 */

import { DomainError } from './errors';
import { type Money } from './money';

/**
 * A reservation that would take the program past its credit limit.
 *
 * The `409` of docs/PLAN.md 2.7. It carries both figures as `Money` rather than
 * as formatted strings, so the HTTP layer decides how to render them and a log
 * line, a problem+json body and a metric can each read what they need.
 *
 * `available` may be negative: an over-utilised program (docs/PLAN.md 2.1)
 * refuses every reservation, and the response should say by how much it is
 * already over rather than pretend capacity is zero.
 */
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
 * A second reservation for an invoice that this program has already financed,
 * with a different amount or after it was released.
 *
 * The natural key `(programId, invoiceId)` is the idempotency key
 * (docs/PLAN.md 2.5): an identical repeat is a replay and is *not* an error,
 * while a changed payload and a re-reservation of a released invoice are both
 * `409`. The two are one error class because they are the same statement — this
 * invoice is already spoken for — and `reason` distinguishes them for the
 * message and the log.
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
 * An operation the reservation's current state does not allow: correcting an
 * amount that is no longer held, for instance.
 *
 * `ACTIVE → RELEASED` is terminal (docs/PLAN.md 2.5). Note that a *repeated
 * release* is deliberately not this error — see `Program.release`, which treats
 * it as the no-op the idempotency rule requires.
 *
 * The fields are typed `string` rather than `ReservationStatus` to keep this
 * file free of an import from `reservation.ts`, which imports this one.
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

/**
 * A reservation handed to a program it does not belong to.
 *
 * This is a wiring fault rather than a business outcome — the application layer
 * loaded the wrong row, or a tenant boundary was crossed — but it is checked in
 * the domain because the consequence is silent: the freed capacity would land
 * on the wrong program's limit and no later reconciliation would explain the
 * gap.
 */
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
 * identifier, FX evidence that contradicts the amounts it is supposed to
 * explain, or a stored row whose status and amounts disagree.
 *
 * "An amount must be positive" is a rule about reservations, not about money
 * (see `money.ts`), which is why it is enforced here.
 */
export class InvalidReservationError extends DomainError {
  readonly code = 'INVALID_RESERVATION';

  constructor(readonly reason: string) {
    super(`Invalid reservation: ${reason}`);
  }
}

/**
 * A credit limit that cannot be set: negative, or stated in a currency other
 * than the program's.
 *
 * Zero is legal — it is how a program is suspended without being deleted, and
 * it simply refuses every reservation.
 */
export class InvalidCreditLimitError extends DomainError {
  readonly code = 'INVALID_CREDIT_LIMIT';

  constructor(readonly reason: string) {
    super(`Invalid credit limit: ${reason}`);
  }
}

/**
 * A program that cannot exist: a blank identifier or owning organisation, a
 * reserved total in the wrong currency, or a negative reserved total.
 *
 * The last of those mirrors `CHECK (reserved_amount >= 0)` in the schema
 * (docs/PLAN.md 2.4). Note what is *not* here: `available >= 0`. Reconciliation
 * may legitimately push availability below zero, and a program in that state
 * must still load, report and release.
 */
export class InvalidProgramError extends DomainError {
  readonly code = 'INVALID_PROGRAM';

  constructor(readonly reason: string) {
    super(`Invalid program: ${reason}`);
  }
}

/**
 * A capacity change offered without the provenance the audit trail requires.
 *
 * `capacity_events` answers "why did available capacity drop by 1.8M at 10:32?"
 * (docs/PLAN.md 2.8), which an entry with no actor cannot do. Since every
 * capacity-changing operation both demands this context and produces the entry,
 * an unattributable change is refused before any state moves — there is no path
 * that changes a limit or a reserved total and leaves no trace.
 */
export class MissingAuditContextError extends DomainError {
  readonly code = 'MISSING_AUDIT_CONTEXT';

  constructor(readonly field: string) {
    super(`Capacity changes must be attributable: ${field} is missing`);
  }
}

/**
 * The denormalized reserved total and the reservation being operated on
 * disagree: releasing would drive the total below zero.
 *
 * `reserved_amount == SUM(active reservations)` is the invariant of
 * docs/PLAN.md 2.4, and this is what the domain does when it is presented with
 * a state where it does not hold. It refuses rather than clamps at zero:
 * clamping would silently manufacture capacity out of a data fault, which is
 * the one direction the service must never err in. (Negative *availability* is
 * a different thing entirely and is perfectly legal.)
 */
export class CapacityInvariantError extends DomainError {
  readonly code = 'CAPACITY_INVARIANT_VIOLATED';

  constructor(readonly reason: string) {
    super(`Capacity invariant violated: ${reason}`);
  }
}

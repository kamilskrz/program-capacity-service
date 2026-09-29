import {
  CapacityInvariantError,
  DuplicateInvoiceError,
  InsufficientCapacityError,
  InvalidCreditLimitError,
  InvalidProgramError,
  InvalidReservationError,
  MissingAuditContextError,
  ReservationNotInProgramError,
} from './capacity-errors';
import {
  type CapacityChangeContext,
  type CapacityEvent,
  type CapacityEventMetadata,
  type CapacityEventType,
} from './capacity-event';
import { type CurrencyCode } from './currency';
import { CurrencyMismatchError } from './errors';
import { Money } from './money';
import { Reservation, type ReleaseReason } from './reservation';
import { type Conversion } from '../../fx/convert';

/** What it takes to open a program. */
export interface ProgramProps {
  readonly id: string;
  /** The `org` claim a token has to match (docs/PLAN.md 2.7). */
  readonly ownerOrgId: string;
  /** The currency the limit, the reserved total and every hold are stated in. */
  readonly currency: CurrencyCode;
  readonly creditLimit: Money;
}

/** A stored program. Unlike {@link ProgramProps}, includes the denormalized reserved total. */
export interface ProgramState extends ProgramProps {
  /**
   * Sum of what every active reservation holds (docs/PLAN.md 2.4). Never
   * negative; may exceed the credit limit (an over-utilised program).
   */
  readonly reserved: Money;
}

/** What `Program.reserve` is asked for. */
export interface ReservationRequest {
  /** Unique **within this program**, not globally (docs/PLAN.md 2.9). */
  readonly invoiceId: string;
  /** The invoice amount and its conversion, computed before the domain is called. */
  readonly amount: Conversion;
}

/**
 * What a call site receives from an operation that touched a reservation.
 * `event` is `null` exactly when nothing changed — every idempotent path maps
 * to `200`; a non-null event maps to `201`/a change (docs/PLAN.md 2.5).
 */
export interface ReservationChange {
  readonly reservation: Reservation;
  readonly event: CapacityEvent | null;
}

/** As {@link ReservationChange}, for an operation that touches no invoice. */
export interface LimitChange {
  readonly event: CapacityEvent | null;
}

/** Blank identifiers are refused; padding is removed rather than stored. */
function trimmedIdentifier(value: string, what: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new InvalidProgramError(`${what} must not be blank`);
  }

  return trimmed;
}

/** Same normalisation as {@link trimmedIdentifier}, refused as a broken reservation. */
function trimmedInvoiceId(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new InvalidReservationError('invoice id must not be blank');
  }

  return trimmed;
}

/**
 * Drops `undefined` fields rather than storing them: a persistence layer
 * iterating `Object.keys` would otherwise write `fxRate: null` into jsonb,
 * recording a rate as looked-for-and-missing rather than never needed
 * (docs/PLAN.md 2.3).
 */
function withoutAbsentFields(
  metadata: CapacityEventMetadata,
): CapacityEventMetadata {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

/** Never refused for being smaller than what is already reserved — see {@link Program.changeCreditLimit}. */
function assertCreditLimit(limit: Money, currency: CurrencyCode): void {
  if (limit.currency !== currency) {
    throw new InvalidCreditLimitError(
      `a ${currency} program cannot carry a limit in ${limit.currency}`,
    );
  }

  if (limit.isNegative()) {
    throw new InvalidCreditLimitError(
      `a limit cannot be negative, got ${limit.toString()}`,
    );
  }
}

/** Refuses a change nobody could be held to account for, before any state moves (docs/PLAN.md 2.8). */
function assertAttributable(context: CapacityChangeContext): void {
  if (context.actor.trim().length === 0) {
    throw new MissingAuditContextError('actor');
  }

  if (Number.isNaN(context.occurredAt.getTime())) {
    throw new MissingAuditContextError('occurredAt');
  }
}

/**
 * A funding program: a credit limit, the capacity currently held against it,
 * and the rules for consuming it. The aggregate root — every capacity change
 * goes through a method here, even those whose state machine lives on
 * `Reservation`, so the reserved total and the reservation move together.
 *
 * Not a collection of reservations: the reserved total is denormalized so
 * availability is an O(1) read of one locked row (docs/PLAN.md 2.4), which is
 * why {@link reserve} is *handed* the existing reservation rather than looking
 * it up itself.
 *
 * Mutates in place rather than returning a new instance, since the unit of
 * work tracks this instance's identity (docs/PLAN.md 2.4, 2.6). Tenancy
 * (`ownerOrgId`) is answered here but acted on by the HTTP guard, which turns
 * "not yours" into `404` (docs/PLAN.md 2.7).
 */
export class Program {
  /** Private: validation lives in the factories. */
  private constructor(
    readonly id: string,
    readonly ownerOrgId: string,
    readonly currency: CurrencyCode,
    private _creditLimit: Money,
    private _reserved: Money,
  ) {}

  /**
   * @throws {InvalidProgramError} if the identifier or owning organisation is blank.
   * @throws {InvalidCreditLimitError} if the limit is negative or not in the
   * program's currency. Zero is accepted (a suspended program).
   */
  static create(props: ProgramProps): Program {
    const { id, ownerOrgId, currency, creditLimit } = props;
    const programId = trimmedIdentifier(id, 'program id');
    const owner = trimmedIdentifier(ownerOrgId, 'owning organisation');

    assertCreditLimit(creditLimit, currency);

    return new Program(
      programId,
      owner,
      currency,
      creditLimit,
      Money.zero(currency),
    );
  }

  /**
   * Rebuilds a stored program, applying the same checks as {@link create} plus
   * those on the reserved total: same currency, never negative.
   *
   * @throws {InvalidProgramError} if the reserved total is negative or in the
   * wrong currency.
   * @throws {InvalidCreditLimitError} if the limit is negative or in the wrong
   * currency.
   */
  static rehydrate(state: ProgramState): Program {
    const { id, ownerOrgId, currency, creditLimit, reserved } = state;
    const programId = trimmedIdentifier(id, 'program id');
    const owner = trimmedIdentifier(ownerOrgId, 'owning organisation');

    assertCreditLimit(creditLimit, currency);

    if (reserved.currency !== currency) {
      throw new InvalidProgramError(
        `a ${currency} program cannot have ${reserved.currency} reserved against it`,
      );
    }

    // `CHECK (reserved_amount >= 0)` (docs/PLAN.md 2.4). The limit covering
    // the reserved total is deliberately not checked here.
    if (reserved.isNegative()) {
      throw new InvalidProgramError(
        `a reserved total cannot be negative, got ${reserved.toString()}`,
      );
    }

    return new Program(programId, owner, currency, creditLimit, reserved);
  }

  get creditLimit(): Money {
    return this._creditLimit;
  }

  get reserved(): Money {
    return this._reserved;
  }

  /** `creditLimit − reserved`. May be negative, and is never clamped (docs/PLAN.md 2.1). */
  get available(): Money {
    return this._creditLimit.subtract(this._reserved);
  }

  /** Exactly zero `available` is exhausted, not over-utilised. */
  get overUtilized(): boolean {
    return this.available.isNegative();
  }

  /** A predicate, not a guard — see the tenancy note on the class. */
  isOwnedBy(orgId: string): boolean {
    return this.ownerOrgId === orgId;
  }

  /**
   * `available >= amount`. An amount exactly equal to `available` fits.
   * @throws {CurrencyMismatchError} if `amount` is not in the program's currency.
   */
  hasCapacityFor(amount: Money): boolean {
    this.assertProgramCurrency('weigh an amount against the limit', amount);

    return this.available.isGreaterThanOrEqual(amount);
  }

  /**
   * Holds capacity for an invoice. `existing` is the reservation this program
   * already has for `request.invoiceId`, or `null` — looked up by the caller
   * so the duplicate *rule* lives in the domain while the unique constraint on
   * `(program_id, invoice_id)` backstops the race the lock cannot cover
   * (docs/PLAN.md 2.5, 2.9).
   *
   * With `existing`:
   * - active, same original amount → replay: returned with no event.
   * - active, different amount → `409`.
   * - released → `409` (re-reserving is refused, docs/PLAN.md 2.5).
   *
   * @throws {ReservationNotInProgramError} if `existing` belongs to another
   * program or another invoice.
   * @throws {DuplicateInvoiceError} on a conflicting or released duplicate.
   * @throws {InsufficientCapacityError} if the converted amount exceeds `available`.
   * @throws {InvalidReservationError} if the invoice id is blank, the amount
   * is not positive, or the conversion's rate doesn't match its currencies.
   * @throws {CurrencyMismatchError} if the conversion did not land in this
   * program's currency.
   * @throws {MissingAuditContextError} if the change is not attributable.
   */
  reserve(
    request: ReservationRequest,
    existing: Reservation | null,
    context: CapacityChangeContext,
  ): ReservationChange {
    assertAttributable(context);

    const invoiceId = trimmedInvoiceId(request.invoiceId);

    this.assertProgramCurrency(
      'reserve against this program',
      request.amount.converted,
    );

    if (existing !== null) {
      return this.resolveDuplicate(invoiceId, request.amount, existing);
    }

    const reservation = this.openHold(invoiceId, request.amount, context);
    const held = reservation.reservedAmount;

    // The only line that differs from {@link recordTreasuryHold}.
    if (!this.available.isGreaterThanOrEqual(held)) {
      throw new InsufficientCapacityError(this.id, held, this.available);
    }

    return this.recordHold(reservation, context);
  }

  /**
   * Reconciliation's counterpart to {@link reserve}: records a hold for an
   * invoice treasury reports with no capacity check, leaving the program
   * over-utilised rather than refusing real exposure (docs/PLAN.md 2.1).
   * Everything but the limit is checked exactly as strictly.
   *
   * `existing` must be `null` — refused outright as a `DuplicateInvoiceError`,
   * never replayed like {@link reserve}: a snapshot is re-evaluated in full
   * each time, so a non-null `existing` means stale state or a wiring bug, not
   * a retry. The audit entry is `RESERVED`, not `RECONCILIATION_ADJUSTMENT` —
   * this is a new hold, not a restated one.
   *
   * @throws {DuplicateInvoiceError} if `existing` is not `null`.
   * @throws {ReservationNotInProgramError} if `existing` belongs to another
   * program or another invoice.
   * @throws {InvalidReservationError} if the invoice id is blank, either amount
   * is not positive, or the conversion does not reproduce the hold it claims.
   * @throws {CurrencyMismatchError} if the conversion did not land in this
   * program's currency.
   * @throws {MissingAuditContextError} if the change is not attributable.
   */
  recordTreasuryHold(
    request: ReservationRequest,
    existing: Reservation | null,
    context: CapacityChangeContext,
  ): ReservationChange {
    assertAttributable(context);

    const invoiceId = trimmedInvoiceId(request.invoiceId);

    this.assertProgramCurrency(
      'record a treasury hold against this program',
      request.amount.converted,
    );

    if (existing !== null) {
      this.assertAddresses(existing, invoiceId);

      throw new DuplicateInvoiceError(
        this.id,
        invoiceId,
        `treasury reports it as new, but this program already holds it (${existing.status})`,
      );
    }

    // No capacity test between opening the hold and recording it: that absence
    // is the whole operation. Everything else is what `reserve` does.
    return this.recordHold(
      this.openHold(invoiceId, request.amount, context),
      context,
    );
  }

  /**
   * Frees exactly the amount the reservation held, never a recomputed one
   * (docs/PLAN.md 2.3). Works on an over-utilised program (docs/PLAN.md 2.1).
   * A repeated release is a no-op — see `Reservation.release`.
   *
   * @throws {ReservationNotInProgramError} if the reservation belongs to another program.
   * @throws {CurrencyMismatchError} if it holds an amount in another currency.
   * @throws {CapacityInvariantError} if freeing it would drive the reserved total below zero.
   * @throws {MissingAuditContextError} if the change is not attributable.
   */
  release(
    reservation: Reservation,
    reason: ReleaseReason,
    context: CapacityChangeContext,
  ): ReservationChange {
    assertAttributable(context);
    this.assertOwnReservation(reservation);
    this.assertProgramCurrency(
      'release a hold against this program',
      reservation.reservedAmount,
    );

    // Checked before the reservation mutates, so a failed check leaves both sides untouched.
    const freed = reservation.outstandingAmount;

    if (this._reserved.subtract(freed).isNegative()) {
      throw new CapacityInvariantError(
        `releasing ${freed.toString()} for invoice ${reservation.invoiceId} would take the reserved total of ${this._reserved.toString()} below zero`,
      );
    }

    const transition = reservation.release(reason, context.occurredAt);

    if (!transition.applied) {
      return { reservation, event: null };
    }

    this._reserved = this._reserved.add(transition.delta);

    return {
      reservation,
      event: this.record(
        'RELEASED',
        reservation.invoiceId,
        transition.delta,
        context,
        { reason },
      ),
    };
  }

  /**
   * Restates what a reservation holds, applying the difference to the reserved
   * total — "treasury wins" (docs/PLAN.md 2.1). May push the program past its
   * limit; that is accepted, since the exposure is real regardless of what was
   * previously recorded. A later release frees the corrected amount.
   *
   * @throws {ReservationNotInProgramError} if the reservation belongs to
   * another program.
   * @throws {ReservationStateError} if it is already released.
   * @throws {InvalidReservationError} if the corrected amount is not positive.
   * @throws {CurrencyMismatchError} if it is not in the program's currency.
   * @throws {CapacityInvariantError} if the adjustment would drive the reserved
   * total below zero.
   * @throws {MissingAuditContextError} if the change is not attributable.
   */
  correctReservation(
    reservation: Reservation,
    correctedAmount: Money,
    context: CapacityChangeContext,
  ): ReservationChange {
    assertAttributable(context);
    this.assertOwnReservation(reservation);
    this.assertProgramCurrency(
      'correct a hold against this program',
      correctedAmount,
    );

    const previous = reservation.reservedAmount;
    // A released hold doesn't count towards the reserved total, so only a
    // correction that will actually apply is projected against it.
    const willApply = reservation.isActive() && correctedAmount.isPositive();

    if (willApply) {
      const projected = this._reserved.subtract(previous).add(correctedAmount);

      if (projected.isNegative()) {
        throw new CapacityInvariantError(
          `correcting invoice ${reservation.invoiceId} from ${previous.toString()} to ${correctedAmount.toString()} would take the reserved total of ${this._reserved.toString()} below zero`,
        );
      }
    }

    const transition = reservation.correctTo(correctedAmount);

    if (!transition.applied) {
      return { reservation, event: null };
    }

    this._reserved = this._reserved.add(transition.delta);

    return {
      reservation,
      event: this.record(
        'RECONCILIATION_ADJUSTMENT',
        reservation.invoiceId,
        transition.delta,
        context,
        {
          previousReservedAmount: previous.toJSON(),
          correctedAmount: correctedAmount.toJSON(),
        },
      ),
    };
  }

  /**
   * Sets a new credit limit (docs/PLAN.md 2.1). Reserved total is untouched;
   * reducing below current exposure is legal and leaves the program
   * over-utilised. Emitted event has `delta` zero — see `CapacityEvent.delta`.
   *
   * @throws {InvalidCreditLimitError} if the new limit is negative or not in
   * the program's currency.
   * @throws {MissingAuditContextError} if the change is not attributable.
   */
  changeCreditLimit(
    newLimit: Money,
    context: CapacityChangeContext,
  ): LimitChange {
    assertAttributable(context);
    assertCreditLimit(newLimit, this.currency);

    if (newLimit.equals(this._creditLimit)) {
      return { event: null };
    }

    const previous = this._creditLimit;

    this._creditLimit = newLimit;

    return {
      event: this.record(
        'LIMIT_CHANGED',
        null,
        Money.zero(this.currency),
        context,
        {
          previousCreditLimit: previous.toJSON(),
          creditLimit: newLimit.toJSON(),
        },
      ),
    };
  }

  /** Shared by {@link reserve} and {@link recordTreasuryHold} so the two can't drift. */
  private openHold(
    invoiceId: string,
    amount: Conversion,
    context: CapacityChangeContext,
  ): Reservation {
    return Reservation.open({
      programId: this.id,
      invoiceId,
      amount,
      reservedAt: context.occurredAt,
    });
  }

  /**
   * Applies a newly opened hold to the reserved total and produces its
   * `RESERVED` audit fact. The limit check is deliberately not here — the one
   * thing {@link reserve} and {@link recordTreasuryHold} disagree about.
   */
  private recordHold(
    reservation: Reservation,
    context: CapacityChangeContext,
  ): ReservationChange {
    const held = reservation.reservedAmount;

    this._reserved = this._reserved.add(held);

    return {
      reservation,
      event: this.record('RESERVED', reservation.invoiceId, held, context, {
        originalAmount: reservation.originalAmount.toJSON(),
        fxRate: reservation.fxRate?.toJSON(),
      }),
    };
  }

  private resolveDuplicate(
    invoiceId: string,
    amount: Conversion,
    existing: Reservation,
  ): ReservationChange {
    this.assertAddresses(existing, invoiceId);

    if (existing.isReleased()) {
      throw new DuplicateInvoiceError(
        this.id,
        invoiceId,
        'it has already been released, and an invoice is financed once',
      );
    }

    // Judged on the original amount, never the converted one (docs/PLAN.md 2.3).
    if (!existing.originalAmount.equals(amount.original)) {
      throw new DuplicateInvoiceError(
        this.id,
        invoiceId,
        `it is held for ${existing.originalAmount.toString()}, not ${amount.original.toString()}`,
      );
    }

    return { reservation: existing, event: null };
  }

  /** Whether the handed-over reservation is this program's and this invoice's. */
  private assertAddresses(existing: Reservation, invoiceId: string): void {
    this.assertOwnReservation(existing);

    if (existing.invoiceId !== invoiceId) {
      throw new ReservationNotInProgramError(
        this.id,
        existing.programId,
        existing.invoiceId,
      );
    }
  }

  private assertOwnReservation(reservation: Reservation): void {
    if (reservation.programId !== this.id) {
      throw new ReservationNotInProgramError(
        this.id,
        reservation.programId,
        reservation.invoiceId,
      );
    }
  }

  /** Only the program's own currency consumes the program's limit. */
  private assertProgramCurrency(operation: string, amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new CurrencyMismatchError(
        operation,
        this.currency,
        amount.currency,
      );
    }
  }

  /** Caller-supplied `metadata` is annotation; the aggregate's own fields overrule it. */
  private record(
    type: CapacityEventType,
    invoiceId: string | null,
    delta: Money,
    context: CapacityChangeContext,
    metadata: CapacityEventMetadata,
  ): CapacityEvent {
    return {
      type,
      programId: this.id,
      invoiceId,
      delta,
      resultingReserved: this._reserved,
      actor: context.actor.trim(),
      source: context.source,
      correlationId: context.correlationId,
      occurredAt: new Date(context.occurredAt.getTime()),
      metadata: withoutAbsentFields({ ...context.metadata, ...metadata }),
    };
  }
}

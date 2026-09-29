import {
  InvalidReservationError,
  ReservationStateError,
} from './capacity-errors';
import { CurrencyMismatchError } from './errors';
import { Money } from './money';
import { applyRate, type Conversion } from '../../fx/convert';
import { type FxRate } from '../../fx/fx-rate';

/**
 * `ACTIVE → RELEASED`, terminal (docs/PLAN.md 2.5). No `EXPIRED`, no `PENDING`
 * — expiry is out of scope (docs/PLAN.md 5).
 */
export type ReservationStatus = 'ACTIVE' | 'RELEASED';

/**
 * Both values free the same capacity; they exist so risk and audit can tell
 * them apart (docs/PLAN.md 2.5). `REPAID` is the normal end of an invoice's
 * life; `CANCELLED` means the financing never completed.
 */
export type ReleaseReason = 'REPAID' | 'CANCELLED';

/** What `Program.reserve` needs to open a new hold. */
export interface OpenReservationProps {
  readonly programId: string;
  readonly invoiceId: string;
  /** `rate` is `null` iff no conversion happened. */
  readonly amount: Conversion;
  readonly reservedAt: Date;
}

/** A stored reservation, as one row of the table. */
export interface ReservationState {
  readonly programId: string;
  readonly invoiceId: string;
  readonly status: ReservationStatus;
  /** As the client stated it, in the invoice's own currency. */
  readonly originalAmount: Money;
  /** What this reservation holds against the limit, in the program currency. */
  readonly reservedAmount: Money;
  /** How much of {@link reservedAmount} has been given back. */
  readonly releasedAmount: Money;
  /**
   * The rate that converted {@link originalAmount} into {@link reservedAmount},
   * or `null` when the invoice was already in the program's currency.
   */
  readonly fxRate: FxRate | null;
  readonly reservedAt: Date;
  readonly releasedAt: Date | null;
  readonly releaseReason: ReleaseReason | null;
}

/**
 * What a transition did to the program's reserved total. Returned so `Program`
 * never has to recompute a delta the reservation already knows (docs/PLAN.md 2.3).
 */
export interface ReservationTransition {
  /** Negative for a release, either sign for a correction, zero when nothing changed. */
  readonly delta: Money;
  /** `false` for a no-op: an already-released reservation, or an unchanged correction. */
  readonly applied: boolean;
}

/**
 * Blank identifiers are refused, and whitespace is removed rather than
 * preserved: `(programId, invoiceId)` is the natural key (docs/PLAN.md 2.5),
 * so `" invoice-1"` and `"invoice-1"` must be one invoice, not two.
 */
function trimmedIdentifier(value: string, what: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new InvalidReservationError(`${what} must not be blank`);
  }

  return trimmed;
}

/** A hold that consumes nothing, or creates capacity, is not a hold. */
function assertHoldable(reservedAmount: Money): void {
  if (!reservedAmount.isPositive()) {
    throw new InvalidReservationError(
      `a hold must consume capacity, got ${reservedAmount.toString()}`,
    );
  }
}

/**
 * The FX fields are nullable *together* (docs/PLAN.md 2.3), and a present rate
 * must be the very pair it claims to have converted.
 */
function assertFxEvidence(
  originalAmount: Money,
  reservedAmount: Money,
  fxRate: FxRate | null,
): void {
  const converted = originalAmount.currency !== reservedAmount.currency;

  if (converted && fxRate === null) {
    throw new InvalidReservationError(
      `${originalAmount.currency} is held as ${reservedAmount.currency} with no rate to explain it`,
    );
  }

  if (!converted && fxRate !== null) {
    throw new InvalidReservationError(
      `a ${fxRate.base}/${fxRate.quote} rate is recorded although nothing was converted`,
    );
  }

  if (
    fxRate !== null &&
    (fxRate.base !== originalAmount.currency ||
      fxRate.quote !== reservedAmount.currency)
  ) {
    throw new InvalidReservationError(
      `rate ${fxRate.base}/${fxRate.quote} does not price ${originalAmount.currency} into ${reservedAmount.currency}`,
    );
  }
}

/**
 * Checked in `open` before {@link assertConversionReproducesHold}, so a
 * non-positive invoice always surfaces as `INVALID_RESERVATION`, never as
 * `applyRate`'s `INVALID_AMOUNT` depending on whether a rate was involved.
 */
function assertInvoiceable(originalAmount: Money): void {
  if (!originalAmount.isPositive()) {
    throw new InvalidReservationError(
      `an invoice must state a positive amount, got ${originalAmount.toString()}`,
    );
  }
}

/**
 * A hand-built {@link Conversion} (e.g. from a treasury message) is not
 * guaranteed to reproduce its own held amount, so it's recomputed with
 * `applyRate` — never an open-coded multiply, since the ceiling rounding
 * (docs/PLAN.md 2.3) is part of the answer.
 *
 * Only `open` asks this: a stored row is expected to drift from its rate after
 * a reconciliation correction, which keeps the original quote (docs/PLAN.md
 * 2.1, 2.3), so {@link Reservation.rehydrate} does not repeat this check.
 */
function assertConversionReproducesHold(amount: Conversion): void {
  const { original, converted, rate } = amount;

  if (rate === null) {
    if (!converted.equals(original)) {
      throw new InvalidReservationError(
        `${converted.toString()} was held for an invoice of ${original.toString()} with nothing converted`,
      );
    }

    return;
  }

  const reproduced = applyRate(original, rate);

  if (!converted.equals(reproduced)) {
    throw new InvalidReservationError(
      `rate ${rate.toDecimalString()} turns ${original.toString()} into ${reproduced.toString()}, not ${converted.toString()}`,
    );
  }
}

/**
 * Refused here rather than left to the first `outstandingAmount` subtraction,
 * so a corrupt row fails as `InvalidReservationError` on the way in, not as a
 * `CurrencyMismatchError` from an unrelated operation later.
 */
function assertReleasedCurrency(
  reservedAmount: Money,
  releasedAmount: Money,
): void {
  if (releasedAmount.currency !== reservedAmount.currency) {
    throw new InvalidReservationError(
      `${releasedAmount.toString()} was released against a hold stated in ${reservedAmount.currency}`,
    );
  }
}

/**
 * Not cosmetic: reconciliation (docs/PLAN.md 2.1) compares these instants
 * against a snapshot's `asOf`, and every comparison against `NaN` is `false`
 * — an unreadable timestamp would silently misclassify rather than fail loudly.
 */
function assertInstants(reservedAt: Date, releasedAt: Date | null): void {
  if (Number.isNaN(reservedAt.getTime())) {
    throw new InvalidReservationError('reservedAt must be a readable instant');
  }

  if (releasedAt === null) {
    return;
  }

  if (Number.isNaN(releasedAt.getTime())) {
    throw new InvalidReservationError('releasedAt must be a readable instant');
  }

  if (releasedAt.getTime() < reservedAt.getTime()) {
    throw new InvalidReservationError(
      `a hold cannot be released at ${releasedAt.toISOString()}, before it was taken at ${reservedAt.toISOString()}`,
    );
  }
}

/**
 * Exactly two loadable shapes (docs/PLAN.md 2.5): holding everything with no
 * release recorded, or holding nothing with when and why it was released. The
 * half-released row partial releases would introduce is refused here.
 */
function assertLifecycle(
  status: ReservationStatus,
  reservedAmount: Money,
  releasedAmount: Money,
  releasedAt: Date | null,
  releaseReason: ReleaseReason | null,
): void {
  if (status === 'RELEASED') {
    if (!releasedAmount.equals(reservedAmount)) {
      throw new InvalidReservationError(
        `a released hold gives back everything it held: ${releasedAmount.toString()} of ${reservedAmount.toString()}`,
      );
    }

    if (releasedAt === null || releaseReason === null) {
      throw new InvalidReservationError(
        'a released hold has to say when and why it was released',
      );
    }

    return;
  }

  if (!releasedAmount.isZero()) {
    throw new InvalidReservationError(
      `an active hold has given nothing back, but this one claims ${releasedAmount.toString()} of ${reservedAmount.toString()}`,
    );
  }

  if (releasedAt !== null || releaseReason !== null) {
    throw new InvalidReservationError(
      'an active hold cannot record when or why it was released',
    );
  }
}

/**
 * One invoice's hold on a program's capacity. Mutable, like `Program` and for
 * the same reason: the unit of work tracks the instance it handed out.
 *
 * Mutable state uses TypeScript-`private` fields, not `#private` — the
 * opposite of `FxRate`'s `#asOf` — because `EntitySchema` cannot see `#`
 * fields (docs/PLAN.md 2.6). `Date` getters still hand back clones.
 *
 * `reservedAmount` and `releasedAmount` are kept separately so the schema is
 * ready for partial releases; the domain is not, and refuses a stored row
 * where an active hold has given anything back (docs/PLAN.md 2.5).
 */
export class Reservation {
  /** Private: validation lives in the factories. */
  private constructor(
    readonly programId: string,
    readonly invoiceId: string,
    readonly originalAmount: Money,
    private _status: ReservationStatus,
    private _reservedAmount: Money,
    private _releasedAmount: Money,
    private _fxRate: FxRate | null,
    private _reservedAt: Date,
    private _releasedAt: Date | null,
    private _releaseReason: ReleaseReason | null,
  ) {}

  /**
   * Opens a new hold. Called by `Program.reserve` once it has decided there is
   * capacity — this class cannot see the limit.
   *
   * @throws {InvalidReservationError} if the identifiers are blank, either
   * amount is not positive, or the FX evidence does not match the amounts —
   * including a rate that does not reproduce the amount held.
   */
  static open(props: OpenReservationProps): Reservation {
    const { programId, invoiceId, amount, reservedAt } = props;
    const id = trimmedIdentifier(programId, 'program id');
    const invoice = trimmedIdentifier(invoiceId, 'invoice id');

    assertHoldable(amount.converted);
    assertFxEvidence(amount.original, amount.converted, amount.rate);
    assertInvoiceable(amount.original);
    assertConversionReproducesHold(amount);

    return new Reservation(
      id,
      invoice,
      amount.original,
      'ACTIVE',
      amount.converted,
      Money.zero(amount.converted.currency),
      amount.rate,
      // Cloned so the caller can't move the instant afterwards.
      new Date(reservedAt.getTime()),
      null,
      null,
    );
  }

  /**
   * Rebuilds a stored reservation: the same invariants as {@link open} plus
   * lifecycle consistency (`RELEASED` needs `releasedAt`/`releaseReason` and a
   * fully released amount; `ACTIVE` needs neither and nothing released).
   * Unlike {@link open}, does not require the conversion to still reproduce
   * the held amount — a reconciliation correction keeps the original quote
   * (docs/PLAN.md 2.1, 2.3) and would otherwise be unloadable.
   *
   * @throws {InvalidReservationError} if any of the above does not hold.
   */
  static rehydrate(state: ReservationState): Reservation {
    const {
      programId,
      invoiceId,
      status,
      originalAmount,
      reservedAmount,
      fxRate,
      reservedAt,
      releasedAt,
      releaseReason,
    } = state;

    const id = trimmedIdentifier(programId, 'program id');
    const invoice = trimmedIdentifier(invoiceId, 'invoice id');

    assertHoldable(reservedAmount);
    assertFxEvidence(originalAmount, reservedAmount, fxRate);

    const { releasedAmount } = state;

    assertReleasedCurrency(reservedAmount, releasedAmount);
    assertLifecycle(
      status,
      reservedAmount,
      releasedAmount,
      releasedAt,
      releaseReason,
    );
    assertInstants(reservedAt, releasedAt);

    return new Reservation(
      id,
      invoice,
      originalAmount,
      status,
      reservedAmount,
      releasedAmount,
      fxRate,
      new Date(reservedAt.getTime()),
      releasedAt === null ? null : new Date(releasedAt.getTime()),
      releaseReason,
    );
  }

  get status(): ReservationStatus {
    return this._status;
  }

  /** What this reservation holds, in the program's currency. */
  get reservedAmount(): Money {
    return this._reservedAmount;
  }

  /** Zero while the hold is active, the full amount once it is released. */
  get releasedAmount(): Money {
    return this._releasedAmount;
  }

  /** `reservedAmount − releasedAmount`, the quantity a release frees (docs/PLAN.md 2.4). */
  get outstandingAmount(): Money {
    return this._reservedAmount.subtract(this._releasedAmount);
  }

  /** Frozen at reservation time and never re-read (docs/PLAN.md 2.3). */
  get fxRate(): FxRate | null {
    return this._fxRate;
  }

  /** A clone, so a caller cannot mutate the stored instant. */
  get reservedAt(): Date {
    return new Date(this._reservedAt.getTime());
  }

  /** A clone; `null` while the reservation is active. */
  get releasedAt(): Date | null {
    return this._releasedAt === null
      ? null
      : new Date(this._releasedAt.getTime());
  }

  get releaseReason(): ReleaseReason | null {
    return this._releaseReason;
  }

  isActive(): boolean {
    return this._status === 'ACTIVE';
  }

  isReleased(): boolean {
    return this._status === 'RELEASED';
  }

  /** Whether this reservation was priced with a rate. */
  hasFxEvidence(): boolean {
    return this._fxRate !== null;
  }

  /**
   * Frees the hold, returning what it gave back so the program can adjust its
   * total by exactly that figure. Releasing an already-released reservation is
   * a no-op, not an error (`applied: false`, docs/PLAN.md 2.5) — release is
   * idempotent since REST and `InvoiceRepaid` may race for the same invoice.
   * The first release wins: a later `CANCELLED` doesn't overwrite a `REPAID`.
   *
   * Takes no amount, by design — see the note on partial releases on the class.
   */
  release(reason: ReleaseReason, releasedAt: Date): ReservationTransition {
    if (this.isReleased()) {
      return {
        delta: Money.zero(this._reservedAmount.currency),
        applied: false,
      };
    }

    const freed = this.outstandingAmount;

    this._releasedAmount = this._reservedAmount;
    this._status = 'RELEASED';

    // First release wins, stated where the stamping happens.
    if (this._releasedAt === null) {
      this._releasedAt = new Date(releasedAt.getTime());
    }

    if (this._releaseReason === null) {
      this._releaseReason = reason;
    }

    return { delta: freed.negate(), applied: true };
  }

  /**
   * Restates the held amount, returning the signed difference for the program
   * to apply to its reserved total ("treasury wins", docs/PLAN.md 2.1, 2.3).
   * May drive the amount up past the program's limit — that is recorded, not
   * refused. A no-op if the amount is unchanged. The original amount and rate
   * are left untouched: they are evidence of what was quoted.
   *
   * @throws {ReservationStateError} if the reservation is already released.
   * @throws {InvalidReservationError} if the corrected amount is not positive
   * (that would be a release, not a correction).
   * @throws {CurrencyMismatchError} if it is not in the currency this
   * reservation holds.
   */
  correctTo(correctedAmount: Money): ReservationTransition {
    if (this.isReleased()) {
      throw new ReservationStateError(this.invoiceId, this._status, 'correct');
    }

    if (correctedAmount.currency !== this._reservedAmount.currency) {
      throw new CurrencyMismatchError(
        'correct a hold',
        this._reservedAmount.currency,
        correctedAmount.currency,
      );
    }

    if (!correctedAmount.isPositive()) {
      throw new InvalidReservationError(
        `a corrected hold must consume capacity, got ${correctedAmount.toString()}`,
      );
    }

    const delta = correctedAmount.subtract(this._reservedAmount);

    if (delta.isZero()) {
      return { delta, applied: false };
    }

    this._reservedAmount = correctedAmount;

    return { delta, applied: true };
  }
}

import {
  InvalidReservationError,
  ReservationStateError,
} from './capacity-errors';
import { CurrencyMismatchError } from './errors';
import { Money } from './money';
import { applyRate, type Conversion } from '../../fx/convert';
import { type FxRate } from '../../fx/fx-rate';

/**
 * The lifecycle of a hold on a program's capacity (docs/PLAN.md 2.5).
 *
 * `ACTIVE → RELEASED`, and `RELEASED` is terminal. There is deliberately no
 * `EXPIRED` and no `PENDING`: expiry is out of scope (docs/PLAN.md 5), and a
 * reservation that is not yet holding capacity would be a hold that does not
 * hold, which answers nothing useful about a credit limit.
 */
export type ReservationStatus = 'ACTIVE' | 'RELEASED';

/**
 * Why a hold was freed.
 *
 * Both values free exactly the same capacity; they exist because risk and audit
 * need to tell them apart (docs/PLAN.md 2.5). `REPAID` is the normal end of an
 * invoice's life and treasury observed it; `CANCELLED` means the financing
 * never completed, and a program whose holds are mostly cancellations is
 * telling somebody something. Collapsing them into one flag would make that
 * question unanswerable from the log.
 */
export type ReleaseReason = 'REPAID' | 'CANCELLED';

/** What `Program.reserve` needs to open a new hold. */
export interface OpenReservationProps {
  readonly programId: string;
  readonly invoiceId: string;
  /**
   * The invoice amount as the client stated it, together with its conversion
   * into the program's currency and the rate that produced it (cycle 1's
   * `convert`). `rate` is `null` if and only if no conversion happened.
   */
  readonly amount: Conversion;
  readonly reservedAt: Date;
}

/**
 * A stored reservation, as one row of the table.
 *
 * Every field is a domain value rather than a column primitive: cycle 5 maps
 * `Money` and `FxRate` through `EntitySchema` custom types, so this is the shape
 * the mapper produces and the shape a test factory writes. It exists so that
 * rehydrating a reservation goes through the same invariant checks as creating
 * one, instead of a second, unchecked construction path.
 */
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
 * What a transition did to the program's reserved total.
 *
 * Returned instead of nothing so that `Program` never has to recompute a delta
 * the reservation already knows — recomputation is precisely how a release ends
 * up freeing a different figure than it held (docs/PLAN.md 2.3).
 */
export interface ReservationTransition {
  /**
   * Signed, in the program's currency: negative for a release, either sign for
   * a correction, zero when nothing changed.
   */
  readonly delta: Money;
  /**
   * `false` when the transition was a no-op — an already-released reservation
   * released again, or a correction to the amount it already holds. `Program`
   * reads this to decide whether there is anything to record.
   */
  readonly applied: boolean;
}

/**
 * Blank identifiers are refused wherever a reservation comes into existence,
 * and surrounding whitespace is removed rather than preserved: `(programId,
 * invoiceId)` is the natural key (docs/PLAN.md 2.5), so `" invoice-1"` and
 * `"invoice-1"` have to be one invoice and not two. Normalising at the boundary
 * of the domain, as cycle 1 does for `FxRate.source`, is what keeps the unique
 * constraint and the replay rule talking about the same string.
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
 * The FX fields are nullable *together* (docs/PLAN.md 2.3), and a rate that is
 * present has to be the very pair it claims to have converted. Checking this
 * wherever a reservation is built is what keeps a stored rate usable as
 * evidence: a row that survives this cannot describe a conversion that never
 * produced the amount next to it.
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
 * Whether the invoiced amount is an amount anybody could have invoiced.
 *
 * Checked in `open` **before** {@link assertConversionReproducesHold}, which is
 * the only reason it is a check of its own: `applyRate` refuses a negative
 * amount with cycle 1's `InvalidAmountError`, so without this the same
 * malformed request would come back as `INVALID_AMOUNT` when a rate happened to
 * be involved and `INVALID_RESERVATION` when it did not. The HTTP layer maps by
 * class (docs/PLAN.md 2.7), so one broken request would show a client two
 * different codes depending on whether the program's currency matched the
 * invoice's — which is not a distinction the client can act on.
 */
function assertInvoiceable(originalAmount: Money): void {
  if (!originalAmount.isPositive()) {
    throw new InvalidReservationError(
      `an invoice must state a positive amount, got ${originalAmount.toString()}`,
    );
  }
}

/**
 * Whether a conversion actually produces the amount it says it produces.
 *
 * A {@link Conversion} from cycle 1's `convert` always does, but `open` is
 * reached by callers that never went through it — cycle 3 assembles one from a
 * treasury message, and a hand-built object needs no cast to typecheck — so the
 * evidence is checked rather than trusted. Without this, an invoice stating
 * 100.00 USD can hold 999,000.00 USD of capacity and the audit entry records
 * both figures side by side, contradicting itself.
 *
 * Recomputed with `applyRate`, never with an open-coded multiply: the ceiling of
 * docs/PLAN.md 2.3 is part of the answer, and a truncating re-implementation
 * would reject the honest conversion of 0.01 USD at 0.9235 into 0.01 EUR. That
 * borrowed function has refusals of its own, which is why
 * {@link assertInvoiceable} runs first and must keep doing so.
 *
 * **Only `open` asks this.** A stored row is *expected* to drift from its rate:
 * a reconciliation correction restates the held amount and deliberately keeps
 * the original quote (docs/PLAN.md 2.1, 2.3), so re-checking this on
 * {@link Reservation.rehydrate} would make every corrected reservation
 * unloadable.
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
 * What has been given back is part of the same held sum as what is still held,
 * so both are stated in the currency of the hold — zero included.
 *
 * Refused here rather than left to the first `outstandingAmount` subtraction,
 * which is where a foreign-currency row would otherwise fail: that failure
 * arrives as a `CurrencyMismatchError` from an operation nobody asked for, long
 * after and far from the corrupt row that caused it. The row itself is what is
 * broken, so it is an `InvalidReservationError` and it is raised on the way in.
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
 * The instants a stored row carries have to be readable and in order.
 *
 * Not cosmetic: §2.1 decides whether a reservation missing from a snapshot is in
 * flight or a discrepancy by comparing its instant against the snapshot's
 * `asOf`, and every comparison against `NaN` is `false`. An unreadable timestamp
 * would therefore not fail loudly — it would quietly sort as "older than `asOf`"
 * and have the hold flagged. Released at the very instant it was reserved is
 * legal; released before it existed is not.
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
 * Whether the lifecycle fields agree with each other and with the amounts. A
 * row that fails this has been through no constructor — see
 * {@link Reservation.rehydrate}.
 *
 * There are exactly two loadable shapes, and they are the two this service can
 * produce (docs/PLAN.md 2.5): holding everything with no release recorded, or
 * holding nothing with when and why it was released. The half-released row in
 * between — the one partial releases would introduce — is refused here, which
 * is what keeps the scope boundary a property of the domain rather than a habit
 * of its callers.
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
 * One invoice's hold on a program's capacity.
 *
 * **Mutable, like `Program` and for the same reason.** Cycle 5 loads it inside
 * `em.transactional()` and MikroORM's unit of work flushes the changes it
 * observes on the instance it handed out; a method returning a new instance
 * would leave the tracked one untouched and the change would simply not be
 * written.
 *
 * Mutable state is held in TypeScript-`private` fields rather than `#private`
 * ones, which is the opposite of the choice `FxRate` made for its `#asOf`.
 * `FxRate` is a frozen value object and wanted the field invisible to
 * `{ ...rate }`; an entity has to be visible to its mapper. `#private` fields
 * are unreachable to `EntitySchema`, so the ORM could neither hydrate nor track
 * them. The `Date` getters still hand back clones, so a caller cannot reach in
 * and change a timestamp through the value it was given.
 *
 * **Amounts, and where partial releases stop.** `reservedAmount` and
 * `releasedAmount` are kept separately, so the schema stays ready for partial
 * releases: `outstandingAmount` is already the quantity the program holds, and
 * `release` already returns the delta it freed rather than a flag. The *domain*
 * is deliberately not ready, and says so — an active hold has given nothing
 * back, and a stored row claiming otherwise is refused on the way in
 * (docs/PLAN.md 2.5). Accepting a state this service cannot produce would mean
 * guarding behaviour nobody wrote and testing a feature that does not exist,
 * which is the usual way half a feature reaches production. Implementing
 * partial releases means loosening that rule deliberately, with their own tests
 * and audit semantics; until then `release` takes no amount, because the
 * extension point is the model and not unused surface.
 */
export class Reservation {
  /**
   * Private: validation lives in the factories, so a reservation can only come
   * into existence through a checked path.
   */
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
   * capacity — the aggregate root owns that decision, because this class cannot
   * see the limit.
   *
   * Checks everything about the reservation itself, so that an amount or an FX
   * record that contradicts itself can never reach the database:
   *
   * - the converted amount must be strictly positive (a zero-value hold
   *   consumes nothing and a negative one would create capacity),
   * - the rate must be `null` if and only if original and converted currencies
   *   are the same — the two FX fields are nullable *together* (docs/PLAN.md
   *   2.3), and an identity rate would record a quote nobody made,
   * - when a rate is present it must be the very pair it claims to have
   *   converted: `rate.base` the original currency, `rate.quote` the converted
   *   one,
   * - the invoiced amount must be positive too — nobody invoices nothing, and a
   *   negative invoice is not an exposure. `assertInvoiceable` states it here
   *   rather than leaving it to the recomputation below, so that one malformed
   *   request cannot surface as two different error codes,
   * - and the conversion must actually produce the amount it holds: with no
   *   rate the two amounts have to be equal, and with a rate the held amount
   *   has to be the one `applyRate` reproduces from the invoice. See
   *   `assertConversionReproducesHold`, which is deliberately not shared with
   *   {@link rehydrate}.
   *
   * Identifiers are trimmed, so padding cannot split one invoice into two.
   *
   * @throws {InvalidReservationError} if the identifiers are blank, either
   * amount is not positive, or the FX evidence does not match the amounts —
   * including a rate that does not reproduce the amount held. Every refusal in
   * this factory carries that one class, so the HTTP layer maps a malformed
   * reservation to one code no matter which part of it was malformed.
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
      // Cloned, so a caller that reuses its `Date` afterwards cannot move the
      // instant this hold was taken at.
      new Date(reservedAt.getTime()),
      null,
      null,
    );
  }

  /**
   * Rebuilds a stored reservation, applying the same invariants as
   * {@link open} plus the consistency of the lifecycle fields:
   *
   * - `RELEASED` requires `releasedAt`, a `releaseReason`, and a released
   *   amount equal to the reserved one,
   * - `ACTIVE` requires a released amount of zero and neither a `releasedAt`
   *   nor a `releaseReason` — the half-released row is refused, which is the
   *   scope boundary of docs/PLAN.md 2.5 and not a temporary simplification,
   * - the released amount is stated in the currency the reservation holds. A
   *   currency mismatch
   *   here is a corrupt row rather than an operation on two currencies, so it
   *   surfaces as an `InvalidReservationError` and not as a
   *   `CurrencyMismatchError`,
   * - the instants are readable and in order — see `assertInstants`, which is
   *   the one check `open` does not need, its `reservedAt` coming from a
   *   `CapacityChangeContext` the program has already vetted.
   *
   * What it deliberately does *not* re-apply is `open`'s demand that the
   * conversion still produce the held amount: a correction restates that amount
   * and keeps the original quote (docs/PLAN.md 2.1, 2.3), so a stored row is
   * expected to have drifted from its rate, and insisting otherwise would make
   * every corrected reservation unloadable.
   *
   * Note for cycle 5: MikroORM hydrates entities without calling the
   * constructor, so this is *not* on the ORM's path unless
   * `forceEntityConstructor` is set. That is deliberate — it is why every
   * mutating operation re-checks what it needs rather than trusting that
   * construction validated it, and it keeps this factory honest for the
   * mappers, factories and tests that do use it.
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

  /**
   * `reservedAmount − releasedAmount`: what the program's reserved total is
   * currently carrying on behalf of this invoice.
   *
   * The quantity a release frees and the one an integration test sums when it
   * checks `reserved_amount == SUM(active reservations)` (docs/PLAN.md 2.4).
   */
  get outstandingAmount(): Money {
    return this._reservedAmount.subtract(this._releasedAmount);
  }

  /**
   * The rate that priced this hold, or `null` when the invoice was already in
   * the program's currency.
   *
   * Frozen at reservation time and never re-read: a release frees the stored
   * amount rather than re-converting, because re-conversion makes the limit
   * drift over thousands of invoices (docs/PLAN.md 2.3).
   */
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

  /**
   * Whether this reservation was priced with a rate — equivalently, whether the
   * invoice was in a currency other than the program's.
   */
  hasFxEvidence(): boolean {
    return this._fxRate !== null;
  }

  /**
   * Frees the hold, returning what it gave back so the program can adjust its
   * total by exactly that figure and nothing recomputed.
   *
   * **Releasing an already-released reservation is a no-op, not an error.** The
   * transition comes back with a zero delta and `applied: false`, the stored
   * reason and timestamp are left as they are, and nothing changes. The reason
   * is docs/PLAN.md 2.5: release *is* idempotent, and a REST release may race
   * an `InvoiceRepaid` for the same invoice, with both arriving legitimately.
   * The alternative — throwing, and having the application layer catch the
   * exception to produce the `200` the plan requires — would make an expected,
   * routine race into an exception used for control flow, and would tempt every
   * call site to swallow a state error that in any other situation is a genuine
   * conflict. Keeping the decision in the domain means the rule is stated once,
   * here, and tested without a transaction. `Program.release` translates the
   * no-op into "no audit event", so a replay leaves no misleading second row in
   * the log.
   *
   * The first release wins: a `CANCELLED` arriving after a `REPAID` does not
   * rewrite why the capacity was freed. What was observed first is what
   * happened; the second observation is the duplicate.
   *
   * Takes no amount, by design — see the note on partial releases in the class
   * documentation.
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

    // First release wins, stated where the stamping happens. Both fields are
    // always empty here — an active hold may record neither, and a released one
    // returned above — so today this changes no outcome; it is kept because the
    // rule is the rule whichever path reaches it, and because a partial release
    // would arrive at exactly this line with the first release already
    // recorded.
    if (this._releasedAt === null) {
      this._releasedAt = new Date(releasedAt.getTime());
    }

    if (this._releaseReason === null) {
      this._releaseReason = reason;
    }

    return { delta: freed.negate(), applied: true };
  }

  /**
   * Restates the held amount to what treasury says it is, returning the signed
   * difference for the program to apply to its reserved total (docs/PLAN.md
   * 2.1, 2.3: "treasury wins; adjust and write an audit entry").
   *
   * Drives the held amount up as readily as down; an upward correction may take
   * the program past its limit, and that is an outcome to record rather than
   * refuse — the exposure already exists, refusing to write it down would only
   * hide it. Cycle 3's reconciliation function is what decides when to call
   * this.
   *
   * A correction to the amount already held is a no-op with `applied: false`,
   * so a snapshot that repeats an unchanged invoice every few minutes does not
   * fill the audit log with adjustments that adjusted nothing.
   *
   * The original amount and the stored rate are left untouched: they are the
   * evidence of what was quoted, and a correction does not retroactively change
   * what the rate was. The correction is the new truth about exposure, not a
   * new conversion.
   *
   * @throws {ReservationStateError} if the reservation is already released — it
   * holds nothing, so there is no exposure to correct. Treasury correcting an
   * invoice we consider closed is a discrepancy for cycle 3 to flag, not a
   * capacity change.
   * @throws {InvalidReservationError} if the corrected amount is not positive:
   * a hold restated to nothing is not a correction but a release, and it is the
   * one shape {@link rehydrate} would refuse to load back.
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

    // An active hold has given nothing back (docs/PLAN.md 2.5), so "still holds
    // something" is simply "positive": a correction to zero or below would
    // leave an active reservation holding nothing, which is the one shape
    // `rehydrate` refuses.
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

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
  /**
   * The organisation the program belongs to — the `org` claim a token has to
   * match (docs/PLAN.md 2.7).
   */
  readonly ownerOrgId: string;
  /** The currency the limit, the reserved total and every hold are stated in. */
  readonly currency: CurrencyCode;
  readonly creditLimit: Money;
}

/**
 * A stored program, as one row of the table. Includes the denormalized reserved
 * total, which {@link ProgramProps} does not: a new program has reserved
 * nothing, and letting a caller state otherwise would be an invitation to
 * create a program that starts out disagreeing with its own reservations.
 */
export interface ProgramState extends ProgramProps {
  /**
   * The sum of what every active reservation holds (docs/PLAN.md 2.4). Never
   * negative, mirroring `CHECK (reserved_amount >= 0)`; it may however exceed
   * the credit limit, which is what an over-utilised program is.
   */
  readonly reserved: Money;
}

/** What `Program.reserve` is asked for. */
export interface ReservationRequest {
  /**
   * Unique **within this program**, not globally (docs/PLAN.md 2.9): a client
   * should not have to encode program identity into its own identifiers. The
   * domain therefore never treats an invoice id as an address on its own, and
   * `(programId, invoiceId)` is the key everywhere — including the unique
   * constraint cycle 5 adds.
   */
  readonly invoiceId: string;
  /**
   * The invoice amount and its conversion into the program currency, as cycle
   * 1's `convert` produced it. The conversion happens *before* the domain is
   * called, because it is I/O (the `FxRateProvider` port) and the aggregate is
   * pure; what reaches here is the frozen result, which is exactly what the
   * reservation stores.
   */
  readonly amount: Conversion;
}

/**
 * What a call site receives from an operation that touched a reservation.
 *
 * **Decision: one value carrying everything the change produced.** A
 * reservation moves two pieces of state at once — the reservation itself and
 * the program's denormalized total — and produces one audit fact. Cycle 5 has
 * to persist all three inside a single `em.transactional()` (docs/PLAN.md 2.4),
 * and anything it has to re-derive there is a chance to derive it differently.
 * So: the reservation comes back as an object reference (`Program` mutates
 * itself, so the program needs no returning — the caller is holding the very
 * instance the unit of work is tracking), and the event comes back fully
 * formed.
 *
 * `event` is `null` exactly when nothing changed. That single convention covers
 * every idempotent path the plan requires — a replayed reservation, a repeated
 * release, a correction to the amount already held, a limit "change" to the
 * limit already set — and it maps straight onto the HTTP contract of
 * docs/PLAN.md 2.5: an event means `201`/a change, `null` means `200` with the
 * current state. It also keeps the audit log free of rows recording that
 * nothing happened.
 */
export interface ReservationChange {
  readonly reservation: Reservation;
  readonly event: CapacityEvent | null;
}

/** As {@link ReservationChange}, for an operation that touches no invoice. */
export interface LimitChange {
  readonly event: CapacityEvent | null;
}

/**
 * Blank identifiers are refused wherever a program comes into existence, and
 * padding is removed rather than stored.
 *
 * The owning organisation is the reason this matters: a token's `org` claim is
 * matched against it (docs/PLAN.md 2.7) and a failed match answers `404`, so a
 * program stored as `"  org-1  "` would tell its rightful owner that it does
 * not exist — the least debuggable outcome available.
 */
function trimmedIdentifier(value: string, what: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new InvalidProgramError(`${what} must not be blank`);
  }

  return trimmed;
}

/**
 * The same normalisation for the invoice a request names, refused as a broken
 * reservation rather than as a broken program: `(programId, invoiceId)` is the
 * natural key, and the request has to arrive at `Reservation.open`, at the
 * duplicate comparison and in the audit entry as one and the same string.
 */
function trimmedInvoiceId(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new InvalidReservationError('invoice id must not be blank');
  }

  return trimmed;
}

/**
 * The metadata with every absent field dropped rather than left present and
 * `undefined`.
 *
 * The aggregate states its facts by writing them over whatever the caller
 * supplied, which means writing `undefined` for a field it knows does not apply
 * — an unconverted reservation has no rate. `JSON.stringify` would drop such a
 * key, but a persistence layer iterating `Object.keys` would write `fxRate:
 * null` into jsonb, recording that a rate was looked for and missing rather
 * than that none was ever needed (docs/PLAN.md 2.3). The absence is the
 * evidence, so it is stored as an absence.
 */
function withoutAbsentFields(
  metadata: CapacityEventMetadata,
): CapacityEventMetadata {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

/**
 * A limit is refused for being negative or foreign, never for being smaller
 * than what is already reserved — see {@link Program.changeCreditLimit}.
 */
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

/**
 * Refuses a change nobody could be held to account for, before any state moves
 * (docs/PLAN.md 2.8). `source` needs no check: it is a closed union, and a
 * value outside it cannot be built without deliberately defeating the compiler.
 */
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
 * and the rules for consuming it.
 *
 * **The aggregate root.** Every capacity change goes through a method here,
 * even those whose state machine lives on `Reservation`, because the reserved
 * total and the reservation have to move together or not at all. A caller that
 * could release a reservation directly would be a caller that can leave the
 * denormalized counter wrong.
 *
 * **What it does not hold.** Not a collection of reservations. The counter is
 * denormalized precisely so that availability is an O(1) read of one locked row
 * (docs/PLAN.md 2.4); loading the invoices to answer "can this be funded?"
 * would defeat the design at exactly the moment it matters. The consequence is
 * that this class cannot detect a duplicate invoice by itself, which is why
 * {@link reserve} is *handed* the existing reservation — see there.
 *
 * **Decision: it mutates; it does not return a new instance.** Cycle 5 reads it
 * with `LockMode.PESSIMISTIC_WRITE` inside `em.transactional()` and lets the
 * unit of work flush it (docs/PLAN.md 2.4, 2.6). MikroORM tracks the identity
 * of the instance it handed out: a persistent value object returning a fresh
 * `Program` would leave the tracked entity unchanged, and the write would
 * simply not happen unless every call site remembered to merge the copy back.
 * That is a footgun with no compensating benefit here — the instance never
 * escapes the transaction that locked it, so the usual argument for
 * immutability (shared mutable state) does not apply, while the usual argument
 * against (a silently lost update) very much does. `Money` stays immutable
 * underneath, so the amounts themselves cannot be changed in place.
 *
 * **Tenancy.** The program carries `ownerOrgId` and can answer whether it
 * belongs to an organisation; it does not decide what to do about the answer.
 * Turning "not yours" into a `404` rather than a `403` is an HTTP decision
 * (docs/PLAN.md 2.7) and lives in the guard, and a domain that threw
 * "not found" would be a domain that knows about disclosure policy.
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
   * Opens a program with nothing reserved.
   *
   * @throws {InvalidProgramError} if the identifier or the owning organisation
   * is blank.
   * @throws {InvalidCreditLimitError} if the limit is negative or is not in the
   * program's currency. Zero is accepted: it is how a program is suspended
   * without being deleted, and it simply refuses every reservation.
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
   * As with `Reservation.rehydrate`, MikroORM bypasses the constructor when it
   * hydrates, so this is the domain's own path rather than the ORM's — and the
   * reason the operations re-check what they depend on instead of assuming
   * construction did.
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

    // `CHECK (reserved_amount >= 0)` in the schema (docs/PLAN.md 2.4). Note
    // what is deliberately not checked: that the limit covers the reserved
    // total. An over-utilised program has to load, report and release.
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

  /**
   * `creditLimit − reserved`.
   *
   * **May be negative, and is never clamped** (docs/PLAN.md 2.1). A limit
   * reduced below current exposure, or a reconciliation correction upward,
   * leaves the program over-utilised; that is a state to store, report and act
   * on — refuse new reservations, keep accepting releases — not an impossible
   * one to round away. Clamping at zero here would make `available` and
   * `creditLimit − reserved` two different numbers and hide the overrun from
   * every reader, including the alert on it.
   */
  get available(): Money {
    return this._creditLimit.subtract(this._reserved);
  }

  /**
   * Whether exposure exceeds the limit: `available` is strictly negative.
   *
   * Exactly zero available is an exhausted program, not an over-utilised one —
   * it is fully drawn and behaving exactly as agreed.
   */
  get overUtilized(): boolean {
    return this.available.isNegative();
  }

  /**
   * Whether this program belongs to `orgId`. A predicate, not a guard: see the
   * note on tenancy in the class documentation.
   */
  isOwnedBy(orgId: string): boolean {
    return this.ownerOrgId === orgId;
  }

  /**
   * Whether `amount` would fit: `available >= amount`.
   *
   * Exposed separately from {@link reserve} because a quote or a dry run should
   * not have to provoke an exception to ask. An amount exactly equal to
   * available fits — the limit is the maximum concurrent exposure, not one
   * minor unit below it.
   *
   * @throws {CurrencyMismatchError} if `amount` is not in the program's
   * currency. Ordering two currencies is meaningless (cycle 1's `Money`), and
   * answering `false` would look like a business decision rather than the bug
   * it is.
   */
  hasCapacityFor(amount: Money): boolean {
    this.assertProgramCurrency('weigh an amount against the limit', amount);

    return this.available.isGreaterThanOrEqual(amount);
  }

  /**
   * Holds capacity for an invoice.
   *
   * `existing` is the reservation this program already has for
   * `request.invoiceId`, or `null` — the application layer looks it up by the
   * natural key inside the same locked transaction, which it must do anyway for
   * idempotency. Passing it in is what lets the duplicate *rule* live in the
   * domain, where it is stated once and tested without a database, while the
   * unique constraint on `(program_id, invoice_id)` stays the backstop for the
   * race the lock cannot cover (docs/PLAN.md 2.5, 2.9). The domain decides what
   * a duplicate means; the database enforces that the decision was not made on
   * stale data.
   *
   * With `existing`:
   * - active and for the same original amount → a replay: the stored
   *   reservation is returned with no event and nothing changes. Comparison is
   *   against the *original* amount, the payload the client actually sent, not
   *   the converted one: the rate is frozen at reservation time (docs/PLAN.md
   *   2.3), so a replay hours later converts differently and must still be
   *   recognised as the same request rather than re-priced.
   * - active and for a different amount → `409`.
   * - released → `409`. Re-reserving a released invoice is refused
   *   (docs/PLAN.md 2.5); an invoice is financed exactly once, and the natural
   *   key is what says so.
   *
   * @throws {ReservationNotInProgramError} if `existing` belongs to another
   * program or another invoice.
   * @throws {DuplicateInvoiceError} on a conflicting or released duplicate.
   * @throws {InsufficientCapacityError} if the converted amount exceeds
   * `available` — including on an over-utilised program, where availability is
   * already negative and every reservation is refused until it recovers.
   * @throws {InvalidReservationError} if the invoice id is blank, the amount
   * is not positive, or the conversion's rate does not match the currencies it
   * claims to have converted — FX evidence that contradicts its own amounts is
   * a broken reservation rather than an operation on two currencies, and
   * `Reservation.open` is where that is stated.
   * @throws {CurrencyMismatchError} if the conversion did not land in this
   * program's currency. Only the program's currency consumes the program's
   * limit; a mismatch here is a wiring bug, and refusing it at the aggregate is
   * what makes it impossible to persist.
   * @throws {MissingAuditContextError} if the change is not attributable.
   */
  reserve(
    request: ReservationRequest,
    existing: Reservation | null,
    context: CapacityChangeContext,
  ): ReservationChange {
    assertAttributable(context);

    // Judged before the duplicate rule, and normalised once for everything
    // downstream: the same request cannot be valid or invalid depending on
    // whether it has been seen before, and the invoice it names has to reach
    // the comparison below, the opened hold and the audit entry as one string.
    const invoiceId = trimmedInvoiceId(request.invoiceId);

    this.assertProgramCurrency(
      'reserve against this program',
      request.amount.converted,
    );

    if (existing !== null) {
      return this.resolveDuplicate(invoiceId, request.amount, existing);
    }

    // Opened before the capacity test, so that a request that could never be a
    // reservation is rejected as one rather than as an amount the program
    // happens to have room for.
    const reservation = this.openHold(invoiceId, request.amount, context);
    const held = reservation.reservedAmount;

    // The line that separates this operation from
    // {@link recordTreasuryHold}, and the only one.
    if (!this.available.isGreaterThanOrEqual(held)) {
      throw new InsufficientCapacityError(this.id, held, this.available);
    }

    return this.recordHold(reservation, context);
  }

  /**
   * Records a hold for an invoice **treasury reports**, whether or not the
   * program has room for it (docs/PLAN.md 2.1).
   *
   * This is reconciliation's counterpart to {@link reserve}, and the *only*
   * difference between them is the limit: there is no capacity check here, so
   * the hold is recorded and the program is left over-utilised rather than the
   * exposure being refused. The exposure exists in treasury regardless of what
   * this service has room for; refusing it would mean reporting less risk than
   * the funder actually carries, which is the one direction this service must
   * never err in. Everything else — the amount, the FX evidence, the currency,
   * the identifiers, the attribution — is checked exactly as strictly, because
   * none of those become less true for having come from a snapshot.
   *
   * **Two named operations rather than one with a flag.** A
   * `reserve(request, existing, context, { enforceLimit })` would put the entire
   * point of this module behind a boolean that any call site can get wrong, and
   * the wrong value is silent: the limit simply stops applying and nothing fails
   * a test. A separate name cannot be reached by accident from an HTTP handler,
   * it greps as a closed set of call sites, and a reviewer asking "what can
   * breach the limit?" gets a complete answer from the method's callers.
   *
   * **A duplicate is refused outright, not replayed.** `existing` must be
   * `null`: reconciliation produces this step only for an invoice with no
   * reservation at all (see `treasury-sync/domain/reconcile-program.ts`), so a
   * non-null `existing` means the plan was computed against a program state that
   * has since changed, or the caller is wired wrong. Neither is a retry to be
   * smoothed over. {@link reserve} replays an identical request because an HTTP
   * client legitimately resends one; a snapshot never resends a single invoice,
   * it is re-evaluated in full against current state, so the idempotency
   * argument does not transfer. Replaying here would report success for a plan
   * that no longer matches reality and quietly skip the correction the new state
   * needs, where failing the transaction is visible — the message is redelivered
   * or reaches the DLQ, and the next snapshot heals the state (docs/PLAN.md
   * 2.2). The parameter is kept rather than dropped so the duplicate rule stays
   * in the domain, where cycle 2 put it, instead of resting on a unique
   * constraint firing at `flush()`.
   *
   * **The audit entry is `RESERVED`.** A new hold appeared and capacity was
   * consumed; the row in the reservations table is indistinguishable from a
   * client's, and `actor` (`treasury:kafka`) with `source`
   * (`TREASURY_SNAPSHOT`) is what says who caused it — the event *type*
   * describes what happened to capacity, the *source* describes how it arrived.
   * That is already the contract's rule elsewhere: `changeCreditLimit` emits
   * `LIMIT_CHANGED` for the admin API and for `ProgramLimitChanged` alike rather
   * than splitting the type by channel. `RECONCILIATION_ADJUSTMENT` was the
   * alternative and loses twice: it means an existing hold's amount was
   * restated, so it has a `previousReservedAmount` to name and this has none,
   * and using it would break the property that every reservation in the database
   * has a `RESERVED` event behind it — the property cycle 5's integration test
   * relies on when it reconstructs the reserved total from the log.
   * `RECONCILIATION_APPLIED` is the snapshot-level fact, with no invoice and no
   * delta, and belongs to cycle 8.
   *
   * @throws {DuplicateInvoiceError} if `existing` is not `null`.
   * @throws {ReservationNotInProgramError} if `existing` belongs to another
   * program or another invoice — reported ahead of the duplicate, because a row
   * this program never owned is a wiring fault and not treasury's news.
   * @throws {InvalidReservationError} if the invoice id is blank, either amount
   * is not positive, or the conversion does not reproduce the hold it claims.
   * @throws {CurrencyMismatchError} if the conversion did not land in this
   * program's currency. Only the program's currency consumes its limit, and a
   * snapshot cannot be allowed to state exposure in another one.
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
   * Frees the capacity a reservation holds, reducing the reserved total by
   * **exactly the amount that was held** and never by a recomputed one
   * (docs/PLAN.md 2.3). For a converted invoice this is the amount the frozen
   * rate produced at reservation time, whatever today's rate says.
   *
   * Works on an over-utilised program: releases are the way back from an
   * overrun, and refusing them there would leave a program that reduced its
   * limit unable to ever recover (docs/PLAN.md 2.1).
   *
   * A repeated release is a no-op and produces no event — see
   * `Reservation.release` for why the domain, not the caller, owns that rule.
   *
   * @throws {ReservationNotInProgramError} if the reservation belongs to
   * another program.
   * @throws {CurrencyMismatchError} if it holds an amount in another currency.
   * @throws {CapacityInvariantError} if freeing it would drive the reserved
   * total below zero, which means the counter and the reservations disagree.
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

    // Checked before the reservation moves: `Reservation.release` mutates as
    // soon as it is called, and a counter that disagrees with its reservations
    // must leave both sides untouched rather than be clamped into agreement.
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
   * total — the "treasury wins; adjust and write an audit entry" rule of
   * docs/PLAN.md 2.1, and the operation cycle 3's reconciliation drives.
   *
   * The correction may push the program past its limit and leave it
   * over-utilised. That is accepted deliberately: the exposure is real
   * regardless of what this service previously recorded, and the point of
   * reconciliation is to make the stored state match it. Refusing would keep a
   * comfortable number in the database and an uncomfortable one in reality.
   *
   * A later release then frees the corrected amount, because that is what the
   * reservation holds by then.
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
    // Only a correction `correctTo` will actually apply says anything about the
    // total, and asking that first is what keeps the two failures apart. A
    // released hold no longer counts towards the reserved total, so *any*
    // projection for one is short by the whole amount and a downward correction
    // would trip the invariant guard — reporting a corrupt counter where
    // docs/PLAN.md 2.5 requires a state conflict for reconciliation to flag,
    // and cycle 3 branches on exactly that difference. A non-positive amount is
    // likewise none of the counter's business: `correctTo` refuses it as a
    // correction that is not one.
    const willApply = reservation.isActive() && correctedAmount.isPositive();

    if (willApply) {
      // Computed before `correctTo` mutates anything, for the reason given in
      // `release`. An active hold has given nothing back (docs/PLAN.md 2.5), so
      // what it contributes to the total is exactly what it holds, and the
      // correction replaces that contribution with the new figure.
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
   * Sets a new credit limit. Treasury owns the limit (docs/PLAN.md 2.1), so
   * this is how a `ProgramLimitChanged` message and the admin API both land.
   *
   * The reserved total is untouched: a limit change moves what was agreed, not
   * what is outstanding. Reducing the limit below current exposure is therefore
   * legal and leaves the program over-utilised — refusing the reduction would
   * mean this service could veto a funder's own risk decision, and the exposure
   * would not go away for being unrecorded.
   *
   * The emitted event has a `delta` of zero, since no capacity moved; the two
   * limits travel in its metadata. See `CapacityEvent.delta` for why the column
   * is not repurposed.
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

  /**
   * Answers the duplicate rule of docs/PLAN.md 2.5 for an invoice this program
   * already knows, without ever touching the reserved total: whatever the
   * outcome, the capacity is already held.
   */
  /**
   * Opens the hold a request asks for, in this program and at the caller's
   * instant.
   *
   * Shared by {@link reserve} and {@link recordTreasuryHold} so that the two
   * cannot drift on what they create — the program it belongs to and the
   * timestamp it carries are decided once. `Reservation.open` is what refuses a
   * hold whose amounts or FX evidence contradict themselves, which is why
   * neither operation checks any of that for itself.
   */
  private openHold(
    invoiceId: string,
    amount: Conversion,
    context: CapacityChangeContext,
  ): Reservation {
    return Reservation.open({
      programId: this.id,
      invoiceId,
      amount,
      // The caller's single reading of the clock, so the row and its audit
      // entry cannot disagree about when the hold was taken.
      reservedAt: context.occurredAt,
    });
  }

  /**
   * Applies a newly opened hold to the reserved total and produces the audit
   * fact for it.
   *
   * The half of a new reservation that is identical whether a client asked for
   * it or a snapshot reported it, kept in one place because this is where the
   * two paths must never diverge: the counter moves by exactly what the hold
   * holds, and the entry is `RESERVED` either way — the type says what happened
   * to capacity, `actor` and `source` say how it arrived. What is deliberately
   * *not* here is the limit, which is the one thing the two paths disagree
   * about, so the difference stays visible in their own bodies instead of behind
   * a parameter.
   *
   * The metadata is read off the reservation rather than off the request, so the
   * entry describes the row that was actually created.
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

    // Judged on the amount the client stated, never on the converted one: the
    // rate was frozen when the hold was taken (docs/PLAN.md 2.3), so a replay
    // hours later prices differently and would otherwise read as a conflict.
    if (!existing.originalAmount.equals(amount.original)) {
      throw new DuplicateInvoiceError(
        this.id,
        invoiceId,
        `it is held for ${existing.originalAmount.toString()}, not ${amount.original.toString()}`,
      );
    }

    return { reservation: existing, event: null };
  }

  /**
   * Whether a reservation handed over is the one the request actually
   * addresses: this program's, and this invoice's.
   *
   * A row for another invoice is the same fault as a row from another program —
   * the application layer looked up something the request does not name — so it
   * carries the same error, naming the row it handed over. Both paths ask this
   * before reading anything else off the row, because a wiring fault is not a
   * business outcome and must not be reported as one.
   */
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

  /**
   * A reservation handed to the wrong program would free or hold capacity
   * against somebody else's limit, and nothing downstream would explain the
   * gap.
   */
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

  /**
   * The audit fact for a change that has just been applied: the aggregate
   * states what it computed, the caller's context supplies what it could not
   * know, and `metadata` from the caller is annotation that its own fields
   * overrule (docs/PLAN.md 2.8).
   */
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

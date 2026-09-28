import { BigIntType, EntitySchema, type EntityClass } from '@mikro-orm/core';

import { moneyAmount } from './money-amount.type';
import { InvalidReservationError } from '../../domain/capacity-errors';
import { type CurrencyCode } from '../../domain/currency';
import { type Money } from '../../domain/money';
import {
  Reservation,
  type ReleaseReason,
  type ReservationStatus,
} from '../../domain/reservation';
import { FxRate } from '../../../fx/fx-rate';

/**
 * The FX evidence of a hold, spread over six nullable columns.
 *
 * **Six columns rather than one `jsonb`**, because docs/PLAN.md 2.3 makes the rate
 * *evidence*: "why is 92,300 EUR held for a 100,000 USD invoice?" is answered by a
 * query, and a reviewer reading the row should not have to know a JSON layout to
 * read a rate. `scale` is one of them — the plan's original list forgot it, while
 * `FxRate.fromSnapshot` refuses a row whose scale is not the scale this build
 * guarantees, which is the entire point of storing it: a rate written under a
 * different precision is then detectable instead of being silently reinterpreted
 * by a factor of ten.
 *
 * **They are nullable together** (docs/PLAN.md 2.3), and the database says so:
 * `CHECK (num_nulls(...) IN (0, 6))`. An invoice already in the program's currency
 * is never converted and has no rate, and an identity rate would record a quote
 * nobody made; a half-filled group is neither state and cannot be stored.
 *
 * **They are insert-only.** No domain operation changes a stored rate — a release
 * frees the amount the frozen rate produced, and a reconciliation correction
 * deliberately keeps the original quote (docs/PLAN.md 2.1, 2.3). That is what lets
 * the repository project them once, when the hold is added, instead of the mapping
 * needing a flush hook.
 */
export interface FxEvidenceColumns {
  fxBase: string | null;
  fxQuote: string | null;
  fxScaledValue: bigint | null;
  fxScale: number | null;
  fxSource: string | null;
  fxAsOf: Date | null;
}

/**
 * The shape of one `reservations` row.
 *
 * As with `StoredProgram`, the underscored keys are the aggregate's
 * TypeScript-`private` fields, mapped because a `private` member is an ordinary
 * own property at runtime (docs/PLAN.md 2.6).
 *
 * **Two currencies, and why neither is redundant.** A reservation states an amount
 * in the invoice's currency and holds an amount in the program's, so
 * `original_currency` and `held_currency` are two different facts —
 * `assertFxEvidence` reads exactly this difference to decide whether a rate is
 * required. `released_amount` shares `held_currency`, because what was given back
 * is part of the same held sum as what is still held (`assertReleasedCurrency`
 * refuses anything else), so a third currency column would only be a way for a row
 * to contradict itself.
 *
 * `held_currency` duplicates `programs.currency` on purpose: a reservation has to
 * be loadable, summable and checkable without joining its program, which is what
 * the reconciliation drift check does over hundreds of rows. Making the duplication
 * unfalsifiable would take a composite foreign key that MikroORM cannot express —
 * see `program.mapping.ts` for why that was rejected rather than smuggled into the
 * migration.
 */
export interface StoredReservation extends FxEvidenceColumns {
  programId: string;
  invoiceId: string;
  originalAmount: Money;
  originalCurrency: CurrencyCode;
  _status: ReservationStatus;
  _reservedAmount: Money;
  _releasedAmount: Money;
  heldCurrency: CurrencyCode;
  _reservedAt: Date;
  _releasedAt: Date | null;
  _releaseReason: ReleaseReason | null;
}

/**
 * `reservations`.
 *
 * ## The key is natural, and it is the primary key
 *
 * `(program_id, invoice_id)` is the idempotency key of docs/PLAN.md 2.5 and the
 * uniqueness rule of 2.9 — an invoice is financed exactly once, within a program
 * and not globally. It is therefore the **primary key** rather than a unique index
 * beside a surrogate id: the domain has no reservation identifier, nothing
 * references a reservation by one, and a surrogate would be a second identity for
 * a row that already has one. A violation surfaces at `flush()` as a
 * `UniqueConstraintViolationException` and maps to `409` (docs/PLAN.md 2.6) — the
 * backstop for the race the row lock cannot cover, since a lock on a program row
 * cannot serialize the first two reservations that both find no existing hold.
 *
 * ## Constraints
 *
 * - `CHECK (reserved_amount > 0)` — `assertHoldable`: a hold that consumes nothing,
 *   or creates capacity, is not a hold.
 * - `CHECK (released_amount >= 0)`.
 * - `CHECK (num_nulls(fx_*) IN (0, 6))` — the FX group is nullable together.
 * - `CHECK (fx_scaled_value > 0)` — `FxRate.of` refuses a non-positive rate.
 * - the lifecycle check: `ACTIVE` gives nothing back and records neither when nor
 *   why; `RELEASED` gives back exactly what it held and records both. These are
 *   the only two shapes this service can produce, and `Reservation.rehydrate`
 *   refuses the half-released row in between — the scope boundary of docs/PLAN.md
 *   2.5 for partial releases, stated in DDL so that it cannot be reached by a
 *   future code path either.
 * - `CHECK (released_at >= reserved_at)` — a hold cannot be released before it was
 *   taken. `assertInstants` says the same thing; in the column it also means the
 *   in-flight comparison of docs/PLAN.md 2.1 can never be fed a row whose
 *   timestamps run backwards.
 * - the foreign key on `program_id`. It comes from mapping the column as a
 *   `mapToPk` relation: the property stays the plain `string` the aggregate
 *   declares — aggregates reference each other by identity, never by object graph
 *   (docs/PLAN.md 3) — while MikroORM emits and diffs the constraint itself, which
 *   a hand-written `alter table` in the migration could not be.
 *
 * ## The index
 *
 * `(program_id, status)` serves the two reads cycle 5 and cycle 8 make: the active
 * holds of one program, and its whole reservation set. The primary key already
 * serves the lookup by invoice.
 */
export const reservationSchema = new EntitySchema<StoredReservation>({
  class: Reservation as unknown as EntityClass<StoredReservation>,
  tableName: 'reservations',
  // See `program.mapping.ts` and `DomainHydrator`: the constructor validates
  // nothing, so forcing it would add a call and no guarantee.
  forceConstructor: false,
  properties: {
    programId: {
      kind: 'm:1',
      entity: () => 'Program',
      mapToPk: true,
      primary: true,
      fieldName: 'program_id',
      updateRule: 'cascade',
      deleteRule: 'restrict',
    },
    invoiceId: {
      type: 'string',
      length: 128,
      primary: true,
      fieldName: 'invoice_id',
    },
    _status: {
      enum: true,
      items: ['ACTIVE', 'RELEASED'],
      fieldName: 'status',
    },
    originalAmount: { type: moneyAmount, fieldName: 'original_amount' },
    originalCurrency: {
      type: 'string',
      length: 3,
      fieldName: 'original_currency',
    },
    _reservedAmount: { type: moneyAmount, fieldName: 'reserved_amount' },
    _releasedAmount: { type: moneyAmount, fieldName: 'released_amount' },
    heldCurrency: { type: 'string', length: 3, fieldName: 'held_currency' },
    fxBase: { type: 'string', length: 3, nullable: true, fieldName: 'fx_base' },
    fxQuote: {
      type: 'string',
      length: 3,
      nullable: true,
      fieldName: 'fx_quote',
    },
    fxScaledValue: {
      type: new BigIntType(),
      nullable: true,
      fieldName: 'fx_scaled_value',
    },
    fxScale: { type: 'smallint', nullable: true, fieldName: 'fx_scale' },
    fxSource: {
      type: 'string',
      length: 64,
      nullable: true,
      fieldName: 'fx_source',
    },
    fxAsOf: { type: 'datetime', nullable: true, fieldName: 'fx_as_of' },
    _reservedAt: { type: 'datetime', fieldName: 'reserved_at' },
    _releasedAt: { type: 'datetime', nullable: true, fieldName: 'released_at' },
    _releaseReason: {
      enum: true,
      items: ['REPAID', 'CANCELLED'],
      nullable: true,
      fieldName: 'release_reason',
    },
  },
  indexes: [
    {
      name: 'reservations_program_id_status_index',
      properties: ['programId', '_status'],
    },
  ],
  checks: [
    {
      name: 'reservations_reserved_amount_positive',
      expression: 'reserved_amount > 0',
    },
    {
      name: 'reservations_released_amount_non_negative',
      expression: 'released_amount >= 0',
    },
    {
      name: 'reservations_fx_evidence_complete',
      // Written with `= any(array[…])` rather than `in (…)`: Postgres stores the
      // former, and the schema-drift test compares what the mapping declares with
      // what the database reports (see `schema.spec.ts`).
      expression:
        'num_nulls(fx_base, fx_quote, fx_scaled_value, fx_scale, fx_source, fx_as_of) = any(array[0, 6])',
    },
    {
      name: 'reservations_fx_scaled_value_positive',
      expression: 'fx_scaled_value is null or fx_scaled_value > 0',
    },
    {
      name: 'reservations_lifecycle',
      expression:
        "(status = 'ACTIVE' and released_amount = 0 and released_at is null and release_reason is null) or (status = 'RELEASED' and released_amount = reserved_amount and released_at is not null and release_reason is not null)",
    },
    {
      name: 'reservations_released_after_reserved',
      expression: 'released_at is null or released_at >= reserved_at',
    },
  ],
});

/**
 * Reads an {@link FxRate} back from its six columns, through the domain's own
 * factory.
 *
 * `FxRate.fromSnapshot` is what refuses a rate stored under a different scale, a
 * non-integer value, an unsupported currency code or an unreadable instant — the
 * faults the columns themselves cannot express. Going through it rather than the
 * constructor is the whole reason the mapping has a hydrator (see
 * {@link DomainHydrator}); `FxRate` could not be an embeddable in any case, its
 * `asOf` being an ECMAScript `#private` field that `EntitySchema` can neither read
 * nor assign.
 *
 * @returns `null` when the whole group is null — an unconverted hold.
 * @throws {InvalidReservationError} if the group is half-filled, which the
 * `reservations_fx_evidence_complete` check should already have made
 * unstorable; the row is refused here too rather than silently treated as
 * unconverted.
 * @throws {InvalidFxRateError} if the stored rate is not one this build can state.
 * @throws {UnknownCurrencyError} if either code is unsupported.
 */
export function fxRateFromColumns(columns: FxEvidenceColumns): FxRate | null {
  const { fxBase, fxQuote, fxScaledValue, fxScale, fxSource, fxAsOf } = columns;
  // `undefined` counts as absent alongside `null`: a partially selected row
  // never assigns a column it did not ask for, and an absent column is no more
  // evidence of a rate than a null one.
  const present = [
    fxBase,
    fxQuote,
    fxScaledValue,
    fxScale,
    fxSource,
    fxAsOf,
  ].filter((value) => value !== null && value !== undefined);

  if (present.length === 0) {
    return null;
  }

  if (
    fxBase === null ||
    fxBase === undefined ||
    fxQuote === null ||
    fxQuote === undefined ||
    fxScaledValue === null ||
    fxScaledValue === undefined ||
    fxScale === null ||
    fxScale === undefined ||
    fxSource === null ||
    fxSource === undefined ||
    fxAsOf === null ||
    fxAsOf === undefined
  ) {
    throw new InvalidReservationError(
      `FX evidence is stored in six columns that are nullable together, but only ${present.length} of them is set`,
    );
  }

  // Through `FxRate.fromSnapshot`, and through the very shape `FxRate.toJSON`
  // writes: the stored scale, the integer value as a string and the instant as
  // an ISO 8601 UTC designator are what that factory is able to refuse.
  return FxRate.fromSnapshot({
    base: fxBase,
    quote: fxQuote,
    scaledValue: fxScaledValue.toString(),
    scale: fxScale,
    source: fxSource,
    asOf: fxAsOf.toISOString(),
  });
}

/**
 * Projects an {@link FxRate} onto the six columns, or nulls them all.
 *
 * Called by the reservation repository when a hold is added, which is the only
 * moment the evidence can change: nothing in the domain ever restates a stored
 * rate. `FxRate.toJSON` is the source of every value, so what the reservation row
 * carries and what a `capacity_events` `metadata.fxRate` carries are the same six
 * facts written the same way (docs/PLAN.md 2.8).
 */
export function fxEvidenceColumns(rate: FxRate | null): FxEvidenceColumns {
  if (rate === null) {
    return {
      fxBase: null,
      fxQuote: null,
      fxScaledValue: null,
      fxScale: null,
      fxSource: null,
      fxAsOf: null,
    };
  }

  // Read off the snapshot rather than the instance, so a reservation row and a
  // `capacity_events` `metadata.fxRate` carry the same six facts written the same
  // way (docs/PLAN.md 2.8) — and so `#asOf`, which is unreachable from outside
  // the value object, travels through the one accessor that serialises it.
  const snapshot = rate.toJSON();

  return {
    fxBase: snapshot.base,
    fxQuote: snapshot.quote,
    // Back to a `bigint` for the `BIGINT` column: the snapshot states the value
    // as a string so that JSON cannot round it, and `BigInt` is exact where
    // `Number` would stop being at 2^53.
    fxScaledValue: BigInt(snapshot.scaledValue),
    fxScale: snapshot.scale,
    fxSource: snapshot.source,
    fxAsOf: new Date(snapshot.asOf),
  };
}

/**
 * The same object, seen as the aggregate. See `asProgram` for why the cast lives
 * in a named function.
 */
export function asReservation(stored: StoredReservation): Reservation {
  return stored as unknown as Reservation;
}

/** The inverse view of {@link asReservation}. */
export function asStoredReservation(
  reservation: Reservation,
): StoredReservation {
  return reservation as unknown as StoredReservation;
}

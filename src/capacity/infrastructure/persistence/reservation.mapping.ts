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
 * The FX evidence of a hold, spread over six nullable columns rather than
 * one `jsonb`, so the rate is queryable evidence, not an opaque blob.
 * Nullable together (`CHECK (num_nulls(...) IN (0, 6))`, docs/PLAN.md 2.3)
 * and insert-only — no domain operation ever restates a stored rate.
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
 * The shape of one `reservations` row. As with `StoredProgram`, the
 * underscored keys are the aggregate's TypeScript-`private` fields, mapped
 * because a `private` member is an ordinary own property at runtime
 * (docs/PLAN.md 2.6).
 *
 * Two currencies, and neither is redundant: `originalCurrency` is the
 * invoice's own, `heldCurrency` is the program's that the hold consumes, and
 * `_releasedAmount` shares `heldCurrency` since it is part of the same held
 * sum as `_reservedAmount`.
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
 * `reservations`. `(program_id, invoice_id)` is the primary key — the
 * idempotency key of docs/PLAN.md 2.5 — rather than a unique index beside a
 * surrogate id, since the domain has no reservation identifier of its own.
 */
export const reservationSchema = new EntitySchema<StoredReservation>({
  class: Reservation as unknown as EntityClass<StoredReservation>,
  tableName: 'reservations',
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
    {
      name: 'reservations_program_id_reserved_at_invoice_id_index',
      properties: ['programId', '_reservedAt', 'invoiceId'],
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
      // `= any(array[…])`, not `in (…)`: Postgres stores it this way, and
      // the schema-drift test compares against what it reports.
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
 * Reads an {@link FxRate} back from its six columns, through
 * `FxRate.fromSnapshot`.
 * @returns `null` when the whole group is null — an unconverted hold.
 * @throws {InvalidReservationError} if the group is half-filled.
 * @throws {InvalidFxRateError} if the stored rate is not one this build can state.
 * @throws {UnknownCurrencyError} if either code is unsupported.
 */
export function fxRateFromColumns(columns: FxEvidenceColumns): FxRate | null {
  const { fxBase, fxQuote, fxScaledValue, fxScale, fxSource, fxAsOf } = columns;
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
 * Projects an {@link FxRate} onto the six columns, or nulls them all. The
 * only place the evidence is written, since nothing in the domain ever
 * restates a stored rate.
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

  // Via `toJSON`, since `#asOf` is unreachable from outside the value object.
  const snapshot = rate.toJSON();

  return {
    fxBase: snapshot.base,
    fxQuote: snapshot.quote,
    fxScaledValue: BigInt(snapshot.scaledValue),
    fxScale: snapshot.scale,
    fxSource: snapshot.source,
    fxAsOf: new Date(snapshot.asOf),
  };
}

/** The same object, seen as the aggregate. See `asProgram` for why the cast lives in a named function. */
export function asReservation(stored: StoredReservation): Reservation {
  return stored as unknown as Reservation;
}

/** The inverse view of {@link asReservation}. */
export function asStoredReservation(
  reservation: Reservation,
): StoredReservation {
  return reservation as unknown as StoredReservation;
}

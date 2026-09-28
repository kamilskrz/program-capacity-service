import { BigIntType, EntitySchema } from '@mikro-orm/core';

import { FxRate } from '../fx-rate';

/**
 * One `fx_rates` row: the current quote for one **direction** of one pair.
 *
 * ## Directional, and keyed that way
 *
 * The primary key is `(base, quote)`, and `(EUR, USD)` and `(USD, EUR)` are two
 * rows. docs/PLAN.md 2.3 is explicit: a rate is never inverted, because 1/1.0987
 * is not exactly representable and a service that divides by a quote reports an
 * exposure nobody quoted. The seeded table therefore has to carry both directions
 * of every pair it serves, and a pair with only one direction answers exactly one
 * question — the other yields `null` and a `422` (`FxRateNotFoundError`), which is
 * the correct outcome and is asserted in the provider's tests.
 *
 * ## One row per direction, not a history
 *
 * "The current rate" is all the `FxRateProvider` port asks for, so `as_of` is a
 * column and not part of the key: a new quote replaces the old one. Nothing is
 * lost by that, because the figure that matters historically is the one **frozen
 * on the reservation** (docs/PLAN.md 2.3) — six columns on `reservations` that no
 * later quote can move. A rate history would be a second, unread copy of that
 * evidence with a different retention story.
 *
 * ## `scale` is stored, not assumed
 *
 * `FxRate.fromSnapshot` refuses a row whose `scale` is not the scale this build
 * guarantees. Storing it is what makes a row written under a different precision
 * detectable rather than silently reinterpreted by a factor of ten — the same
 * reason the column exists on `reservations`.
 */
export interface FxRateRow {
  base: string;
  quote: string;
  /** The rate multiplied by 10^`scale`, as an exact integer. */
  scaledValue: bigint;
  scale: number;
  /** Where the quote came from — `"seed"` for seeded rows. */
  source: string;
  asOf: Date;
}

/** `fx_rates`. */
export const fxRateSchema = new EntitySchema<FxRateRow>({
  name: 'FxRate',
  tableName: 'fx_rates',
  properties: {
    base: { type: 'string', length: 3, primary: true, fieldName: 'base' },
    quote: { type: 'string', length: 3, primary: true, fieldName: 'quote' },
    scaledValue: { type: new BigIntType(), fieldName: 'scaled_value' },
    scale: { type: 'smallint', fieldName: 'scale' },
    source: { type: 'string', length: 64, fieldName: 'source' },
    asOf: { type: 'datetime', fieldName: 'as_of' },
  },
  checks: [
    {
      // `FxRate.of` refuses a non-positive rate: a zero or negative price is not
      // a quote, and a conversion through one would produce an exposure of the
      // wrong sign.
      name: 'fx_rates_scaled_value_positive',
      expression: 'scaled_value > 0',
    },
    {
      // A same-currency conversion needs no rate, and storing an identity rate
      // would invite code to divide by it (`FxRate.of` says the same).
      name: 'fx_rates_base_differs_from_quote',
      expression: 'base <> quote',
    },
  ],
});

/**
 * Rebuilds the value object from its row through `FxRate.fromSnapshot`, which is
 * what refuses an unsupported currency code, a stale `scale`, a non-integer value
 * or an unreadable instant.
 *
 * @throws {InvalidFxRateError} if the stored rate is not one this build can state.
 * @throws {UnknownCurrencyError} if either code is unsupported.
 */
export function fxRateFromRow(row: FxRateRow): FxRate {
  return FxRate.fromSnapshot({
    base: row.base,
    quote: row.quote,
    // The column is a `BIGINT`, so the value arrives as a `bigint` (see
    // `MoneyAmountType` for why never a number); the snapshot states it as an
    // integer string, which is the form `FxRate.fromSnapshot` validates.
    scaledValue: row.scaledValue.toString(),
    scale: row.scale,
    source: row.source,
    asOf: row.asOf.toISOString(),
  });
}

/** The row a rate is written as. `FxRate.toJSON` is the only source of values. */
export function toFxRateRow(rate: FxRate): FxRateRow {
  // `FxRate.toJSON` is the only reader of `#asOf`, which is an ECMAScript
  // private field no mapper can reach, so the snapshot is also the only honest
  // source for the other five columns.
  const snapshot = rate.toJSON();

  return {
    base: snapshot.base,
    quote: snapshot.quote,
    scaledValue: BigInt(snapshot.scaledValue),
    scale: snapshot.scale,
    source: snapshot.source,
    asOf: new Date(snapshot.asOf),
  };
}

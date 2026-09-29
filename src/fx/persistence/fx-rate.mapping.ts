import { BigIntType, EntitySchema } from '@mikro-orm/core';

import { FxRate } from '../fx-rate';

/**
 * One `fx_rates` row: the current quote for one direction of one pair.
 * Primary key `(base, quote)` — `(EUR, USD)` and `(USD, EUR)` are two rows,
 * since a rate is never inverted (docs/PLAN.md 2.3). Holds the current
 * quote only, not a history: the figure that matters historically is the
 * one frozen on the reservation that used it.
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
      name: 'fx_rates_scaled_value_positive',
      expression: 'scaled_value > 0',
    },
    {
      // A same-currency conversion needs no rate; storing an identity rate
      // would invite code to divide by it.
      name: 'fx_rates_base_differs_from_quote',
      expression: 'base <> quote',
    },
  ],
});

/**
 * Rebuilds the value object from its row, through `FxRate.fromSnapshot`.
 * @throws {InvalidFxRateError} if the stored rate is not one this build can state.
 * @throws {UnknownCurrencyError} if either code is unsupported.
 */
export function fxRateFromRow(row: FxRateRow): FxRate {
  return FxRate.fromSnapshot({
    base: row.base,
    quote: row.quote,
    scaledValue: row.scaledValue.toString(),
    scale: row.scale,
    source: row.source,
    asOf: row.asOf.toISOString(),
  });
}

/** The row a rate is written as. `FxRate.toJSON` is the only source of values, since `#asOf` is otherwise unreachable. */
export function toFxRateRow(rate: FxRate): FxRateRow {
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

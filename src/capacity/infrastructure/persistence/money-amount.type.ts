import { Type, type EntityProperty, type Platform } from '@mikro-orm/core';

import { type CurrencyCode } from '../../domain/currency';
import { Money } from '../../domain/money';

/**
 * Grammar for a `BIGINT` column's value: a bare, optionally signed integer.
 *
 * Applied to a `string` on both directions of the boundary, because that is the
 * shape `pg` uses for a 64-bit integer (docs/PLAN.md 2.6) and the only one this
 * type will pass through unexamined. A decimal string is refused rather than
 * truncated: `"100.00"` in a `BIGINT` column is not an amount that was stated in
 * minor units, and guessing which of the two it meant is how a figure ends up a
 * hundred times off.
 */
const INTEGER_PATTERN = /^-?\d+$/;

/** What a rejected value is called in the error, without stringifying an object. */
function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'object') {
    return `an instance of ${value.constructor.name}`;
  }

  if (typeof value === 'string') {
    return `the string ${JSON.stringify(value)}`;
  }

  return `a ${typeof value}`;
}

/**
 * Maps the **amount half** of a {@link Money} to one `BIGINT` column.
 *
 * ## Why an amount-only type, and not a `Money` type
 *
 * A `Money` is two facts — minor units and a currency — and a MikroORM `Type`
 * spans exactly one column: `convertToJSValue` is handed that column's value and
 * nothing else, so it cannot know which currency the row states its amounts in.
 * The three candidate mappings were:
 *
 * 1. **an embeddable per amount** (`credit_limit_amount` +
 *    `credit_limit_currency`, …). Works with no custom code, and was rejected on
 *    the schema it produces: `programs` would carry three currency columns
 *    (`currency`, the limit's and the reserved total's) that the domain
 *    guarantees are equal, so two of them are only ways for a row to contradict
 *    itself, and every reader has to know which one is authoritative. It also
 *    cannot express `FxRate`, whose `asOf` is an ECMAScript `#private` field that
 *    `EntitySchema` cannot see or assign — so an embeddable would not even have
 *    removed the need for the hydrator that this type leans on.
 * 2. **a `jsonb` column per amount.** Self-describing, and unusable: `SUM(delta)`
 *    is the invariant docs/PLAN.md 2.4 asserts, and `CHECK (reserved_amount >=
 *    0)` is required by the same section. Neither is available over JSON without
 *    casting every row.
 * 3. **this**: a `BIGINT` per amount, the currency stored once per row where the
 *    domain guarantees one currency (`programs.currency`,
 *    `capacity_events.currency`) and once per distinct currency where it does not
 *    (`reservations.original_currency` for the invoice,
 *    `reservations.held_currency` for the hold). Amounts are summable and
 *    checkable in SQL, no column can disagree with another, and the pairing of
 *    amount and currency happens in exactly one place — `DomainHydrator`.
 *
 * ## Why `bigint` rather than `string` on the way in
 *
 * `pg` returns `BIGINT` as a string, since a 64-bit integer does not survive a
 * double (docs/PLAN.md 2.6). `BigIntType` in `mode: 'bigint'` — the default in
 * MikroORM 6 — is what turns it into a native `bigint`, and that is the only
 * shape `Money.fromMinorUnits` accepts. This type keeps the same contract:
 * whatever the driver hands over, the hydrator receives a `bigint`.
 *
 * ## The one deliberate impurity
 *
 * `convertToJSValue` returns a `bigint`, not a `Money`, although the property it
 * feeds is declared `Money` on the entity. The value is therefore momentarily of
 * the wrong type — between MikroORM's hydration and `DomainHydrator`'s
 * assembly, which runs immediately after and before the entity is visible to any
 * caller. The alternative (a `Money` with a guessed currency) would be a lie that
 * survives; this one cannot, because the hydrator replaces every amount it finds
 * and the round-trip tests would fail loudly if it missed one.
 *
 * `convertToDatabaseValue` therefore has to accept both shapes: a `Money` from
 * the domain on the way out, and a `bigint` when MikroORM re-converts a freshly
 * hydrated value to build the change-detection snapshot. `compareAsType`
 * declares `string`, so the comparator judges changes on the minor-unit string
 * that actually goes into the column, never on object identity — a `Money` is
 * immutable and every write replaces the instance, so identity comparison would
 * report a change on every flush.
 */
export class MoneyAmountType extends Type<
  Money | bigint | null,
  string | null
> {
  /**
   * @throws {TypeError} if the value is neither a {@link Money}, a `bigint`, an
   * integer-valued string nor `null`. A silent `String(value)` here would write
   * `"[object Object]"` or `"100.00 USD"` into a `BIGINT` column and the failure
   * would surface as a driver error far from its cause.
   */
  override convertToDatabaseValue(value: unknown): string | null {
    // `undefined` is what an unset nullable amount looks like on its way out —
    // the column is null either way, and refusing it would make an absent
    // optional column a write error rather than an absence.
    if (value === null || value === undefined) {
      return null;
    }

    // The domain's own shape: the minor units verbatim, which is what the column
    // holds (docs/PLAN.md 2.3). The currency travels in its own column and is
    // paired back up by `moneyFromColumns`.
    if (value instanceof Money) {
      return value.minorUnits.toString();
    }

    // A freshly hydrated amount, re-converted by MikroORM to build the
    // change-detection snapshot — see the class documentation.
    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (typeof value === 'string' && INTEGER_PATTERN.test(value)) {
      return value;
    }

    throw new TypeError(
      `a bigint amount column takes a Money, a bigint or an integer string, got ${describe(value)}`,
    );
  }

  /**
   * The raw column value as a `bigint`, to be paired with the row's currency by
   * {@link DomainHydrator}. `null` passes through for a nullable amount column.
   */
  override convertToJSValue(value: unknown): bigint | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'bigint') {
      return value;
    }

    // The driver's shape. `BigInt(string)` is exact at any magnitude, which
    // `Number(string)` stops being at 2^53 — the whole reason this type exists.
    if (typeof value === 'string' && INTEGER_PATTERN.test(value)) {
      return BigInt(value);
    }

    // A `Money` reaches here when MikroORM re-reads a value the domain supplied
    // (`em.create` with custom-type conversion on). Its minor units are the same
    // integer the column would have held.
    if (value instanceof Money) {
      return value.minorUnits;
    }

    // A small `BIGINT` can come back as a JS number from a driver configured to
    // parse it; accepted only when it is exactly an integer, so nothing that has
    // already lost precision is quietly adopted.
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return BigInt(value);
    }

    throw new TypeError(
      `a bigint amount column reads back as a bigint or an integer string, got ${describe(value)}`,
    );
  }

  /** `bigint`, in every dialect this service supports (Postgres only). */
  override getColumnType(_prop: EntityProperty, _platform: Platform): string {
    return 'bigint';
  }

  /**
   * Changes are judged on the minor-unit string that reaches the column.
   * See the class documentation.
   */
  override compareAsType(): string {
    return 'string';
  }
}

/**
 * The single instance the schemas share.
 *
 * MikroORM accepts either a `Type` subclass or an instance; an instance keeps
 * the schemas free of `new` noise, and the type is stateless so sharing it is
 * safe.
 */
export const moneyAmount = new MoneyAmountType();

/**
 * Pairs a stored amount with the currency its row states, through the domain's
 * own factory.
 *
 * Exists so that no mapping file open-codes the pairing: `Money.fromMinorUnits`
 * is what rejects a currency code this build does not know
 * ({@link UnknownCurrencyError}), which is the fault the database deliberately
 * does *not* constrain — the supported set lives in `currency.ts` and adding a
 * currency must stay a one-line change there plus a seeded rate, not a migration
 * (docs/PLAN.md 2.3).
 *
 * @throws {UnknownCurrencyError} if `currency` is not a supported ISO 4217 code.
 * @throws {TypeError} if `minorUnits` is not a `bigint` — which means the column
 * was not mapped through {@link MoneyAmountType}.
 */
export function moneyFromColumns(minorUnits: unknown, currency: string): Money {
  if (typeof minorUnits !== 'bigint') {
    throw new TypeError(
      `expected a bigint amount from the database, got ${typeof minorUnits}`,
    );
  }

  // The cast is the boundary `Money.fromMinorUnits` documents: a `varchar`
  // column reaches the domain as an unchecked `string` wearing the type, and the
  // factory is what narrows it or throws.
  return Money.fromMinorUnits(minorUnits, currency as CurrencyCode);
}

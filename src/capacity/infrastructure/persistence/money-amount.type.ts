import { Type, type EntityProperty, type Platform } from '@mikro-orm/core';

import { type CurrencyCode } from '../../domain/currency';
import { Money } from '../../domain/money';

/** A bare, optionally signed integer — the only shape a `BIGINT` column accepts on either side of the boundary. */
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
 * Maps the amount half of a {@link Money} to one `BIGINT` column; the
 * currency lives in its own column and is paired back by
 * {@link moneyFromColumns}. The property this feeds is declared `Money`, but
 * `convertToJSValue` hands back a bare `bigint` — the entity is momentarily
 * the wrong type between MikroORM's hydration and `DomainHydrator`'s
 * assembly, which runs immediately after.
 */
export class MoneyAmountType extends Type<
  Money | bigint | null,
  string | null
> {
  /**
   * @throws {TypeError} if the value is neither a {@link Money}, a `bigint`,
   * an integer-valued string nor `null`.
   */
  override convertToDatabaseValue(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (value instanceof Money) {
      return value.minorUnits.toString();
    }

    // A freshly hydrated amount, re-converted by MikroORM to build the
    // change-detection snapshot.
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
   * The raw column value as a `bigint`, to be paired with the row's
   * currency by {@link DomainHydrator}. `null` passes through.
   */
  override convertToJSValue(value: unknown): bigint | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'bigint') {
      return value;
    }

    // `BigInt(string)` is exact at any magnitude, unlike `Number(string)`.
    if (typeof value === 'string' && INTEGER_PATTERN.test(value)) {
      return BigInt(value);
    }

    if (value instanceof Money) {
      return value.minorUnits;
    }

    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return BigInt(value);
    }

    throw new TypeError(
      `a bigint amount column reads back as a bigint or an integer string, got ${describe(value)}`,
    );
  }

  override getColumnType(_prop: EntityProperty, _platform: Platform): string {
    return 'bigint';
  }

  /** Changes are judged on the minor-unit string, not object identity — see the class documentation. */
  override compareAsType(): string {
    return 'string';
  }
}

/** The single, stateless instance the schemas share. */
export const moneyAmount = new MoneyAmountType();

/**
 * Pairs a stored amount with the currency its row states, through the
 * domain's own factory.
 * @throws {UnknownCurrencyError} if `currency` is not a supported ISO 4217 code.
 * @throws {TypeError} if `minorUnits` is not a `bigint`.
 */
export function moneyFromColumns(minorUnits: unknown, currency: string): Money {
  if (typeof minorUnits !== 'bigint') {
    throw new TypeError(
      `expected a bigint amount from the database, got ${typeof minorUnits}`,
    );
  }

  return Money.fromMinorUnits(minorUnits, currency as CurrencyCode);
}

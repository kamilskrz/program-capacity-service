import { exponentOf, parseCurrencyCode, type CurrencyCode } from './currency';
import { CurrencyMismatchError, InvalidAmountError } from './errors';

/** Grammar for {@link Money.fromDecimalString}: `-?\d+(\.\d+)?`. */
const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Grammar for the wire form of minor units: a bare, optionally signed integer. */
const INTEGER_PATTERN = /^-?\d+$/;

/**
 * Wire shape of an amount. `amount` is minor units as a string, never a
 * number (docs/PLAN.md 2.3). `currency` is `string` because this also
 * describes unvalidated inbound JSON.
 */
export interface MoneyJson {
  readonly amount: string;
  readonly currency: string;
}

/**
 * An integer number of minor units plus an ISO 4217 code. Immutable, `bigint`
 * end to end. Negative amounts are legal — reconciliation may push available
 * capacity below zero (docs/PLAN.md 2.1).
 */
export class Money {
  /** Private: only reachable through the validated factories below. */
  private constructor(
    readonly minorUnits: bigint,
    readonly currency: CurrencyCode,
  ) {}

  /** 1 minor unit is 1 JPY, 0.01 USD, 0.001 KWD. @throws {UnknownCurrencyError} */
  static fromMinorUnits(minorUnits: bigint, currency: CurrencyCode): Money {
    return new Money(minorUnits, parseCurrencyCode(currency));
  }

  /** @throws {UnknownCurrencyError} if `currency` is not supported. */
  static zero(currency: CurrencyCode): Money {
    return new Money(0n, parseCurrencyCode(currency));
  }

  /**
   * Parses e.g. `"100.00"`, `"1500"`, `"-5.50"`. Excess fraction digits for
   * the currency (`"100.001"` in USD) are rejected, not rounded.
   * @throws {InvalidAmountError} on a malformed string or excess precision.
   * @throws {UnknownCurrencyError} if `currency` is not supported.
   */
  static fromDecimalString(value: string, currency: CurrencyCode): Money {
    const validCurrency = parseCurrencyCode(currency);
    const match = DECIMAL_PATTERN.exec(value);

    if (!match) {
      throw new InvalidAmountError(value, 'not a decimal number');
    }

    const [, sign, integerPart, fractionPart = ''] = match;
    const exponent = exponentOf(validCurrency);

    if (fractionPart.length > exponent) {
      throw new InvalidAmountError(
        value,
        `${validCurrency} only has ${exponent} decimal place(s)`,
      );
    }

    const magnitude = BigInt(integerPart + fractionPart.padEnd(exponent, '0'));

    return new Money(sign === '-' ? -magnitude : magnitude, validCurrency);
  }

  /**
   * @throws {InvalidAmountError} if `amount` isn't an integer minor-unit
   * string. @throws {UnknownCurrencyError} if `currency` is not supported.
   */
  static fromJSON(json: MoneyJson): Money {
    const currency = parseCurrencyCode(json.currency);

    if (!INTEGER_PATTERN.test(json.amount)) {
      throw new InvalidAmountError(
        json.amount,
        'must be an integer number of minor units',
      );
    }

    return new Money(BigInt(json.amount), currency);
  }

  /** @throws {CurrencyMismatchError} if the currencies differ. */
  add(other: Money): Money {
    this.assertSameCurrency('add', other);

    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  /** May return a negative amount (docs/PLAN.md 2.1). @throws {CurrencyMismatchError} */
  subtract(other: Money): Money {
    this.assertSameCurrency('subtract', other);

    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  /** The same amount with the opposite sign. */
  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  /** Shared by every operation that requires matching currencies. */
  private assertSameCurrency(operation: string, other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(operation, this.currency, other.currency);
    }
  }

  /** Sign convention of `Array.prototype.sort`. @throws {CurrencyMismatchError} */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency('compare', other);

    if (this.minorUnits < other.minorUnits) {
      return -1;
    }

    if (this.minorUnits > other.minorUnits) {
      return 1;
    }

    return 0;
  }

  /**
   * Unlike {@link compare}, never throws: a mismatched currency makes two
   * amounts unequal, not incomparable.
   */
  equals(other: Money): boolean {
    return (
      this.currency === other.currency && this.minorUnits === other.minorUnits
    );
  }

  /** @throws {CurrencyMismatchError} if the currencies differ. */
  isGreaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  /** Strictly greater than zero — what a reservable amount has to be. */
  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  /** Strictly less than zero — an over-utilised program (docs/PLAN.md 2.1). */
  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  /** Inverse of {@link fromDecimalString}: `"100.00"` in USD, `"100"` in JPY. */
  toDecimalString(): string {
    const exponent = exponentOf(this.currency);
    const negative = this.minorUnits < 0n;
    const digits = (negative ? -this.minorUnits : this.minorUnits)
      .toString()
      .padStart(exponent + 1, '0');
    const sign = negative ? '-' : '';

    if (exponent === 0) {
      return `${sign}${digits}`;
    }

    return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  }

  /** Called implicitly by `JSON.stringify`. See {@link MoneyJson}. */
  toJSON(): MoneyJson {
    return { amount: this.minorUnits.toString(), currency: this.currency };
  }

  /**
   * `"100.00 USD"` — for log lines, error messages and test failures, where the
   * currency has to be visible next to the digits. Not a wire format.
   */
  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }
}

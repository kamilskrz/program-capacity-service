import { exponentOf, parseCurrencyCode, type CurrencyCode } from './currency';
import { CurrencyMismatchError, InvalidAmountError } from './errors';

/**
 * Grammar for {@link Money.fromDecimalString}: `-?\d+(\.\d+)?`. Capturing
 * sign, integer and fraction separately is what lets the parser reject excess
 * precision without ever going through a float.
 */
const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Grammar for the wire form of minor units: a bare, optionally signed integer. */
const INTEGER_PATTERN = /^-?\d+$/;

/**
 * The JSON shape of an amount, on the wire and in Kafka payloads.
 *
 * `amount` is the integer number of minor units as a **string**, never a
 * number: `JSON.parse` would turn a large exposure figure into a lossy IEEE-754
 * double, and a client that never sees a number cannot round one
 * (docs/PLAN.md 2.3).
 *
 * Minor units rather than a decimal string ("10000", not "100.00") because that
 * is exactly what the `BIGINT` column holds, so serialisation is the identity
 * and no decimal parse sits between the database and the client. The cost is
 * that a consumer needs the `currency` field to render the value, which is why
 * the two always travel together and why {@link Money.toDecimalString} exists
 * for anything human-facing.
 *
 * `currency` is typed `string` because this shape describes inbound JSON too,
 * where the code has not been validated yet.
 */
export interface MoneyJson {
  readonly amount: string;
  readonly currency: string;
}

/**
 * An amount of money: an integer number of minor units plus an ISO 4217 code.
 *
 * Immutable — every operation returns a new instance, so a `Money` handed to a
 * reservation cannot be changed underneath it.
 *
 * Amounts are `bigint` end to end. No `number` appears at any stage, including
 * intermediate results: at 10M in a 2-decimal currency an exposure figure is
 * already 1e9 minor units, and a service that sums, converts and compares such
 * figures under `Number` arithmetic would start losing minor units somewhere
 * above 9e15 — silently, and only in production.
 *
 * **Negative amounts are legal.** Reconciliation may push available capacity
 * below zero (a reduced limit, docs/PLAN.md 2.1) and the system must be able to
 * represent and report that rather than crash on it. `Money` is therefore a
 * signed quantity; "a reservation amount must be positive" is a rule about
 * reservations, enforced where reservations are created, not a rule about
 * money.
 */
export class Money {
  /**
   * Validation lives in the factories, so the constructor is a plain
   * assignment and stays private: an instance can only come into existence
   * through a checked path.
   */
  private constructor(
    readonly minorUnits: bigint,
    readonly currency: CurrencyCode,
  ) {}

  /**
   * The primitive constructor: an exact integer count of minor units.
   *
   * What "1 minor unit" means depends on the currency — 1 JPY, 0.01 USD,
   * 0.001 KWD.
   *
   * @throws {UnknownCurrencyError} if `currency` is not supported. The
   * parameter is typed `CurrencyCode`, but that only holds inside the domain;
   * a row hydrated from a `varchar` column or a Kafka payload reaches here
   * with an unchecked `string` wearing the type, so this still has to check.
   */
  static fromMinorUnits(minorUnits: bigint, currency: CurrencyCode): Money {
    return new Money(minorUnits, parseCurrencyCode(currency));
  }

  /**
   * Zero in `currency`; the identity for {@link add}.
   *
   * @throws {UnknownCurrencyError} if `currency` is not supported.
   */
  static zero(currency: CurrencyCode): Money {
    return new Money(0n, parseCurrencyCode(currency));
  }

  /**
   * Parses a decimal amount as written by a human or an upstream system —
   * `"100.00"`, `"1500"`, `"-5.50"`, `"0.001"`.
   *
   * Grammar: `-?\d+(\.\d+)?`. No leading `+`, no exponent notation, no
   * thousands separators, no surrounding whitespace, at least one digit before
   * the point. Anything else is refused rather than interpreted; trimming and
   * locale handling belong to the HTTP/Kafka boundary, where the original input
   * is still available to report back.
   *
   * The number of fraction digits must not exceed the currency's exponent.
   * `"100.001"` in USD is an error, not a rounding opportunity: the client
   * clearly meant an amount the currency cannot express, and picking one for
   * them would reserve a different figure than they asked for. Fewer digits are
   * fine, so `"100.5"` in USD is 10050 minor units while `"100.5"` in JPY is an
   * error.
   *
   * @throws {InvalidAmountError} on a malformed string or excess fraction
   * digits.
   * @throws {UnknownCurrencyError} if `currency` is not supported. Checked
   * before the excess-precision guard below, which reads the currency's
   * exponent and would otherwise silently accept any precision for a code it
   * does not recognise.
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

    // Padding the fraction to the currency's full exponent turns the decimal
    // into an integer of minor units with no division and nothing to round.
    const magnitude = BigInt(integerPart + fractionPart.padEnd(exponent, '0'));

    return new Money(sign === '-' ? -magnitude : magnitude, validCurrency);
  }

  /**
   * Rebuilds an amount from its wire form, validating both halves: `amount`
   * must be an integer minor-unit string (`"10.5"` is refused — that is a
   * decimal, and {@link fromDecimalString} is the parser for those) and
   * `currency` must be a supported code.
   *
   * @throws {InvalidAmountError} if `amount` is not an integer string.
   * @throws {UnknownCurrencyError} if `currency` is not supported.
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

  /**
   * @throws {CurrencyMismatchError} if the currencies differ.
   */
  add(other: Money): Money {
    this.assertSameCurrency('add', other);

    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  /**
   * May return a negative amount — releasing more than is held, or a limit cut
   * below current exposure, must be representable so it can be reported.
   *
   * @throws {CurrencyMismatchError} if the currencies differ.
   */
  subtract(other: Money): Money {
    this.assertSameCurrency('subtract', other);

    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  /**
   * The same amount with the opposite sign.
   *
   * Exists for the append-only `capacity_events` log (docs/PLAN.md 2.8), whose
   * `delta` is negative for a release and positive for a reservation.
   */
  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  /** Shared by every operation that requires matching currencies. */
  private assertSameCurrency(operation: string, other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(operation, this.currency, other.currency);
    }
  }

  /**
   * `-1`, `0` or `1`, in the sign convention of `Array.prototype.sort`.
   *
   * The ordering primitive; {@link isGreaterThanOrEqual} is the one the
   * availability rule actually reads, and the rest of the service can derive
   * whatever else it needs from these two.
   *
   * @throws {CurrencyMismatchError} if the currencies differ — ordering two
   * currencies is as meaningless as adding them.
   */
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
   * Whether both amounts are the same value in the same currency.
   *
   * Unlike {@link compare} this never throws: a mismatched currency makes two
   * amounts unequal, not incomparable. Equality is asked in contexts where an
   * exception would be the wrong answer — an idempotent replay comparing a
   * stored request with a new one (docs/PLAN.md 2.5) wants `false`, meaning
   * `409`, not a crash.
   */
  equals(other: Money): boolean {
    return (
      this.currency === other.currency && this.minorUnits === other.minorUnits
    );
  }

  /**
   * The availability test: `available.isGreaterThanOrEqual(requested)`.
   *
   * @throws {CurrencyMismatchError} if the currencies differ.
   */
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

  /**
   * The amount as a decimal string with exactly the currency's number of
   * fraction digits: `"100.00"` in USD, `"100"` in JPY, `"0.001"` in KWD.
   *
   * The inverse of {@link fromDecimalString}, and the form to render to people
   * or to write into a log line.
   */
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

import {
  parseCurrencyCode,
  type CurrencyCode,
} from '../capacity/domain/currency';
import { InvalidFxRateError } from './errors';

/**
 * Grammar for {@link FxRate.fromDecimalString}: `-?\d+(\.\d+)?`, the same shape
 * `Money.fromDecimalString` parses, kept separate because the two enforce
 * different fraction-length limits.
 */
const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Grammar for a stored `scaledValue`: a bare, optionally signed integer. */
const INTEGER_PATTERN = /^-?\d+$/;

/**
 * Grammar for a stored `asOf`: a full ISO 8601 instant with an explicit UTC
 * designator, matching what {@link FxRate.toJSON} always writes. Anything
 * `Date` would parse more liberally — `"12/25/2024"` (read in the host's local
 * timezone, so the same row means a different instant in Warsaw and New
 * York), a bare `"2024"`, a `+02:00` offset — is refused instead: a stored
 * rate is evidence, and evidence needs one unambiguous reading.
 */
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * Parses `value` as an ISO 8601 UTC instant, or returns `null` if it is not
 * one — including a calendar date that does not exist. `Date` itself would
 * silently roll `"2024-02-30"` to the 1st of March, so the components are
 * rebuilt with `Date.UTC` and read back: if any of them changed, the input
 * overflowed and is rejected rather than reinterpreted.
 */
function parseIsoInstant(value: string): Date | null {
  const match = ISO_INSTANT_PATTERN.exec(value);

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  const ms = Number(fraction.padEnd(3, '0'));

  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  const overflowed =
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== s ||
    date.getUTCMilliseconds() !== ms;

  return overflowed ? null : date;
}

/**
 * The storable form of a rate, exactly as it is written into a reservation row
 * and into the `capacity_events` metadata (docs/PLAN.md 2.3, 2.8).
 *
 * Every field is a primitive, so this maps onto columns or `jsonb` without a
 * transformer, and it answers the audit question in full: which rate, from
 * where, as of when.
 *
 * `scale` is recorded next to the value even though it is currently always
 * {@link FxRate.SCALE_EXPONENT}. Stored rows outlive the code that wrote them;
 * if the guaranteed precision ever changes, a row written under the old scale
 * is then detectable rather than silently reinterpreted by a factor of ten.
 */
export interface FxRateSnapshot {
  readonly base: string;
  readonly quote: string;
  /** The rate multiplied by 10^`scale`, as an integer string. */
  readonly scaledValue: string;
  readonly scale: number;
  readonly source: string;
  /** ISO 8601, UTC. */
  readonly asOf: string;
}

/** Everything a rate needs, given the value already scaled to an integer. */
export interface FxRateProps {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  /** The rate multiplied by 10^{@link FxRate.SCALE_EXPONENT}. */
  readonly scaledValue: bigint;
  /** Where the rate came from, e.g. `"ecb"` or `"seed"`. Must be non-empty. */
  readonly source: string;
  readonly asOf: Date;
}

/** As {@link FxRateProps}, but with the rate as a decimal string. */
export interface FxRateDecimalProps {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  /** Decimal string, e.g. `"1.0987"`. At most 12 fraction digits. */
  readonly value: string;
  readonly source: string;
  readonly asOf: Date;
}

/**
 * A price of one currency in another, with its provenance.
 *
 * **Representation.** The rate is a `bigint` numerator over a fixed power of
 * ten (`scaledValue / 10^SCALE_EXPONENT`), not a `number`. A rate like 1.0987
 * has no exact IEEE-754 representation, and a float multiplication inside the
 * conversion would make the converted amount depend on the order of operations
 * — the sort of defect that shows up as a one-minor-unit drift in a
 * reconciliation report months later. A scaled integer keeps the whole
 * conversion in exact integer arithmetic, with the single rounding step placed
 * deliberately at the end (see `convert.ts`).
 *
 * **Precision guarantee.** Rates are exact multiples of 1e-12. Twelve fraction
 * digits is far beyond market convention (major pairs are quoted to 4-5
 * decimals, and the widest inverse pairs such as USD/IDR to about 8), so the
 * limit never truncates a real quote. A rate finer than that is rejected rather
 * than rounded: a rate source that disagrees with us about precision is a
 * problem to notice, not to paper over. At this scale a rate of 1e-12 to 1e6
 * is representable, which covers every published pair including the
 * hyperinflated ones.
 *
 * **Immutable, and frozen at reservation time.** A reservation stores the rate
 * it used and a release never re-converts, so the same rate object is what the
 * audit trail later replays (docs/PLAN.md 2.3).
 */
export class FxRate {
  /** Decimal places of guaranteed precision. */
  static readonly SCALE_EXPONENT = 12;

  /** 10^{@link SCALE_EXPONENT} — the denominator of every rate. */
  static readonly SCALE = 1_000_000_000_000n;

  /**
   * The quote timestamp. A genuine ECMAScript private field rather than a
   * TypeScript `private` member: the latter is only a compile-time check —
   * the value is still an own enumerable property at runtime, so `{ ...rate }`
   * or `Object.assign({}, rate)` would hand out the very same `Date` instance
   * the getter below is trying to keep out of reach. `#asOf` has no own key at
   * all, so a shallow clone carries nothing to mutate.
   */
  #asOf: Date;

  /** Private: validation lives in the factories. */
  private constructor(
    readonly base: CurrencyCode,
    readonly quote: CurrencyCode,
    readonly scaledValue: bigint,
    readonly source: string,
    asOf: Date,
  ) {
    this.#asOf = asOf;
  }

  /**
   * When the rate was quoted. A fresh clone on every read: the stored rate is
   * evidence (docs/PLAN.md 2.3), and a caller mutating the `Date` object it
   * gets back — even setting it to an invalid time — must not be able to
   * corrupt what this instance reports afterwards.
   */
  get asOf(): Date {
    return new Date(this.#asOf.getTime());
  }

  /**
   * @throws {UnknownCurrencyError} if either code is unsupported.
   * @throws {InvalidFxRateError} if the rate is zero or negative, if `source`
   * is blank, if `asOf` is not a valid date, or if `base` equals `quote` — a
   * same-currency conversion needs no rate, and storing an identity rate would
   * invite code to divide by it.
   */
  static of(props: FxRateProps): FxRate {
    const base = parseCurrencyCode(props.base);
    const quote = parseCurrencyCode(props.quote);
    const { scaledValue, asOf } = props;
    // Trimmed once, here, so every path into a rate — decimal string or
    // snapshot — stores the same source for the same feed; otherwise
    // "  ecb  " and "ecb" would split one provenance into two in the audit
    // trail.
    const source = props.source.trim();

    if (scaledValue <= 0n) {
      throw new InvalidFxRateError(
        `rate must be positive, got ${scaledValue.toString()}`,
      );
    }

    if (source.length === 0) {
      throw new InvalidFxRateError('source must not be blank');
    }

    if (Number.isNaN(asOf.getTime())) {
      throw new InvalidFxRateError('asOf must be a valid date');
    }

    if (base === quote) {
      throw new InvalidFxRateError(
        `base and quote must differ, both were ${base}`,
      );
    }

    // Cloned so the caller mutating their `Date` afterwards cannot reach back
    // into a rate that is supposed to be frozen from here on.
    return new FxRate(
      base,
      quote,
      scaledValue,
      source,
      new Date(asOf.getTime()),
    );
  }

  /**
   * The form a seeded rate table or an upstream feed is written in.
   *
   * Grammar as for amounts: `-?\d+(\.\d+)?`, at most
   * {@link SCALE_EXPONENT} fraction digits.
   *
   * @throws {InvalidFxRateError} on a malformed string, on more than
   * {@link SCALE_EXPONENT} fraction digits, or for any reason in
   * {@link FxRate.of}.
   */
  static fromDecimalString(props: FxRateDecimalProps): FxRate {
    const { base, quote, value, source, asOf } = props;
    const match = DECIMAL_PATTERN.exec(value);

    if (!match) {
      throw new InvalidFxRateError(`malformed rate: ${JSON.stringify(value)}`);
    }

    const [, sign, integerPart, fractionPart = ''] = match;

    if (fractionPart.length > FxRate.SCALE_EXPONENT) {
      throw new InvalidFxRateError(
        `rate ${JSON.stringify(value)} is finer than the guaranteed precision of ${FxRate.SCALE_EXPONENT} decimal places`,
      );
    }

    // Padding to the full scale turns the decimal into an integer numerator
    // with no division and nothing to round before FxRate.of takes over.
    const magnitude = BigInt(
      integerPart + fractionPart.padEnd(FxRate.SCALE_EXPONENT, '0'),
    );

    return FxRate.of({
      base,
      quote,
      scaledValue: sign === '-' ? -magnitude : magnitude,
      source,
      asOf,
    });
  }

  /**
   * Rebuilds a rate from a stored row or a Kafka payload.
   *
   * @throws {UnknownCurrencyError} if either code is unsupported.
   * @throws {InvalidFxRateError} if `scale` is not the scale this build
   * guarantees, if `scaledValue` is not an integer string, if `asOf` is not a
   * valid ISO 8601 instant, or for any reason in {@link FxRate.of}.
   */
  static fromSnapshot(snapshot: FxRateSnapshot): FxRate {
    const base = parseCurrencyCode(snapshot.base);
    const quote = parseCurrencyCode(snapshot.quote);

    if (snapshot.scale !== FxRate.SCALE_EXPONENT) {
      throw new InvalidFxRateError(
        `stored scale ${snapshot.scale} does not match the guaranteed scale of ${FxRate.SCALE_EXPONENT}`,
      );
    }

    if (!INTEGER_PATTERN.test(snapshot.scaledValue)) {
      throw new InvalidFxRateError(
        `stored value ${JSON.stringify(snapshot.scaledValue)} is not an integer`,
      );
    }

    const asOf = parseIsoInstant(snapshot.asOf);

    if (asOf === null) {
      throw new InvalidFxRateError(
        `stored timestamp ${JSON.stringify(snapshot.asOf)} is not a valid ISO 8601 UTC instant`,
      );
    }

    return FxRate.of({
      base,
      quote,
      scaledValue: BigInt(snapshot.scaledValue),
      source: snapshot.source,
      asOf,
    });
  }

  /**
   * The rate as a decimal string in canonical form: no trailing zeros in the
   * fraction, no trailing point (`1.0987`, `0.5`, `2`).
   */
  toDecimalString(): string {
    const digits = this.scaledValue
      .toString()
      .padStart(FxRate.SCALE_EXPONENT + 1, '0');
    const integerPart = digits.slice(0, -FxRate.SCALE_EXPONENT);
    const fractionPart = digits
      .slice(-FxRate.SCALE_EXPONENT)
      .replace(/0+$/, '');

    return fractionPart.length > 0
      ? `${integerPart}.${fractionPart}`
      : integerPart;
  }

  /** Called implicitly by `JSON.stringify`. See {@link FxRateSnapshot}. */
  toJSON(): FxRateSnapshot {
    return {
      base: this.base,
      quote: this.quote,
      scaledValue: this.scaledValue.toString(),
      scale: FxRate.SCALE_EXPONENT,
      source: this.source,
      asOf: this.#asOf.toISOString(),
    };
  }
}

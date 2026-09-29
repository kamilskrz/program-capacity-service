import {
  parseCurrencyCode,
  type CurrencyCode,
} from '../capacity/domain/currency';
import { InvalidFxRateError } from './errors';

/** Grammar for {@link FxRate.fromDecimalString}: `-?\d+(\.\d+)?`. */
const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Grammar for a stored `scaledValue`: a bare, optionally signed integer. */
const INTEGER_PATTERN = /^-?\d+$/;

/** Grammar for a stored `asOf`: ISO 8601 instant with an explicit UTC designator. */
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * Rejects calendar dates `Date` would silently roll over (e.g. `"2024-02-30"`
 * becoming March 1st): components are rebuilt with `Date.UTC` and compared back.
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

/** Storable form of a rate, as written into a reservation row (docs/PLAN.md 2.3, 2.8). */
export interface FxRateSnapshot {
  readonly base: string;
  readonly quote: string;
  /** The rate multiplied by 10^`scale`, as an integer string. */
  readonly scaledValue: string;
  /** Stored alongside the value so a future precision change is detectable, not misread. */
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
 * A price of one currency in another, with its provenance. The rate is a
 * `bigint` numerator over a fixed power of ten, never a `number` (docs/PLAN.md
 * 2.3). Immutable, and frozen at reservation time.
 */
export class FxRate {
  /** Decimal places of guaranteed precision. */
  static readonly SCALE_EXPONENT = 12;

  /** 10^{@link SCALE_EXPONENT} — the denominator of every rate. */
  static readonly SCALE = 1_000_000_000_000n;

  /** `FxRate` is a value object, so `#private` is safe here (docs/PLAN.md 2.6). */
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

  /** Fresh clone on every read, so a caller can't mutate the stored instant. */
  get asOf(): Date {
    return new Date(this.#asOf.getTime());
  }

  /**
   * @throws {UnknownCurrencyError} if either code is unsupported.
   * @throws {InvalidFxRateError} if the rate is zero or negative, `source` is
   * blank, `asOf` is invalid, or `base` equals `quote` (no rate is stored for
   * a same-currency conversion).
   */
  static of(props: FxRateProps): FxRate {
    const base = parseCurrencyCode(props.base);
    const quote = parseCurrencyCode(props.quote);
    const { scaledValue, asOf } = props;
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

    // Cloned so the caller's `Date` can't be mutated to reach back in.
    return new FxRate(
      base,
      quote,
      scaledValue,
      source,
      new Date(asOf.getTime()),
    );
  }

  /**
   * @throws {InvalidFxRateError} on a malformed string, more than
   * {@link SCALE_EXPONENT} fraction digits, or any reason in {@link FxRate.of}.
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
   * @throws {UnknownCurrencyError} if either code is unsupported.
   * @throws {InvalidFxRateError} if `scale` doesn't match {@link SCALE_EXPONENT},
   * `scaledValue` isn't an integer string, `asOf` isn't a valid ISO 8601 UTC
   * instant, or any reason in {@link FxRate.of}.
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

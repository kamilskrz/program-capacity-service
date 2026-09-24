import { UnknownCurrencyError } from './errors';

/**
 * The currencies the service accepts, mapped to their ISO 4217 exponent — the
 * number of decimal places the currency subdivides into.
 *
 * The exponent is the whole reason this table exists. "Minor unit" is not a
 * synonym for "cent": JPY has no subdivision at all, KWD and BHD have three
 * digits, so `1` minor unit is a yen, a tenth of a cent of a dinar, or a cent
 * of a dollar depending on the code next to it (docs/PLAN.md 2.3). Every piece
 * of formatting, parsing and FX arithmetic in the service reads the exponent
 * from here instead of assuming 2.
 *
 * The set is closed on purpose. An unknown code is an error rather than a
 * currency with an assumed exponent of 2, which would silently misstate
 * exposure by a factor of 10 or 100 on the day a JPY or KWD program appears.
 * Adding a currency is a one-line change here plus a seeded FX rate.
 *
 * Frozen so the table is immutable at runtime too, not just by its type: every
 * amount in a currency is stated relative to this table, and a stray write to
 * it would restate all of them at once.
 */
export const CURRENCY_EXPONENTS = Object.freeze({
  AED: 2,
  AUD: 2,
  BHD: 3,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CNY: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  INR: 2,
  JOD: 3,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  MXN: 2,
  NOK: 2,
  NZD: 2,
  OMR: 3,
  PLN: 2,
  SAR: 2,
  SEK: 2,
  SGD: 2,
  TND: 3,
  TRY: 2,
  USD: 2,
  ZAR: 2,
} as const satisfies Record<string, CurrencyExponent>);

/**
 * A supported currency, as a union of literal codes.
 *
 * Because it is a union rather than `string`, a typo in a currency code is a
 * compile error everywhere except at the system boundary, where
 * {@link parseCurrencyCode} turns untrusted input into this type once.
 */
export type CurrencyCode = keyof typeof CURRENCY_EXPONENTS;

/** Decimal places a currency subdivides into. ISO 4217 uses only these. */
export type CurrencyExponent = 0 | 2 | 3;

/** Whether an arbitrary value is a supported ISO 4217 code. */
export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && Object.hasOwn(CURRENCY_EXPONENTS, value);
}

/**
 * Narrows untrusted input (HTTP body, Kafka message, database row) to a
 * {@link CurrencyCode}.
 *
 * Matching is exact and case-sensitive: ISO 4217 codes are upper case, and
 * accepting `"usd"` here would put a second spelling of every currency into the
 * domain. Normalising input is the boundary's job, not the domain's.
 *
 * @throws {UnknownCurrencyError} if the code is not supported.
 */
export function parseCurrencyCode(value: string): CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new UnknownCurrencyError(value);
  }

  return value;
}

/** The number of decimal places `currency` subdivides into. */
export function exponentOf(currency: CurrencyCode): CurrencyExponent {
  return CURRENCY_EXPONENTS[currency];
}

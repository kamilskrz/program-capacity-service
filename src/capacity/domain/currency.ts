import { UnknownCurrencyError } from './errors';

/**
 * Supported currencies mapped to their ISO 4217 exponent (decimal places).
 * "Minor unit" is not a synonym for "cent": JPY has 0, KWD/BHD/etc. have 3
 * (docs/PLAN.md 2.3). An unsupported code is an error, never assumed to be 2.
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

export type CurrencyCode = keyof typeof CURRENCY_EXPONENTS;

/** Decimal places a currency subdivides into. ISO 4217 uses only these. */
export type CurrencyExponent = 0 | 2 | 3;

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && Object.hasOwn(CURRENCY_EXPONENTS, value);
}

/**
 * Narrows untrusted input to a {@link CurrencyCode}. Case-sensitive — `"usd"`
 * is rejected, not normalised.
 * @throws {UnknownCurrencyError} if the code is not supported.
 */
export function parseCurrencyCode(value: string): CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new UnknownCurrencyError(value);
  }

  return value;
}

export function exponentOf(currency: CurrencyCode): CurrencyExponent {
  return CURRENCY_EXPONENTS[currency];
}

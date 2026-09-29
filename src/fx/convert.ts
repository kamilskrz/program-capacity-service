import { exponentOf, type CurrencyCode } from '../capacity/domain/currency';
import {
  CurrencyMismatchError,
  InvalidAmountError,
} from '../capacity/domain/errors';
import { Money } from '../capacity/domain/money';
import { FxRateNotFoundError } from './errors';
import { FxRate } from './fx-rate';
import { type FxRateProvider } from './fx-rate.provider';

/** Outcome of converting an amount, shaped to be stored (docs/PLAN.md 2.3). */
export interface Conversion {
  readonly original: Money;
  readonly converted: Money;
  /** `null` iff no conversion was needed — already in the target currency. */
  readonly rate: FxRate | null;
}

/**
 * Integer `bigint` arithmetic, single rounding step at the end:
 * ```text
 * converted = ceil( minorUnits × scaledValue × 10^(eq − eb) / 10^SCALE_EXPONENT )
 * ```
 * Rounds up, never to nearest (docs/PLAN.md 2.3): a non-zero amount always
 * converts to a non-zero amount.
 *
 * @throws {CurrencyMismatchError} if `rate.base` isn't the currency of `amount`.
 * @throws {InvalidAmountError} if `amount` is negative.
 */
export function applyRate(amount: Money, rate: FxRate): Money {
  if (amount.currency !== rate.base) {
    throw new CurrencyMismatchError('convert', rate.base, amount.currency);
  }

  if (amount.isNegative()) {
    throw new InvalidAmountError(
      amount.toDecimalString(),
      'a negative amount is a computed balance, not an exposure to convert',
    );
  }

  const exponentDelta = exponentOf(rate.quote) - exponentOf(amount.currency);

  const numerator =
    exponentDelta >= 0
      ? amount.minorUnits * rate.scaledValue * 10n ** BigInt(exponentDelta)
      : amount.minorUnits * rate.scaledValue;
  const denominator =
    exponentDelta >= 0
      ? FxRate.SCALE
      : FxRate.SCALE * 10n ** BigInt(-exponentDelta);

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const convertedMinorUnits = remainder === 0n ? quotient : quotient + 1n;

  return Money.fromMinorUnits(convertedMinorUnits, rate.quote);
}

/**
 * If `amount` is already in `targetCurrency`, the provider is never consulted
 * and a `null` rate is returned — a single-currency program needs no FX data.
 *
 * @throws {FxRateNotFoundError} if the provider has no rate for the pair.
 * @throws {CurrencyMismatchError} if the provider answers with the wrong pair.
 * @throws {InvalidAmountError} if `amount` is negative.
 */
export async function convert(
  amount: Money,
  targetCurrency: CurrencyCode,
  rates: FxRateProvider,
): Promise<Conversion> {
  if (amount.isNegative()) {
    throw new InvalidAmountError(
      amount.toDecimalString(),
      'a negative amount is a computed balance, not an exposure to convert',
    );
  }

  if (amount.currency === targetCurrency) {
    return { original: amount, converted: amount, rate: null };
  }

  const rate = await rates.getRate(amount.currency, targetCurrency);

  if (rate === null) {
    throw new FxRateNotFoundError(amount.currency, targetCurrency);
  }

  if (rate.quote !== targetCurrency) {
    throw new CurrencyMismatchError('convert', targetCurrency, rate.quote);
  }

  return { original: amount, converted: applyRate(amount, rate), rate };
}

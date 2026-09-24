import { exponentOf, type CurrencyCode } from '../capacity/domain/currency';
import {
  CurrencyMismatchError,
  InvalidAmountError,
} from '../capacity/domain/errors';
import { Money } from '../capacity/domain/money';
import { FxRateNotFoundError } from './errors';
import { FxRate } from './fx-rate';
import { type FxRateProvider } from './fx-rate.provider';

/**
 * The outcome of converting an amount, shaped to be stored.
 *
 * A reservation persists all three fields (docs/PLAN.md 2.3): the original
 * amount as the client stated it, the amount in program currency that actually
 * consumes the limit, and the rate — with its source and timestamp — that
 * produced the second from the first. Without the rate the conversion is not
 * reproducible, and "why is 92,300 EUR of capacity held for a 100,000 USD
 * invoice?" has no answer six months later.
 */
export interface Conversion {
  readonly original: Money;
  readonly converted: Money;
  /**
   * `null` if and only if no conversion was needed, the amount already being
   * in the target currency.
   *
   * The alternative — synthesising an identity rate so the field is never null
   * — was rejected: it would write a source and a timestamp for a rate nobody
   * ever quoted, and a stored rate is evidence. `null` states the truth, that
   * this amount was never converted.
   */
  readonly rate: FxRate | null;
}

/**
 * Converts `amount` using an explicit rate, with a single rounding step at the
 * end.
 *
 * The whole computation is integer arithmetic on `bigint`:
 *
 * ```text
 * converted = ceil( minorUnits × scaledValue × 10^(eq − eb) / 10^SCALE_EXPONENT )
 * ```
 *
 * where `eb` and `eq` are the exponents of the base and quote currencies. The
 * power of ten re-expresses the amount when the two currencies subdivide
 * differently (USD 2 → JPY 0, USD 2 → KWD 3); it is folded into the numerator
 * or the denominator so that nothing is divided before the final step, and no
 * intermediate value is ever rounded.
 *
 * **Rounding is ceiling, not nearest** (docs/PLAN.md 2.3). Every conversion
 * rounds away from the funder's risk: the program holds a fraction of a minor
 * unit more capacity than strictly needed rather than a fraction less. So
 * converting 1 minor unit at a rate of 1.0987 yields 2 minor units, and any
 * non-zero amount converts to a non-zero amount. Zero converts to zero — the
 * ceiling applies to a remainder, not to the amount itself.
 *
 * Exposed separately from {@link convert} because it is the reproducible half:
 * given a stored {@link FxRate} and the original amount, it recomputes the held
 * amount exactly, which is what an audit or a reconciliation adjustment needs.
 *
 * @throws {CurrencyMismatchError} if `rate.base` is not the currency of
 * `amount` — including when a misbehaving provider answers with the wrong pair.
 * @throws {InvalidAmountError} if `amount` is negative. Conversion is defined
 * for exposure figures, which are never negative; a negative available balance
 * is a computed result and is never converted, and rounding "up" would be
 * ambiguous for it anyway.
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

  // The power of ten for the exponent delta is folded into whichever side of
  // the fraction keeps it an integer, so nothing is divided — and therefore
  // nothing is rounded — until the single ceiling step below.
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
 * Converts `amount` into `targetCurrency`, looking the rate up through the
 * port.
 *
 * If the amount is already in `targetCurrency` the provider is not consulted at
 * all: the amount is returned unchanged with a `null` rate. This is what keeps
 * a single-currency program working with no FX data seeded whatsoever.
 *
 * `async`, since the port it calls through is asynchronous; nothing else in
 * the body actually awaits, but the signature has to match a real adapter.
 *
 * @throws {FxRateNotFoundError} if the provider has no rate for the pair. A
 * missing rate is an error, never a guess (docs/PLAN.md 2.3) — it surfaces as
 * `422` and the reservation is refused.
 * @throws {CurrencyMismatchError} if the provider answers with a rate for a
 * different pair.
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

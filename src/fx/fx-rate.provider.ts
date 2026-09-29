import { type CurrencyCode } from '../capacity/domain/currency';
import { type FxRate } from './fx-rate';

/** Port through which the domain asks for a rate (docs/PLAN.md 2.3). */
export interface FxRateProvider {
  /**
   * `null` when the pair is not quoted — absence is data, not an error; the
   * caller (`convert`) decides whether to raise `FxRateNotFoundError`.
   * `base === quote` must never be passed in.
   */
  getRate(base: CurrencyCode, quote: CurrencyCode): Promise<FxRate | null>;
}

/** DI token for {@link FxRateProvider}; an interface has no runtime value to key on. */
export const FX_RATE_PROVIDER = Symbol('FxRateProvider');

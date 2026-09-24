import { type CurrencyCode } from '../capacity/domain/currency';
import { type FxRate } from './fx-rate';

/**
 * The port through which the domain asks for a rate (docs/PLAN.md 2.3).
 *
 * An interface the domain owns and an adapter implements — in this service a
 * seeded database table, in production a rate feed. Conversion therefore has no
 * opinion about where rates live and stays unit-testable with a hand-written
 * stub instead of a database.
 *
 * Deliberately narrow: one question, one pair, one answer. Batch lookups and
 * historical queries can be added when something needs them; right now they
 * would be untested surface on the one seam an adapter has to satisfy.
 */
export interface FxRateProvider {
  /**
   * The current rate to multiply an amount in `base` by to obtain `quote`, or
   * `null` when the pair is not quoted.
   *
   * Absence is returned as data rather than thrown, because absence is not by
   * itself an error — it is the caller's policy that turns it into one. That
   * policy lives in `convert`, which raises `FxRateNotFoundError` (a `422`);
   * keeping it there means an adapter cannot decide, for instance, to return a
   * stale rate instead.
   *
   * Callers must not pass `base === quote`: an identity conversion never
   * reaches the provider.
   */
  getRate(base: CurrencyCode, quote: CurrencyCode): Promise<FxRate | null>;
}

/**
 * Injection token for {@link FxRateProvider}.
 *
 * An interface leaves no runtime value for a DI container to key on. Declaring
 * the token next to the port keeps the contract in one file; it is a plain
 * symbol, so the domain still imports nothing from NestJS (docs/PLAN.md 2.6).
 */
export const FX_RATE_PROVIDER = Symbol('FxRateProvider');

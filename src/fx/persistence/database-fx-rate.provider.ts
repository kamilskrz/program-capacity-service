import { type EntityManager } from '@mikro-orm/postgresql';

import { type CurrencyCode } from '../../capacity/domain/currency';
import { type FxRate } from '../fx-rate';
import { type FxRateProvider } from '../fx-rate.provider';
import { fxRateFromRow, fxRateSchema } from './fx-rate.mapping';

/**
 * The seeded-table adapter behind `FxRateProvider` (docs/PLAN.md 2.3).
 *
 * One row per direction, looked up by primary key. The port's contract is kept
 * exactly: a pair with no row returns `null`, because absence is data and it is
 * `convert` that turns it into a `422` — an adapter that decided to fall back to the
 * inverse rate, or to a stale one, would be making a credit decision in a data access
 * class.
 *
 * **Never inverts.** A `(EUR, USD)` row does not answer a USD→EUR question
 * (docs/PLAN.md 2.3: 1/1.0987 is not exactly representable), so the lookup is on the
 * ordered pair and a half-seeded pair answers exactly one of the two questions. The
 * integration test asserts that asymmetry, because "we have the rate, just backwards"
 * is the tempting shortcut this class exists to refuse.
 *
 * Bound to an `EntityManager` like the other adapters, so a rate read inside a
 * capacity transaction sees that transaction's snapshot.
 */
export class DatabaseFxRateProvider implements FxRateProvider {
  constructor(private readonly em: EntityManager) {}

  /**
   * `em.findOne(fxRateSchema, { base, quote })`, then `fxRateFromRow`.
   *
   * @returns `null` when the pair is not quoted in that direction.
   * @throws {InvalidFxRateError} if the stored row is not a rate this build can state
   * — a `scale` other than the guaranteed one, most importantly. A seeded table that
   * has drifted from the code is a deployment fault, and a conversion must not happen
   * through a rate whose precision nobody can vouch for.
   * @throws {UnknownCurrencyError} if either stored code is unsupported.
   */
  async getRate(
    base: CurrencyCode,
    quote: CurrencyCode,
  ): Promise<FxRate | null> {
    // The ordered pair is the primary key, so this is a single-row lookup and
    // there is nowhere for an inverted answer to come from: `(EUR, USD)` is a
    // different row from `(USD, EUR)`, and a pair seeded in one direction only
    // answers exactly one of the two questions.
    const row = await this.em.findOne(fxRateSchema, { base, quote });

    // Absence is data, not an error: `convert` is what turns it into a 422.
    return row === null ? null : fxRateFromRow(row);
  }
}

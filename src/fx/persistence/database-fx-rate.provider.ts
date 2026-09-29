import { type EntityManager } from '@mikro-orm/postgresql';

import { type CurrencyCode } from '../../capacity/domain/currency';
import { type FxRate } from '../fx-rate';
import { type FxRateProvider } from '../fx-rate.provider';
import { fxRateFromRow, fxRateSchema } from './fx-rate.mapping';

/**
 * The seeded-table adapter behind `FxRateProvider` (docs/PLAN.md 2.3). One
 * row per direction, looked up by primary key; never inverts, so a pair
 * seeded in one direction only answers exactly that question.
 */
export class DatabaseFxRateProvider implements FxRateProvider {
  constructor(private readonly em: EntityManager) {}

  /**
   * @returns `null` when the pair is not quoted in that direction — data,
   * not an error; `convert` is what turns it into a `422`.
   * @throws {InvalidFxRateError} if the stored row is not a rate this build
   * can state — a `scale` other than the guaranteed one, most importantly.
   * @throws {UnknownCurrencyError} if either stored code is unsupported.
   */
  async getRate(
    base: CurrencyCode,
    quote: CurrencyCode,
  ): Promise<FxRate | null> {
    const row = await this.em.findOne(fxRateSchema, { base, quote });

    return row === null ? null : fxRateFromRow(row);
  }
}

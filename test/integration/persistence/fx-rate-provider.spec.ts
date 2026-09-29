import { type MikroORM } from '@mikro-orm/postgresql';

import { expectSameFxRate, expectSameMoney } from '../support/expect-domain';
import { EUR_PER_USD, OCCURRED_AT, eur, usd } from '../support/factories';
import { initTestOrm, resetDatabase } from '../support/orm';
import { insertFxRateRow } from '../support/rows';
import { convert } from '../../../src/fx/convert';
import { FxRateNotFoundError } from '../../../src/fx/errors';
import { InvalidFxRateError } from '../../../src/fx/errors';
import { type FxRate } from '../../../src/fx/fx-rate';
import { DatabaseFxRateProvider } from '../../../src/fx/persistence/database-fx-rate.provider';

// `fx_rates` behind the `FxRateProvider` port (docs/PLAN.md §2.3). The
// property worth testing: rates are directional and never inverted. A
// `(EUR, USD)` row must not answer a USD→EUR question — 1/1.0987 isn't
// exactly representable, and dividing by a quote reports an exposure nobody
// quoted.
describe('the database FX rate provider', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await resetDatabase(orm);
  });

  const getRate = async (
    base: 'USD' | 'EUR' | 'JPY',
    quote: 'USD' | 'EUR' | 'JPY',
  ): Promise<FxRate | null> =>
    new DatabaseFxRateProvider(orm.em.fork()).getRate(base, quote);

  describe('round trip', () => {
    it('comes back as the quote that was stored, to the last of its twelve digits', async () => {
      await insertFxRateRow(orm.em, {
        base: 'USD',
        quote: 'EUR',
        scaled_value: '923500000000',
        scale: 12,
        source: 'seed',
        as_of: OCCURRED_AT,
      });

      const rate = await getRate('USD', 'EUR');

      expectSameFxRate(rate, EUR_PER_USD);
      expect(rate?.toDecimalString()).toBe('0.9235');
    });

    it('reads the scaled value back as a bigint, because a rate is an exact integer and not a float', async () => {
      await insertFxRateRow(orm.em, { scaled_value: '1098700000000' });

      const rate = await getRate('USD', 'EUR');

      expect(typeof rate?.scaledValue).toBe('bigint');
      expect(rate?.scaledValue).toBe(1_098_700_000_000n);
    });

    it('keeps the instant the quote was taken at', async () => {
      await insertFxRateRow(orm.em, { as_of: OCCURRED_AT });

      const rate = await getRate('USD', 'EUR');

      expect(rate?.asOf.toISOString()).toBe(OCCURRED_AT.toISOString());
    });

    it('keeps the source, so a seeded quote stays recognisable as one', async () => {
      await insertFxRateRow(orm.em, { source: 'seed' });

      const rate = await getRate('USD', 'EUR');

      expect(rate?.source).toBe('seed');
    });
  });

  describe('direction', () => {
    it('answers the direction that is quoted', async () => {
      await insertFxRateRow(orm.em, { base: 'USD', quote: 'EUR' });

      await expect(getRate('USD', 'EUR')).resolves.not.toBeNull();
    });

    it('refuses to answer the other direction of a pair it holds, rather than inverting the quote', async () => {
      await insertFxRateRow(orm.em, { base: 'USD', quote: 'EUR' });

      await expect(getRate('EUR', 'USD')).resolves.toBeNull();
    });

    it('holds the two directions of one pair as two independent rows, with their own spread', async () => {
      // Deliberately not exact inverses: a seed whose directions were inverses
      // would let a bug that divides by a rate pass every test.
      await insertFxRateRow(orm.em, {
        base: 'USD',
        quote: 'EUR',
        scaled_value: '923500000000',
      });
      await insertFxRateRow(orm.em, {
        base: 'EUR',
        quote: 'USD',
        scaled_value: '1082800000000',
      });

      const forward = await getRate('USD', 'EUR');
      const backward = await getRate('EUR', 'USD');

      expect(forward?.toDecimalString()).toBe('0.9235');
      expect(backward?.toDecimalString()).toBe('1.0828');
    });

    it('reports an unquoted pair as absent, leaving the 422 to the conversion that asked', async () => {
      // Absence is data: falling back to a stale or inverted rate here would
      // be a credit decision made in a data access class.
      await expect(getRate('JPY', 'USD')).resolves.toBeNull();
    });
  });

  describe('what the table may hold', () => {
    it('refuses a non-positive quote, because a zero price is not a price', async () => {
      await expect(
        insertFxRateRow(orm.em, { scaled_value: '0' }),
      ).rejects.toThrow(/fx_rates_scaled_value_positive/);
    });

    it('refuses a self-quote, which nothing would ever need and something would eventually divide by', async () => {
      await expect(
        insertFxRateRow(orm.em, { base: 'USD', quote: 'USD' }),
      ).rejects.toThrow(/fx_rates_base_differs_from_quote/);
    });

    it('holds one row per direction, so a new quote replaces the old one rather than accumulating', async () => {
      await insertFxRateRow(orm.em, { scaled_value: '923500000000' });

      await expect(
        insertFxRateRow(orm.em, { scaled_value: '924000000000' }),
      ).rejects.toThrow(/fx_rates_pkey/);
    });

    it('refuses a row whose scale is not the scale this build guarantees', async () => {
      await insertFxRateRow(orm.em, { scaled_value: '923500', scale: 6 });

      await expect(getRate('USD', 'EUR')).rejects.toThrow(InvalidFxRateError);
    });
  });

  describe('as the conversion sees it', () => {
    it('prices an invoice into the program currency through the stored quote', async () => {
      await insertFxRateRow(orm.em, {
        base: 'USD',
        quote: 'EUR',
        scaled_value: '923500000000',
        // Stated, not defaulted: the assertion below compares the instant too.
        as_of: OCCURRED_AT,
      });

      const conversion = await convert(
        usd(10_000_000n),
        'EUR',
        new DatabaseFxRateProvider(orm.em.fork()),
      );

      expectSameMoney(conversion.converted, eur(9_235_000n));
      expectSameFxRate(conversion.rate, EUR_PER_USD);
    });

    it('refuses the conversion outright when the pair is quoted only the other way round', async () => {
      await insertFxRateRow(orm.em, { base: 'USD', quote: 'EUR' });

      await expect(
        convert(
          eur(9_235_000n),
          'USD',
          new DatabaseFxRateProvider(orm.em.fork()),
        ),
      ).rejects.toThrow(FxRateNotFoundError);
    });

    it('needs no rate at all for an invoice already in the program currency', async () => {
      const conversion = await convert(
        usd(10_000_000n),
        'USD',
        new DatabaseFxRateProvider(orm.em.fork()),
      );

      expect(conversion.rate).toBeNull();
      expectSameMoney(conversion.converted, usd(10_000_000n));
    });
  });
});

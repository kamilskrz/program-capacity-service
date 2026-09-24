import { type CurrencyCode } from '../capacity/domain/currency';
import {
  CurrencyMismatchError,
  InvalidAmountError,
} from '../capacity/domain/errors';
import { Money } from '../capacity/domain/money';
import { applyRate, convert } from './convert';
import { FxRateNotFoundError } from './errors';
import { FxRate } from './fx-rate';
import { type FxRateProvider } from './fx-rate.provider';

const AS_OF = new Date('2026-09-24T10:00:00.000Z');

const money = (minorUnits: bigint, currency: CurrencyCode): Money =>
  Money.fromMinorUnits(minorUnits, currency);

const rateOf = (
  base: CurrencyCode,
  quote: CurrencyCode,
  value: string,
): FxRate =>
  FxRate.fromDecimalString({
    base,
    quote,
    value,
    source: 'ecb-seed',
    asOf: AS_OF,
  });

/** The seeded rate table of docs/PLAN.md 2.3, reduced to a map and a call log. */
class StubFxRates implements FxRateProvider {
  readonly requested: string[] = [];
  private readonly byPair: Map<string, FxRate>;

  constructor(rates: readonly FxRate[] = []) {
    this.byPair = new Map(
      rates.map((rate): [string, FxRate] => [
        `${rate.base}/${rate.quote}`,
        rate,
      ]),
    );
  }

  getRate(base: CurrencyCode, quote: CurrencyCode): Promise<FxRate | null> {
    this.requested.push(`${base}/${quote}`);

    return Promise.resolve(this.byPair.get(`${base}/${quote}`) ?? null);
  }
}

/** Fails the test if conversion reaches for a rate it should not need. */
const unreachableFxRates: FxRateProvider = {
  getRate: () => {
    throw new Error('the FX rate provider should not have been consulted');
  },
};

/**
 * Two above `Number.MAX_SAFE_INTEGER`: the working range is nowhere near it,
 * but the arithmetic must not have a cliff anywhere.
 */
const BEYOND_SAFE_INTEGER = 9_007_199_254_740_993n;

/**
 * Awaits `act`, asserting it was refused with `type`, and hands the error back
 * for inspection. Tolerates a refusal raised before the promise is returned.
 */
async function rejectedWith<T>(
  type: abstract new (...args: never[]) => T,
  act: () => Promise<unknown>,
): Promise<T> {
  try {
    await act();
  } catch (error) {
    if (error instanceof type) {
      return error;
    }
    throw error;
  }

  throw new Error(`expected ${type.name} to be thrown, but nothing was`);
}

describe('applying a known rate', () => {
  const cases: {
    amount: bigint;
    from: CurrencyCode;
    to: CurrencyCode;
    rate: string;
    expected: bigint;
  }[] = [
    // Divides evenly: the result is the exact product, with nothing to round.
    { amount: 10_000n, from: 'USD', to: 'EUR', rate: '0.5', expected: 5_000n },
    { amount: 3n, from: 'USD', to: 'EUR', rate: '2', expected: 6n },
    {
      amount: 1_000_000_000n,
      from: 'USD',
      to: 'EUR',
      rate: '0.9137',
      expected: 913_700_000n,
    },
    // Does not divide evenly: the remainder is always taken up.
    {
      amount: 10_001n,
      from: 'USD',
      to: 'EUR',
      rate: '1.0987',
      expected: 10_989n,
    },
    { amount: 1n, from: 'USD', to: 'EUR', rate: '1.0987', expected: 2n },
    { amount: 1n, from: 'USD', to: 'EUR', rate: '0.5', expected: 1n },
    // Two decimal places into none: 100.00 USD at 150.5 is 15050 JPY exactly.
    {
      amount: 10_000n,
      from: 'USD',
      to: 'JPY',
      rate: '150.5',
      expected: 15_050n,
    },
    // One cent is 1.505 yen, so the program holds two.
    { amount: 1n, from: 'USD', to: 'JPY', rate: '150.5', expected: 2n },
    // None into two: 1000 JPY at 0.0066 is 6.60 USD exactly.
    { amount: 1_000n, from: 'JPY', to: 'USD', rate: '0.0066', expected: 660n },
    // One yen is two thirds of a cent, so the program holds a whole cent.
    { amount: 1n, from: 'JPY', to: 'USD', rate: '0.0066', expected: 1n },
    // Two decimal places into three: 100.00 USD at 0.30775 is 30.775 KWD.
    {
      amount: 10_000n,
      from: 'USD',
      to: 'KWD',
      rate: '0.30775',
      expected: 30_775n,
    },
    { amount: 1n, from: 'USD', to: 'KWD', rate: '0.30775', expected: 4n },
    // Three decimal places into two: 1.000 KWD at 3.25 is 3.25 USD exactly.
    { amount: 1_000n, from: 'KWD', to: 'USD', rate: '3.25', expected: 325n },
    { amount: 1n, from: 'KWD', to: 'USD', rate: '3.25', expected: 1n },
    // Nothing converts to nothing: the ceiling applies to a remainder, not to
    // the amount.
    { amount: 0n, from: 'USD', to: 'EUR', rate: '1.0987', expected: 0n },
  ];

  it.each(cases)(
    'converts $amount minor units of $from at $rate into $expected minor units of $to',
    ({ amount, from, to, rate, expected }) => {
      expect(
        applyRate(money(amount, from), rateOf(from, to, rate)).minorUnits,
      ).toBe(expected);
    },
  );

  it('produces an amount in the currency the rate is quoted in', () => {
    expect(
      applyRate(money(10_000n, 'USD'), rateOf('USD', 'JPY', '150.5')).currency,
    ).toBe('JPY');
  });

  it('rounds a remainder up even when rounding to nearest would round it down', () => {
    // 100 minor units at 1.000001 is 100.0001, which rounds to nearest as 100.
    expect(
      applyRate(money(100n, 'USD'), rateOf('USD', 'EUR', '1.000001'))
        .minorUnits,
    ).toBe(101n);
  });

  it('never converts a non-zero amount away to nothing', () => {
    expect(
      applyRate(money(1n, 'USD'), rateOf('USD', 'EUR', '0.000000000001'))
        .minorUnits,
    ).toBe(1n);
  });

  it('converts an amount a JS number could not hold without rounding it', () => {
    expect(
      applyRate(money(BEYOND_SAFE_INTEGER, 'USD'), rateOf('USD', 'EUR', '1'))
        .minorUnits,
    ).toBe(BEYOND_SAFE_INTEGER);
  });

  it('keeps every digit when such an amount is actually scaled by a rate', () => {
    // 9007199254740993 x 1.1 = 9907919180215092.3, taken up to ...93.
    expect(
      applyRate(money(BEYOND_SAFE_INTEGER, 'USD'), rateOf('USD', 'EUR', '1.1'))
        .minorUnits,
    ).toBe(9_907_919_180_215_093n);
  });

  it('refuses a rate quoted for another currency', () => {
    expect(() =>
      applyRate(money(10_000n, 'USD'), rateOf('EUR', 'USD', '1.0987')),
    ).toThrow(CurrencyMismatchError);
  });

  it('refuses to convert a negative amount, which is a computed balance rather than an exposure', () => {
    expect(() =>
      applyRate(money(-1n, 'USD'), rateOf('USD', 'EUR', '1.0987')),
    ).toThrow(InvalidAmountError);
  });

  describe('between two currencies that both subdivide unusually', () => {
    // JPY (0 decimals) against KWD (3) is the widest re-scaling the supported
    // table allows: a thousandfold shift in either direction, on top of the
    // rate itself. Every other pair moves the point by two places or fewer, so
    // a sign or an off-by-one in the exponent handling can hide everywhere
    // else and still be wrong here.
    const cases: {
      amount: bigint;
      from: CurrencyCode;
      to: CurrencyCode;
      rate: string;
      expected: bigint;
    }[] = [
      // 1000 JPY at 0.002 KWD per yen is 2.000 KWD exactly.
      {
        amount: 1_000n,
        from: 'JPY',
        to: 'KWD',
        rate: '0.002',
        expected: 2000n,
      },
      {
        amount: 500_000n,
        from: 'JPY',
        to: 'KWD',
        rate: '0.002',
        expected: 1_000_000n,
      },
      // One yen is 2.06 thousandths of a dinar, so the program holds three.
      { amount: 1n, from: 'JPY', to: 'KWD', rate: '0.00206', expected: 3n },
      // 7 JPY at 0.002065 is 14.455 minor units of KWD.
      { amount: 7n, from: 'JPY', to: 'KWD', rate: '0.002065', expected: 15n },
      // 1.000 KWD at 485 is 485 JPY exactly.
      { amount: 1_000n, from: 'KWD', to: 'JPY', rate: '485', expected: 485n },
      // One thousandth of a dinar is 0.485 of a yen, so the program holds one.
      { amount: 1n, from: 'KWD', to: 'JPY', rate: '485', expected: 1n },
      // 1.234 KWD at 485.25 is 598.7985 yen.
      {
        amount: 1_234n,
        from: 'KWD',
        to: 'JPY',
        rate: '485.25',
        expected: 599n,
      },
    ];

    it.each(cases)(
      'converts $amount minor units of $from at $rate into $expected minor units of $to',
      ({ amount, from, to, rate, expected }) => {
        expect(
          applyRate(money(amount, from), rateOf(from, to, rate)).minorUnits,
        ).toBe(expected);
      },
    );
  });
});

describe('converting into a program currency', () => {
  it('asks the provider for the pair in the direction of the conversion', async () => {
    const rates = new StubFxRates([rateOf('USD', 'EUR', '1.0987')]);

    await convert(money(10_000n, 'USD'), 'EUR', rates);

    expect(rates.requested).toEqual(['USD/EUR']);
  });

  it('holds the converted amount in the program currency', async () => {
    const rates = new StubFxRates([rateOf('USD', 'EUR', '0.9137')]);

    const conversion = await convert(
      money(1_000_000_000n, 'USD'),
      'EUR',
      rates,
    );

    expect(conversion.converted.equals(money(913_700_000n, 'EUR'))).toBe(true);
  });

  it('keeps the amount as the client stated it', async () => {
    const rates = new StubFxRates([rateOf('USD', 'EUR', '0.9137')]);
    const invoiced = money(1_000_000_000n, 'USD');

    const conversion = await convert(invoiced, 'EUR', rates);

    expect(conversion.original.equals(invoiced)).toBe(true);
  });

  it('records which rate produced the held amount', async () => {
    const rates = new StubFxRates([rateOf('USD', 'EUR', '1.0987')]);

    const conversion = await convert(money(10_000n, 'USD'), 'EUR', rates);

    expect(conversion.rate?.toDecimalString()).toBe('1.0987');
  });

  it('records where that rate came from', async () => {
    const rates = new StubFxRates([rateOf('USD', 'EUR', '1.0987')]);

    const conversion = await convert(money(10_000n, 'USD'), 'EUR', rates);

    expect(conversion.rate?.source).toBe('ecb-seed');
  });

  it('records when that rate was quoted', async () => {
    const rates = new StubFxRates([rateOf('USD', 'EUR', '1.0987')]);

    const conversion = await convert(money(10_000n, 'USD'), 'EUR', rates);

    expect(conversion.rate?.asOf.toISOString()).toBe(
      '2026-09-24T10:00:00.000Z',
    );
  });

  it('does not let the caller of a conversion rewrite the timestamp it recorded', async () => {
    // The rate a conversion returns is the one a reservation stores and the
    // audit trail replays. Every caller holds this handle, so the instant it
    // reports has to survive being handled.
    const rates = new StubFxRates([rateOf('USD', 'EUR', '1.0987')]);
    const conversion = await convert(money(10_000n, 'USD'), 'EUR', rates);
    const recorded = conversion.rate!;

    recorded.asOf.setUTCFullYear(1999);

    expect(recorded.toJSON().asOf).toBe('2026-09-24T10:00:00.000Z');
  });

  it('keeps a conversion storable after a caller mishandles the timestamp it returned', async () => {
    const rates = new StubFxRates([rateOf('USD', 'EUR', '1.0987')]);
    const conversion = await convert(money(10_000n, 'USD'), 'EUR', rates);
    const recorded = conversion.rate!;

    recorded.asOf.setTime(Number.NaN);

    expect(() => JSON.stringify(conversion)).not.toThrow();
  });

  it('produces a result that can be stored on a reservation as it stands', async () => {
    const rates = new StubFxRates([rateOf('USD', 'EUR', '1.0987')]);

    const conversion = await convert(money(10_000n, 'USD'), 'EUR', rates);

    expect(conversion.rate?.toJSON()).toEqual({
      base: 'USD',
      quote: 'EUR',
      scaledValue: '1098700000000',
      scale: 12,
      source: 'ecb-seed',
      asOf: '2026-09-24T10:00:00.000Z',
    });
  });

  it('holds exactly what the stored rate recomputes, so the figure can be audited', async () => {
    const rate = rateOf('USD', 'EUR', '1.0987');
    const invoiced = money(10_001n, 'USD');

    const conversion = await convert(invoiced, 'EUR', new StubFxRates([rate]));

    expect(conversion.converted.equals(applyRate(invoiced, rate))).toBe(true);
  });

  describe('when the invoice is already in the program currency', () => {
    it('holds the amount unchanged', async () => {
      const invoiced = money(10_000n, 'USD');

      const conversion = await convert(invoiced, 'USD', unreachableFxRates);

      expect(conversion.converted.equals(invoiced)).toBe(true);
    });

    it('records no rate, because none was used', async () => {
      const conversion = await convert(
        money(10_000n, 'USD'),
        'USD',
        unreachableFxRates,
      );

      expect(conversion.rate).toBeNull();
    });

    it('does not consult the rate provider at all', async () => {
      const rates = new StubFxRates();

      await convert(money(10_000n, 'USD'), 'USD', rates);

      expect(rates.requested).toEqual([]);
    });
  });

  describe('when no rate is available', () => {
    it('refuses the conversion instead of guessing a rate', async () => {
      await rejectedWith(FxRateNotFoundError, () =>
        convert(money(10_000n, 'USD'), 'EUR', new StubFxRates()),
      );
    });

    it('names the pair it could not price', async () => {
      const failure = await rejectedWith(FxRateNotFoundError, () =>
        convert(money(10_000n, 'USD'), 'EUR', new StubFxRates()),
      );

      expect([failure.base, failure.quote]).toEqual(['USD', 'EUR']);
    });

    it('carries a stable code the HTTP layer can map to 422', async () => {
      const failure = await rejectedWith(FxRateNotFoundError, () =>
        convert(money(10_000n, 'USD'), 'EUR', new StubFxRates()),
      );

      expect(failure.code).toBe('FX_RATE_NOT_FOUND');
    });

    it('does not fall back to a rate quoted the other way round', async () => {
      const rates = new StubFxRates([rateOf('EUR', 'USD', '0.9137')]);

      await rejectedWith(FxRateNotFoundError, () =>
        convert(money(10_000n, 'USD'), 'EUR', rates),
      );
    });
  });

  it('refuses a rate for a pair it did not ask for', async () => {
    const wrongPair: FxRateProvider = {
      getRate: () => Promise.resolve(rateOf('GBP', 'EUR', '1.1')),
    };

    await rejectedWith(CurrencyMismatchError, () =>
      convert(money(10_000n, 'USD'), 'EUR', wrongPair),
    );
  });

  it('refuses a rate that starts from the right currency but arrives at the wrong one', async () => {
    // The dangerous half of a misquoted pair: the base matches, so nothing in
    // the arithmetic objects, and without this check the program would hold
    // pounds against a euro limit.
    const wrongQuote: FxRateProvider = {
      getRate: () => Promise.resolve(rateOf('USD', 'GBP', '0.79')),
    };

    await rejectedWith(CurrencyMismatchError, () =>
      convert(money(10_000n, 'USD'), 'EUR', wrongQuote),
    );
  });

  it('names the currency it asked for and the one it was given', async () => {
    const wrongQuote: FxRateProvider = {
      getRate: () => Promise.resolve(rateOf('USD', 'GBP', '0.79')),
    };

    const failure = await rejectedWith(CurrencyMismatchError, () =>
      convert(money(10_000n, 'USD'), 'EUR', wrongQuote),
    );

    expect([failure.expected, failure.actual]).toEqual(['EUR', 'GBP']);
  });

  it('refuses a negative amount even when no conversion is needed', async () => {
    await rejectedWith(InvalidAmountError, () =>
      convert(money(-1n, 'USD'), 'USD', unreachableFxRates),
    );
  });

  it('refuses a negative amount that would have to be converted', async () => {
    const rates = new StubFxRates([rateOf('USD', 'EUR', '1.0987')]);

    await rejectedWith(InvalidAmountError, () =>
      convert(money(-1n, 'USD'), 'EUR', rates),
    );
  });
});

import { type CurrencyCode } from './currency';
import {
  CurrencyMismatchError,
  InvalidAmountError,
  UnknownCurrencyError,
} from './errors';
import { Money, type MoneyJson } from './money';

const usd = (minorUnits: bigint): Money =>
  Money.fromMinorUnits(minorUnits, 'USD');
const eur = (minorUnits: bigint): Money =>
  Money.fromMinorUnits(minorUnits, 'EUR');

/**
 * Two above `Number.MAX_SAFE_INTEGER`, which is the first integer a double
 * cannot hold. A 10M USD program limit is only 1e9 minor units, so this is well
 * past anything the business needs — that is the point: the type must not have
 * a cliff anywhere near the working range, and it must not have one here
 * either.
 */
const BEYOND_SAFE_INTEGER = 9_007_199_254_740_993n;

/** Runs `act`, asserting it threw `type`, and hands the error back for inspection. */
function thrown<T>(
  type: abstract new (...args: never[]) => T,
  act: () => unknown,
): T {
  try {
    act();
  } catch (error) {
    if (error instanceof type) {
      return error;
    }
    throw error;
  }

  throw new Error(`expected ${type.name} to be thrown, but nothing was`);
}

describe('Money', () => {
  describe('an amount in minor units', () => {
    it('keeps the minor units it was built from', () => {
      expect(usd(10_000n).minorUnits).toBe(10_000n);
    });

    it('keeps the currency it was built from', () => {
      expect(usd(10_000n).currency).toBe('USD');
    });

    it('starts at zero minor units when asked for zero', () => {
      expect(Money.zero('USD').minorUnits).toBe(0n);
    });

    it('accepts a negative amount, because a reduced limit can push available capacity below zero', () => {
      expect(usd(-1n).minorUnits).toBe(-1n);
    });
  });

  describe('reading a decimal amount from a client', () => {
    const accepted: {
      value: string;
      currency: CurrencyCode;
      minorUnits: bigint;
    }[] = [
      { value: '100.00', currency: 'USD', minorUnits: 10_000n },
      { value: '100', currency: 'USD', minorUnits: 10_000n },
      { value: '100.5', currency: 'USD', minorUnits: 10_050n },
      { value: '0.01', currency: 'USD', minorUnits: 1n },
      { value: '0', currency: 'USD', minorUnits: 0n },
      { value: '-0', currency: 'USD', minorUnits: 0n },
      { value: '0.00', currency: 'USD', minorUnits: 0n },
      { value: '-5.50', currency: 'USD', minorUnits: -550n },
      { value: '007.50', currency: 'USD', minorUnits: 750n },
      { value: '10000000.00', currency: 'USD', minorUnits: 1_000_000_000n },
      { value: '100', currency: 'JPY', minorUnits: 100n },
      { value: '0', currency: 'JPY', minorUnits: 0n },
      { value: '-250', currency: 'JPY', minorUnits: -250n },
      { value: '1.234', currency: 'KWD', minorUnits: 1234n },
      { value: '1.2', currency: 'KWD', minorUnits: 1200n },
      { value: '1', currency: 'KWD', minorUnits: 1000n },
      { value: '0.001', currency: 'KWD', minorUnits: 1n },
    ];

    it.each(accepted)(
      'reads $value $currency as $minorUnits minor units',
      ({ value, currency, minorUnits }) => {
        expect(Money.fromDecimalString(value, currency).minorUnits).toBe(
          minorUnits,
        );
      },
    );

    const tooPrecise: { value: string; currency: CurrencyCode }[] = [
      { value: '100.001', currency: 'USD' },
      { value: '0.005', currency: 'USD' },
      { value: '100.0', currency: 'JPY' },
      { value: '100.5', currency: 'JPY' },
      { value: '1.2345', currency: 'KWD' },
    ];

    it.each(tooPrecise)(
      'refuses $value, because $currency cannot express it',
      ({ value, currency }) => {
        expect(() => Money.fromDecimalString(value, currency)).toThrow(
          InvalidAmountError,
        );
      },
    );

    it.each([
      '',
      ' ',
      ' 100.00',
      '100.00 ',
      'abc',
      '1.2.3',
      '1,5',
      '+5',
      '1e3',
      '.5',
      '5.',
      '.',
      '-',
      '--5',
      '1 000',
      'NaN',
      'Infinity',
      '0x10',
    ])('refuses the malformed amount %p', (value) => {
      expect(() => Money.fromDecimalString(value, 'USD')).toThrow(
        InvalidAmountError,
      );
    });

    it('reports the amount it refused, so the client can see what was rejected', () => {
      const error = thrown(InvalidAmountError, () =>
        Money.fromDecimalString('100.001', 'USD'),
      );

      expect(error.value).toBe('100.001');
    });

    it('carries a stable code the HTTP layer can translate', () => {
      expect(new InvalidAmountError('100.001', 'too precise').code).toBe(
        'INVALID_AMOUNT',
      );
    });

    it('reads an amount far beyond what a JS number can hold', () => {
      expect(
        Money.fromDecimalString('90071992547409930000.99', 'USD').minorUnits,
      ).toBe(9_007_199_254_740_993_000_099n);
    });
  });

  describe('writing an amount out for people to read', () => {
    const cases: {
      minorUnits: bigint;
      currency: CurrencyCode;
      decimal: string;
    }[] = [
      { minorUnits: 10_000n, currency: 'USD', decimal: '100.00' },
      { minorUnits: 1n, currency: 'USD', decimal: '0.01' },
      { minorUnits: 0n, currency: 'USD', decimal: '0.00' },
      { minorUnits: -550n, currency: 'USD', decimal: '-5.50' },
      { minorUnits: -1n, currency: 'USD', decimal: '-0.01' },
      { minorUnits: 1_000_000_000n, currency: 'USD', decimal: '10000000.00' },
      { minorUnits: 100n, currency: 'JPY', decimal: '100' },
      { minorUnits: 0n, currency: 'JPY', decimal: '0' },
      { minorUnits: -250n, currency: 'JPY', decimal: '-250' },
      { minorUnits: 1234n, currency: 'KWD', decimal: '1.234' },
      { minorUnits: 1n, currency: 'KWD', decimal: '0.001' },
      { minorUnits: -1n, currency: 'KWD', decimal: '-0.001' },
    ];

    it.each(cases)(
      'writes $minorUnits minor units of $currency as $decimal',
      ({ minorUnits, currency, decimal }) => {
        expect(
          Money.fromMinorUnits(minorUnits, currency).toDecimalString(),
        ).toBe(decimal);
      },
    );

    it.each(cases)(
      'reads $decimal $currency back as the same amount',
      ({ minorUnits, currency, decimal }) => {
        expect(Money.fromDecimalString(decimal, currency).minorUnits).toBe(
          minorUnits,
        );
      },
    );

    it('puts the currency next to the digits in a log line', () => {
      expect(usd(10_000n).toString()).toBe('100.00 USD');
    });
  });

  describe('adding amounts', () => {
    it('sums two amounts in the same currency', () => {
      expect(usd(10_000n).add(usd(2_500n)).minorUnits).toBe(12_500n);
    });

    it('leaves the amounts it was given untouched', () => {
      const held = usd(10_000n);

      held.add(usd(2_500n));

      expect(held.minorUnits).toBe(10_000n);
    });

    it('treats zero as the identity', () => {
      expect(Money.zero('USD').add(usd(2_500n)).equals(usd(2_500n))).toBe(true);
    });

    it('refuses to add euros to dollars', () => {
      expect(() => usd(10_000n).add(eur(10_000n))).toThrow(
        CurrencyMismatchError,
      );
    });

    it('names both currencies so the mismatch can be reported', () => {
      const error = thrown(CurrencyMismatchError, () =>
        usd(10_000n).add(eur(10_000n)),
      );

      expect([error.expected, error.actual]).toEqual(['USD', 'EUR']);
    });

    it('carries a stable code the HTTP layer can translate', () => {
      expect(new CurrencyMismatchError('add', 'USD', 'EUR').code).toBe(
        'CURRENCY_MISMATCH',
      );
    });

    it('stays exact past the point where a JS number would round', () => {
      expect(usd(BEYOND_SAFE_INTEGER).add(usd(1n)).minorUnits).toBe(
        9_007_199_254_740_994n,
      );
    });
  });

  describe('subtracting amounts', () => {
    it('releases capacity back', () => {
      expect(usd(10_000n).subtract(usd(2_500n)).minorUnits).toBe(7_500n);
    });

    it('goes below zero rather than clamping, because an over-utilised program has to be reportable', () => {
      expect(usd(2_500n).subtract(usd(10_000n)).minorUnits).toBe(-7_500n);
    });

    it('refuses to subtract euros from dollars', () => {
      expect(() => usd(10_000n).subtract(eur(1n))).toThrow(
        CurrencyMismatchError,
      );
    });
  });

  describe('negating an amount', () => {
    it('turns a reservation into the release delta the audit log records', () => {
      expect(usd(10_000n).negate().minorUnits).toBe(-10_000n);
    });

    it('turns a negative amount positive', () => {
      expect(usd(-10_000n).negate().minorUnits).toBe(10_000n);
    });

    it('leaves zero alone', () => {
      expect(Money.zero('USD').negate().minorUnits).toBe(0n);
    });
  });

  describe('ordering amounts', () => {
    const cases: { left: bigint; right: bigint; sign: -1 | 0 | 1 }[] = [
      { left: 10_000n, right: 9_999n, sign: 1 },
      { left: 9_999n, right: 10_000n, sign: -1 },
      { left: 10_000n, right: 10_000n, sign: 0 },
      { left: 0n, right: -1n, sign: 1 },
      { left: -10_000n, right: -9_999n, sign: -1 },
      { left: BEYOND_SAFE_INTEGER, right: BEYOND_SAFE_INTEGER - 1n, sign: 1 },
    ];

    it.each(cases)(
      'compares $left with $right as $sign',
      ({ left, right, sign }) => {
        expect(usd(left).compare(usd(right))).toBe(sign);
      },
    );

    it('refuses to order two different currencies', () => {
      expect(() => usd(10_000n).compare(eur(10_000n))).toThrow(
        CurrencyMismatchError,
      );
    });

    it('sees enough capacity when available exceeds the request', () => {
      expect(usd(10_000n).isGreaterThanOrEqual(usd(9_999n))).toBe(true);
    });

    it('sees enough capacity when available exactly meets the request', () => {
      expect(usd(10_000n).isGreaterThanOrEqual(usd(10_000n))).toBe(true);
    });

    it('sees insufficient capacity when the request exceeds available by one minor unit', () => {
      expect(usd(9_999n).isGreaterThanOrEqual(usd(10_000n))).toBe(false);
    });

    it('sees insufficient capacity one minor unit past the safe-integer range', () => {
      expect(
        usd(BEYOND_SAFE_INTEGER).isGreaterThanOrEqual(
          usd(BEYOND_SAFE_INTEGER + 1n),
        ),
      ).toBe(false);
    });

    it('refuses to compare available dollars with a request in euros', () => {
      expect(() => usd(10_000n).isGreaterThanOrEqual(eur(1n))).toThrow(
        CurrencyMismatchError,
      );
    });
  });

  describe('testing amounts for equality', () => {
    it('finds two identical amounts equal', () => {
      expect(usd(10_000n).equals(usd(10_000n))).toBe(true);
    });

    it('finds amounts differing by one minor unit unequal', () => {
      expect(usd(10_000n).equals(usd(9_999n))).toBe(false);
    });

    it('finds the same figure in another currency unequal rather than incomparable', () => {
      expect(usd(10_000n).equals(eur(10_000n))).toBe(false);
    });
  });

  describe('testing the sign of an amount', () => {
    const cases: {
      minorUnits: bigint;
      zero: boolean;
      positive: boolean;
      negative: boolean;
    }[] = [
      { minorUnits: 0n, zero: true, positive: false, negative: false },
      { minorUnits: 1n, zero: false, positive: true, negative: false },
      { minorUnits: -1n, zero: false, positive: false, negative: true },
    ];

    it.each(cases)(
      'describes $minorUnits minor units as zero=$zero positive=$positive negative=$negative',
      ({ minorUnits, zero, positive, negative }) => {
        const amount = usd(minorUnits);

        expect([
          amount.isZero(),
          amount.isPositive(),
          amount.isNegative(),
        ]).toEqual([zero, positive, negative]);
      },
    );
  });

  describe('the JSON representation', () => {
    it('writes the minor units as a string, never a number', () => {
      expect(usd(10_000n).toJSON()).toEqual({
        amount: '10000',
        currency: 'USD',
      });
    });

    it('is used automatically by JSON.stringify', () => {
      expect(JSON.stringify(usd(10_000n))).toBe(
        '{"amount":"10000","currency":"USD"}',
      );
    });

    const roundTripped: { minorUnits: bigint; currency: CurrencyCode }[] = [
      { minorUnits: 10_000n, currency: 'USD' },
      { minorUnits: 0n, currency: 'USD' },
      { minorUnits: -7_500n, currency: 'USD' },
      { minorUnits: 100n, currency: 'JPY' },
      { minorUnits: 1n, currency: 'KWD' },
      { minorUnits: BEYOND_SAFE_INTEGER, currency: 'USD' },
    ];

    it.each(roundTripped)(
      'survives a round trip through JSON as $minorUnits minor units of $currency',
      ({ minorUnits, currency }) => {
        const original = Money.fromMinorUnits(minorUnits, currency);

        const wire = JSON.parse(JSON.stringify(original)) as MoneyJson;

        expect(Money.fromJSON(wire).equals(original)).toBe(true);
      },
    );

    it('refuses a decimal amount, which is a different notation entirely', () => {
      expect(() => Money.fromJSON({ amount: '10.5', currency: 'USD' })).toThrow(
        InvalidAmountError,
      );
    });

    it.each(['', ' ', 'abc', '1e3', '1,000', '+100'])(
      'refuses the malformed minor-unit string %p',
      (amount) => {
        expect(() => Money.fromJSON({ amount, currency: 'USD' })).toThrow(
          InvalidAmountError,
        );
      },
    );

    it('refuses an unsupported currency code', () => {
      expect(() =>
        Money.fromJSON({ amount: '10000', currency: 'XYZ' }),
      ).toThrow(UnknownCurrencyError);
    });
  });

  describe('precision at scale', () => {
    it('holds an amount a JS number would already have rounded', () => {
      expect(usd(BEYOND_SAFE_INTEGER).minorUnits).toBe(BEYOND_SAFE_INTEGER);
    });

    it('is protected against a rounding a JS number genuinely performs', () => {
      // Guards the assumption behind the test above: this is not a theoretical
      // worry, Number() really does lose this value.
      expect(BigInt(Number(BEYOND_SAFE_INTEGER))).not.toBe(BEYOND_SAFE_INTEGER);
    });

    it('serialises such an amount without passing through a number', () => {
      expect(usd(BEYOND_SAFE_INTEGER).toJSON().amount).toBe('9007199254740993');
    });
  });

  describe('rejecting a currency the service does not support', () => {
    /**
     * The cast is the point of these tests, not a way around the type system.
     * `CurrencyCode` only holds inside the domain; every real caller reaches
     * these factories with a `string`. Cycle 2 hydrates a reservation with
     * `Money.fromMinorUnits(BigInt(row.amount), row.currency)` where
     * `row.currency` is a `varchar`, and a Kafka payload arrives the same way.
     * `currency.ts` names exactly those two sources as untrusted input, so
     * every factory has to check the code rather than trust the annotation.
     */
    const UNSUPPORTED = 'XYZ' as CurrencyCode;

    const paths: { path: string; build: () => Money }[] = [
      {
        path: 'fromMinorUnits',
        build: () => Money.fromMinorUnits(10_000n, UNSUPPORTED),
      },
      { path: 'zero', build: () => Money.zero(UNSUPPORTED) },
      {
        path: 'fromDecimalString',
        build: () => Money.fromDecimalString('100.00', UNSUPPORTED),
      },
      {
        path: 'fromJSON',
        build: () => Money.fromJSON({ amount: '10000', currency: 'XYZ' }),
      },
    ];

    it.each(paths)(
      'refuses an unsupported code when built through $path',
      ({ build }) => {
        expect(build).toThrow(UnknownCurrencyError);
      },
    );

    it('refuses a stored row whose currency the service does not support, before anything can render it', () => {
      // How persistence will call this in cycle 2: a BIGINT column and a
      // varchar one, neither of which the database constrains to our table.
      const row = { amount: '10000', currency: 'XYZ' };

      expect(() =>
        Money.fromMinorUnits(
          BigInt(row.amount),
          row.currency as CurrencyCode,
        ).toDecimalString(),
      ).toThrow(UnknownCurrencyError);
    });

    it('does not let an unknown code disable the excess-precision guard', () => {
      // A currency with no exponent has no precision to exceed, so the check
      // that refuses "100.123456" quietly stops applying and the amount is
      // accepted at whatever precision the caller wrote.
      expect(() => Money.fromDecimalString('100.123456', UNSUPPORTED)).toThrow(
        UnknownCurrencyError,
      );
    });
  });
});

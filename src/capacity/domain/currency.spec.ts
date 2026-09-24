import {
  CURRENCY_EXPONENTS,
  exponentOf,
  isCurrencyCode,
  parseCurrencyCode,
  type CurrencyCode,
  type CurrencyExponent,
} from './currency';
import { DomainError, UnknownCurrencyError } from './errors';

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

describe('currencies', () => {
  describe('exponents', () => {
    const cases: { currency: CurrencyCode; exponent: CurrencyExponent }[] = [
      { currency: 'USD', exponent: 2 },
      { currency: 'EUR', exponent: 2 },
      { currency: 'GBP', exponent: 2 },
      { currency: 'PLN', exponent: 2 },
      { currency: 'JPY', exponent: 0 },
      { currency: 'KRW', exponent: 0 },
      { currency: 'KWD', exponent: 3 },
      { currency: 'BHD', exponent: 3 },
      { currency: 'TND', exponent: 3 },
    ];

    it.each(cases)(
      '$currency subdivides into $exponent decimal places',
      ({ currency, exponent }) => {
        expect(exponentOf(currency)).toBe(exponent);
      },
    );

    it('supports all three subdivisions ISO 4217 actually uses', () => {
      const exponents = [...new Set(Object.values(CURRENCY_EXPONENTS))];

      expect(exponents.sort()).toEqual([0, 2, 3]);
    });
  });

  describe('parsing a code from untrusted input', () => {
    it('accepts a supported code and returns it unchanged', () => {
      expect(parseCurrencyCode('USD')).toBe('USD');
    });

    it('accepts a currency whose exponent is not two', () => {
      expect(parseCurrencyCode('KWD')).toBe('KWD');
    });

    it('refuses a code the service does not support', () => {
      expect(() => parseCurrencyCode('XYZ')).toThrow(UnknownCurrencyError);
    });

    it('refuses a lower-case code rather than normalising it', () => {
      expect(() => parseCurrencyCode('usd')).toThrow(UnknownCurrencyError);
    });

    it.each(['', ' ', 'US', 'USDD', 'US1', ' USD', 'USD '])(
      'refuses %p, which is not an ISO 4217 code',
      (value) => {
        expect(() => parseCurrencyCode(value)).toThrow(UnknownCurrencyError);
      },
    );

    it('reports the offending code, so the client can be told what was wrong', () => {
      expect(
        thrown(UnknownCurrencyError, () => parseCurrencyCode('XYZ')).value,
      ).toBe('XYZ');
    });
  });

  describe('recognising a code', () => {
    it.each(['USD', 'JPY', 'KWD'])('recognises %p', (value) => {
      expect(isCurrencyCode(value)).toBe(true);
    });

    it.each(['XYZ', 'usd', '', 'US'])('does not recognise %p', (value) => {
      expect(isCurrencyCode(value)).toBe(false);
    });

    it.each([null, undefined, 840, 840n, true, {}])(
      'does not recognise the non-string %p',
      (value) => {
        expect(isCurrencyCode(value)).toBe(false);
      },
    );
  });

  describe('as a mappable error', () => {
    it('carries a stable code the HTTP layer can translate', () => {
      const error = new UnknownCurrencyError('XYZ');

      expect(error.code).toBe('UNKNOWN_CURRENCY');
    });

    it('is a domain error, so one exception filter catches every case', () => {
      expect(new UnknownCurrencyError('XYZ')).toBeInstanceOf(DomainError);
    });
  });

  // Last in the file on purpose: until the table is frozen, the second test
  // below can mutate the module-level table the earlier tests read.
  describe('the exponent table itself', () => {
    it('is frozen, because every amount in a currency is stated relative to it', () => {
      expect(Object.isFrozen(CURRENCY_EXPONENTS)).toBe(true);
    });

    it('refuses the stray assignment that would restate every USD amount at once', () => {
      // The table is exported for readers; nothing may write to it. A shipped
      // build has no reason to, but an exponent silently dropping from 2 to 0
      // would misstate every dollar figure in the service by a factor of 100.
      const table = CURRENCY_EXPONENTS as unknown as Record<string, number>;

      try {
        expect(() => {
          table.USD = 0;
        }).toThrow(TypeError);

        // The assertion that matters. Throwing is how a frozen object refuses a
        // write in strict mode, which ES modules always are; in sloppy mode the
        // same write is a silent no-op. Either way the exponent must still be 2,
        // so assert the outcome rather than the mechanism.
        expect(CURRENCY_EXPONENTS.USD).toBe(2);
      } finally {
        if (!Object.isFrozen(CURRENCY_EXPONENTS)) {
          table.USD = 2;
        }
      }
    });
  });
});

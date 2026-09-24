import { type CurrencyCode } from '../capacity/domain/currency';
import { UnknownCurrencyError } from '../capacity/domain/errors';
import { InvalidFxRateError } from './errors';
import { FxRate, type FxRateSnapshot } from './fx-rate';

const AS_OF = new Date('2026-09-24T10:00:00.000Z');

/** A USD/EUR rate from a decimal quote, with everything else held constant. */
const quoted = (value: string): FxRate =>
  FxRate.fromDecimalString({
    base: 'USD',
    quote: 'EUR',
    value,
    source: 'ecb',
    asOf: AS_OF,
  });

const snapshotOf = (
  overrides: Partial<FxRateSnapshot> = {},
): FxRateSnapshot => ({
  base: 'USD',
  quote: 'EUR',
  scaledValue: '1098700000000',
  scale: 12,
  source: 'ecb',
  asOf: '2026-09-24T10:00:00.000Z',
  ...overrides,
});

describe('FxRate', () => {
  describe('the precision it guarantees', () => {
    it('quotes rates to twelve decimal places', () => {
      expect(FxRate.SCALE_EXPONENT).toBe(12);
    });

    it('scales every rate by that many powers of ten', () => {
      expect(FxRate.SCALE).toBe(10n ** BigInt(FxRate.SCALE_EXPONENT));
    });
  });

  describe('reading a quoted rate', () => {
    const cases: { value: string; scaledValue: bigint }[] = [
      { value: '1.0987', scaledValue: 1_098_700_000_000n },
      { value: '1', scaledValue: 1_000_000_000_000n },
      { value: '0.5', scaledValue: 500_000_000_000n },
      { value: '150.5', scaledValue: 150_500_000_000_000n },
      { value: '0.0066', scaledValue: 6_600_000_000n },
      { value: '1300', scaledValue: 1_300_000_000_000_000n },
      { value: '0.000000000001', scaledValue: 1n },
    ];

    it.each(cases)(
      'reads a rate of $value as $scaledValue scaled units',
      ({ value, scaledValue }) => {
        expect(quoted(value).scaledValue).toBe(scaledValue);
      },
    );

    it('refuses a rate finer than the precision it can guarantee', () => {
      expect(() => quoted('0.0000000000001')).toThrow(InvalidFxRateError);
    });

    it.each(['', ' ', 'abc', '1,5', '1e3', '.5', '1.', '1.0.9', '+1.5'])(
      'refuses the malformed quote %p',
      (value) => {
        expect(() => quoted(value)).toThrow(InvalidFxRateError);
      },
    );

    it('carries a stable code the HTTP layer can translate', () => {
      expect(new InvalidFxRateError('zero').code).toBe('INVALID_FX_RATE');
    });
  });

  describe('rates it refuses to hold', () => {
    it('refuses a rate of zero, which would price every invoice at nothing', () => {
      expect(() => quoted('0')).toThrow(InvalidFxRateError);
    });

    it('refuses a rate of zero however it is written', () => {
      expect(() => quoted('0.000000000000')).toThrow(InvalidFxRateError);
    });

    it('refuses a negative rate', () => {
      expect(() => quoted('-1.0987')).toThrow(InvalidFxRateError);
    });

    it('refuses a rate of a currency against itself, since that conversion needs no rate', () => {
      expect(() =>
        FxRate.fromDecimalString({
          base: 'USD',
          quote: 'USD',
          value: '1',
          source: 'ecb',
          asOf: AS_OF,
        }),
      ).toThrow(InvalidFxRateError);
    });

    it.each(['', '   '])(
      'refuses a rate whose source is %p, because provenance is the point of storing it',
      (source) => {
        expect(() =>
          FxRate.fromDecimalString({
            base: 'USD',
            quote: 'EUR',
            value: '1.0987',
            source,
            asOf: AS_OF,
          }),
        ).toThrow(InvalidFxRateError);
      },
    );

    it('refuses a rate with an unusable timestamp', () => {
      expect(() =>
        FxRate.fromDecimalString({
          base: 'USD',
          quote: 'EUR',
          value: '1.0987',
          source: 'ecb',
          asOf: new Date('not a date'),
        }),
      ).toThrow(InvalidFxRateError);
    });

    it('refuses a scaled rate of zero', () => {
      expect(() =>
        FxRate.of({
          base: 'USD',
          quote: 'EUR',
          scaledValue: 0n,
          source: 'ecb',
          asOf: AS_OF,
        }),
      ).toThrow(InvalidFxRateError);
    });

    it('refuses a negative scaled rate', () => {
      expect(() =>
        FxRate.of({
          base: 'USD',
          quote: 'EUR',
          scaledValue: -1n,
          source: 'ecb',
          asOf: AS_OF,
        }),
      ).toThrow(InvalidFxRateError);
    });

    /**
     * The casts stand in for the way rates actually arrive: a seeded row whose
     * `base`/`quote` are `varchar`, or a feed payload. `fromSnapshot` parses
     * both codes, but `of` and `fromDecimalString` are the paths a provider
     * adapter will reach for, and an unchecked code does not stay contained —
     * conversion later asks for its exponent, gets nothing back, and fails with
     * an untyped arithmetic error instead of a domain one.
     */
    const UNSUPPORTED = 'XYZ' as CurrencyCode;

    it('refuses a rate whose base currency the service does not support', () => {
      expect(() =>
        FxRate.of({
          base: UNSUPPORTED,
          quote: 'EUR',
          scaledValue: 1_098_700_000_000n,
          source: 'ecb',
          asOf: AS_OF,
        }),
      ).toThrow(UnknownCurrencyError);
    });

    it('refuses a rate whose quote currency the service does not support', () => {
      expect(() =>
        FxRate.of({
          base: 'USD',
          quote: UNSUPPORTED,
          scaledValue: 1_098_700_000_000n,
          source: 'ecb',
          asOf: AS_OF,
        }),
      ).toThrow(UnknownCurrencyError);
    });

    it('refuses a quoted pair the service does not support', () => {
      expect(() =>
        FxRate.fromDecimalString({
          base: 'USD',
          quote: UNSUPPORTED,
          value: '1.0987',
          source: 'ecb',
          asOf: AS_OF,
        }),
      ).toThrow(UnknownCurrencyError);
    });
  });

  describe('what it records about itself', () => {
    it('remembers which currency it prices', () => {
      expect(quoted('1.0987').base).toBe('USD');
    });

    it('remembers which currency it prices it in', () => {
      expect(quoted('1.0987').quote).toBe('EUR');
    });

    it('remembers where it came from', () => {
      expect(quoted('1.0987').source).toBe('ecb');
    });

    it('remembers when it was quoted', () => {
      expect(quoted('1.0987').asOf.toISOString()).toBe(
        '2026-09-24T10:00:00.000Z',
      );
    });

    it('does not share the timestamp with whoever supplied it, since a rate is frozen once taken', () => {
      const supplied = new Date('2026-09-24T10:00:00.000Z');
      const rate = FxRate.of({
        base: 'USD',
        quote: 'EUR',
        scaledValue: 1_098_700_000_000n,
        source: 'ecb',
        asOf: supplied,
      });

      supplied.setUTCFullYear(1999);

      expect(rate.asOf.toISOString()).toBe('2026-09-24T10:00:00.000Z');
    });

    it('does not share the timestamp with whoever reads it either, since the stored rate is evidence', () => {
      const rate = quoted('1.0987');

      rate.asOf.setUTCFullYear(1999);

      expect(rate.asOf.toISOString()).toBe('2026-09-24T10:00:00.000Z');
    });

    it('reports the instant it was quoted at however a reader treats the date it handed out', () => {
      const rate = quoted('1.0987');

      rate.asOf.setUTCFullYear(1999);

      expect(rate.toJSON().asOf).toBe('2026-09-24T10:00:00.000Z');
    });

    it('stays serialisable after a reader mishandles the date it handed out', () => {
      // A `Date` set to NaN makes `toISOString` throw, so a single careless
      // caller could stop a reservation being written at all.
      const rate = quoted('1.0987');

      rate.asOf.setTime(Number.NaN);

      expect(() => JSON.stringify(rate)).not.toThrow();
    });

    it('records its source without the whitespace a feed padded it with, so the audit trail does not split in two', () => {
      const rate = FxRate.fromDecimalString({
        base: 'USD',
        quote: 'EUR',
        value: '1.0987',
        source: '  ecb  ',
        asOf: AS_OF,
      });

      expect(rate.source).toBe('ecb');
    });

    it('keeps the instant it recorded whatever handle a holder can obtain on it', () => {
      // `asOf` hands out a copy, but a shallow clone of the rate — what a
      // logger, a serialiser or an `Object.assign` in a mapper produces —
      // copies whatever the instance carries as an own property, and a `Date`
      // copied that way is the very same object.
      const rate = quoted('1.0987');

      const handles: unknown[] = Object.values(Object.assign({}, rate));
      for (const handle of handles) {
        if (handle instanceof Date) {
          handle.setUTCFullYear(1999);
        }
      }

      expect(rate.toJSON().asOf).toBe('2026-09-24T10:00:00.000Z');
    });

    it('carries no copyable date for such a clone to reach in the first place', () => {
      const carried: unknown[] = Object.values(quoted('1.0987'));

      expect(carried.some((value) => value instanceof Date)).toBe(false);
    });

    it('stores that trimmed source, so two spellings cannot become two sources', () => {
      const rate = FxRate.fromDecimalString({
        base: 'USD',
        quote: 'EUR',
        value: '1.0987',
        source: '  ecb  ',
        asOf: AS_OF,
      });

      expect(rate.toJSON().source).toBe('ecb');
    });
  });

  describe('writing a rate out', () => {
    const cases: { scaledValue: bigint; decimal: string }[] = [
      { scaledValue: 1_098_700_000_000n, decimal: '1.0987' },
      { scaledValue: 1_000_000_000_000n, decimal: '1' },
      { scaledValue: 500_000_000_000n, decimal: '0.5' },
      { scaledValue: 1n, decimal: '0.000000000001' },
      { scaledValue: 150_500_000_000_000n, decimal: '150.5' },
    ];

    it.each(cases)(
      'writes $scaledValue scaled units as $decimal',
      ({ scaledValue, decimal }) => {
        const rate = FxRate.of({
          base: 'USD',
          quote: 'EUR',
          scaledValue,
          source: 'ecb',
          asOf: AS_OF,
        });

        expect(rate.toDecimalString()).toBe(decimal);
      },
    );

    it('drops the trailing zeros a feed may have padded the quote with', () => {
      expect(quoted('1.098700').toDecimalString()).toBe('1.0987');
    });
  });

  describe('the stored form', () => {
    it('records the rate, its scale, its source and its timestamp', () => {
      expect(quoted('1.0987').toJSON()).toEqual({
        base: 'USD',
        quote: 'EUR',
        scaledValue: '1098700000000',
        scale: 12,
        source: 'ecb',
        asOf: '2026-09-24T10:00:00.000Z',
      });
    });

    it('is used automatically by JSON.stringify, so it can go straight into jsonb', () => {
      expect(JSON.parse(JSON.stringify(quoted('0.5')))).toEqual(
        snapshotOf({ scaledValue: '500000000000' }),
      );
    });

    it('survives a round trip through storage unchanged', () => {
      const original = quoted('1.0987');

      expect(FxRate.fromSnapshot(original.toJSON()).toJSON()).toEqual(
        original.toJSON(),
      );
    });

    it('restores the exact rate, not a re-parsed approximation of it', () => {
      expect(FxRate.fromSnapshot(snapshotOf()).scaledValue).toBe(
        1_098_700_000_000n,
      );
    });

    it('refuses a row written under a different scale rather than misreading it by a factor of ten', () => {
      expect(() => FxRate.fromSnapshot(snapshotOf({ scale: 6 }))).toThrow(
        InvalidFxRateError,
      );
    });

    it.each(['1.5', '', 'abc', '1e12'])(
      'refuses the stored value %p, which is not an integer',
      (scaledValue) => {
        expect(() => FxRate.fromSnapshot(snapshotOf({ scaledValue }))).toThrow(
          InvalidFxRateError,
        );
      },
    );

    it('refuses a stored timestamp that is not a real instant', () => {
      expect(() =>
        FxRate.fromSnapshot(snapshotOf({ asOf: 'yesterday' })),
      ).toThrow(InvalidFxRateError);
    });

    it('refuses a stored currency the service no longer supports', () => {
      expect(() => FxRate.fromSnapshot(snapshotOf({ base: 'XYZ' }))).toThrow(
        UnknownCurrencyError,
      );
    });
  });

  /**
   * A stored timestamp is evidence, so it gets exactly one reading. `Date`
   * accepts far more than ISO 8601 and silently repairs what it cannot read
   * literally, which is the opposite of what an audit trail needs: a date that
   * does not exist has to be refused, not rolled into the next month, and a
   * form whose meaning depends on the host's timezone has to be refused, not
   * resolved differently on every machine that reads the row.
   */
  describe('reading a stored timestamp', () => {
    const restored = (asOf: string): Date =>
      FxRate.fromSnapshot(snapshotOf({ asOf })).asOf;

    describe('dates that do not exist', () => {
      it.each([
        '2024-02-30T00:00:00Z',
        '2023-02-29T00:00:00Z',
        '1900-02-29T00:00:00Z',
        '2024-13-01T00:00:00Z',
        '2024-00-01T00:00:00Z',
        '2024-05-32T00:00:00Z',
        '2024-05-00T00:00:00Z',
      ])('refuses %p rather than rolling it into the next month', (asOf) => {
        expect(() => restored(asOf)).toThrow(InvalidFxRateError);
      });

      it.each([
        '2024-05-01T24:00:00Z',
        '2024-05-01T00:60:00Z',
        '2016-12-31T23:59:60Z',
      ])('refuses %p rather than rolling it into the next day', (asOf) => {
        expect(() => restored(asOf)).toThrow(InvalidFxRateError);
      });
    });

    describe('forms whose meaning is not fixed', () => {
      it.each([
        '12/25/2024',
        'March 5, 2024',
        '2024',
        '2024-05',
        '2024-05-01',
        '2024-05-01T00:00:00',
        '2024-05-01T00:00:00+02:00',
        '2024-05-01T00:00:00-05:00',
        '2024-05-01T00:00:00z',
        '2024-05-01 00:00:00Z',
        '2024-05-01T00:00:00.1234Z',
        ' 2024-05-01T00:00:00Z',
        '2024-05-01T00:00:00Z ',
        '',
      ])('refuses %p, which has no single reading', (asOf) => {
        expect(() => restored(asOf)).toThrow(InvalidFxRateError);
      });

      it('refuses a local-calendar date that would mean a different instant in Warsaw than in New York', () => {
        // The case that makes this a correctness rule rather than a style one:
        // `new Date('12/25/2024')` resolves against the host's timezone, so the
        // same stored row would name two different instants on two replicas.
        expect(() => restored('12/25/2024')).toThrow(InvalidFxRateError);
      });
    });

    describe('fractions of a second', () => {
      const cases: { asOf: string; milliseconds: number }[] = [
        { asOf: '2024-05-01T00:00:00Z', milliseconds: 0 },
        { asOf: '2024-05-01T00:00:00.5Z', milliseconds: 500 },
        { asOf: '2024-05-01T00:00:00.05Z', milliseconds: 50 },
        { asOf: '2024-05-01T00:00:00.005Z', milliseconds: 5 },
        { asOf: '2024-05-01T00:00:00.50Z', milliseconds: 500 },
        { asOf: '2024-05-01T00:00:00.999Z', milliseconds: 999 },
      ];

      it.each(cases)(
        'reads the fraction in $asOf as $milliseconds milliseconds',
        ({ asOf, milliseconds }) => {
          expect(restored(asOf).getUTCMilliseconds()).toBe(milliseconds);
        },
      );

      it('reads a half second as 500 milliseconds and not as 5', () => {
        // A fraction is padded on the right, never read as a plain integer.
        expect(restored('2024-05-01T00:00:00.5Z').getUTCMilliseconds()).toBe(
          500,
        );
      });
    });

    describe('instants that are real', () => {
      it.each(['2024-02-29T00:00:00Z', '2000-02-29T00:00:00Z'])(
        'accepts %p, which is a genuine leap day',
        (asOf) => {
          expect(restored(asOf).toISOString()).toBe(
            new Date(asOf).toISOString(),
          );
        },
      );

      it.each([
        '2024-01-01T00:00:00.000Z',
        '2024-05-01T00:00:00.005Z',
        '2024-05-01T00:00:00.050Z',
        '2024-05-01T00:00:00.500Z',
        '2024-05-01T00:00:00.999Z',
        '2024-12-31T23:59:59.999Z',
        '2024-02-29T12:00:00.000Z',
      ])('carries %p through a store-and-restore cycle unchanged', (asOf) => {
        const stored = FxRate.of({
          base: 'USD',
          quote: 'EUR',
          scaledValue: 1_098_700_000_000n,
          source: 'ecb',
          asOf: new Date(asOf),
        }).toJSON();

        expect(FxRate.fromSnapshot(stored).toJSON().asOf).toBe(asOf);
      });
    });
  });
});

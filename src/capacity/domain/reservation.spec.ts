import {
  InvalidReservationError,
  ReservationStateError,
} from './capacity-errors';
import { CurrencyMismatchError, DomainError } from './errors';
import { Money } from './money';
import {
  Reservation,
  type ReleaseReason,
  type ReservationState,
} from './reservation';
import { applyRate, type Conversion } from '../../fx/convert';
import { FxRate } from '../../fx/fx-rate';

const usd = (minorUnits: bigint): Money =>
  Money.fromMinorUnits(minorUnits, 'USD');
const eur = (minorUnits: bigint): Money =>
  Money.fromMinorUnits(minorUnits, 'EUR');
const jpy = (minorUnits: bigint): Money =>
  Money.fromMinorUnits(minorUnits, 'JPY');

/**
 * Two above `Number.MAX_SAFE_INTEGER`. A 10M USD program limit is only 1e9
 * minor units, so this is far past anything the business needs — which is the
 * point: the aggregate must not acquire a cliff that `Money` does not have.
 */
const BEYOND_SAFE_INTEGER = 9_007_199_254_740_993n;

const RESERVED_AT = new Date('2026-01-15T10:32:00.000Z');
const RELEASED_AT = new Date('2026-04-15T09:00:00.000Z');

/** EUR per USD, as the seeded table would quote it. */
const EUR_PER_USD = FxRate.fromDecimalString({
  base: 'USD',
  quote: 'EUR',
  value: '0.9235',
  source: 'seed',
  asOf: RESERVED_AT,
});

/** An amount already in the program's currency: no conversion, no rate. */
const unconverted = (amount: Money): Conversion => ({
  original: amount,
  converted: amount,
  rate: null,
});

/** 100,000.00 USD priced into EUR at {@link EUR_PER_USD}. */
const convertedUsdToEur: Conversion = {
  original: usd(10_000_000n),
  converted: eur(9_235_000n),
  rate: EUR_PER_USD,
};

const storedState = (
  overrides: Partial<ReservationState> = {},
): ReservationState => ({
  programId: 'program-1',
  invoiceId: 'invoice-1',
  status: 'ACTIVE',
  originalAmount: usd(10_000_000n),
  reservedAmount: usd(10_000_000n),
  releasedAmount: usd(0n),
  fxRate: null,
  reservedAt: RESERVED_AT,
  releasedAt: null,
  releaseReason: null,
  ...overrides,
});

const activeReservation = (
  overrides: Partial<ReservationState> = {},
): Reservation => Reservation.rehydrate(storedState(overrides));

const releasedReservation = (
  overrides: Partial<ReservationState> = {},
): Reservation =>
  Reservation.rehydrate(
    storedState({
      status: 'RELEASED',
      releasedAmount: usd(10_000_000n),
      releasedAt: RELEASED_AT,
      releaseReason: 'REPAID',
      ...overrides,
    }),
  );

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

describe('Reservation', () => {
  describe('opening a hold on capacity', () => {
    const opened = (): Reservation =>
      Reservation.open({
        programId: 'program-1',
        invoiceId: 'invoice-1',
        amount: unconverted(usd(10_000_000n)),
        reservedAt: RESERVED_AT,
      });

    it('belongs to the program it was opened against', () => {
      expect(opened().programId).toBe('program-1');
    });

    it('names the invoice whose capacity it holds', () => {
      expect(opened().invoiceId).toBe('invoice-1');
    });

    it('starts active', () => {
      expect(opened().status).toBe('ACTIVE');
    });

    it('holds the amount in the program currency, not the amount invoiced', () => {
      const reservation = Reservation.open({
        programId: 'program-1',
        invoiceId: 'invoice-1',
        amount: convertedUsdToEur,
        reservedAt: RESERVED_AT,
      });

      expect(reservation.reservedAmount.equals(eur(9_235_000n))).toBe(true);
    });

    it('keeps the amount the client stated, so the invoice can still be recognised', () => {
      const reservation = Reservation.open({
        programId: 'program-1',
        invoiceId: 'invoice-1',
        amount: convertedUsdToEur,
        reservedAt: RESERVED_AT,
      });

      expect(reservation.originalAmount.equals(usd(10_000_000n))).toBe(true);
    });

    it('has released nothing yet', () => {
      expect(opened().releasedAmount.isZero()).toBe(true);
    });

    it('carries its whole amount as outstanding exposure', () => {
      expect(opened().outstandingAmount.equals(usd(10_000_000n))).toBe(true);
    });

    it('records when the hold was taken', () => {
      expect(opened().reservedAt).toEqual(RESERVED_AT);
    });

    it('is not released, and names nobody for releasing it', () => {
      expect([
        opened().isActive(),
        opened().isReleased(),
        opened().releasedAt,
        opened().releaseReason,
      ]).toEqual([true, false, null, null]);
    });

    it('stores no FX evidence for an invoice already in the program currency', () => {
      expect(opened().fxRate).toBeNull();
    });

    it('reports that no rate priced it', () => {
      expect(opened().hasFxEvidence()).toBe(false);
    });

    it('stores the rate that priced an invoice in another currency', () => {
      const reservation = Reservation.open({
        programId: 'program-1',
        invoiceId: 'invoice-1',
        amount: convertedUsdToEur,
        reservedAt: RESERVED_AT,
      });

      expect(reservation.fxRate).toBe(EUR_PER_USD);
    });

    it('opens a hold far beyond what a JS number could hold', () => {
      const reservation = Reservation.open({
        programId: 'program-1',
        invoiceId: 'invoice-1',
        amount: unconverted(usd(BEYOND_SAFE_INTEGER)),
        reservedAt: RESERVED_AT,
      });

      expect(reservation.reservedAmount.minorUnits).toBe(BEYOND_SAFE_INTEGER);
    });

    it.each([0n, -1n, -10_000_000n])(
      'refuses to hold %p minor units, because a hold has to consume something',
      (minorUnits) => {
        expect(() =>
          Reservation.open({
            programId: 'program-1',
            invoiceId: 'invoice-1',
            amount: unconverted(usd(minorUnits)),
            reservedAt: RESERVED_AT,
          }),
        ).toThrow(InvalidReservationError);
      },
    );

    it.each(['', ' ', '\t'])('refuses the blank invoice id %p', (invoiceId) => {
      expect(() =>
        Reservation.open({
          programId: 'program-1',
          invoiceId,
          amount: unconverted(usd(10_000_000n)),
          reservedAt: RESERVED_AT,
        }),
      ).toThrow(InvalidReservationError);
    });

    it('refuses a blank program id', () => {
      expect(() =>
        Reservation.open({
          programId: '  ',
          invoiceId: 'invoice-1',
          amount: unconverted(usd(10_000_000n)),
          reservedAt: RESERVED_AT,
        }),
      ).toThrow(InvalidReservationError);
    });

    describe('FX evidence that contradicts the amounts it explains', () => {
      const contradictions: { why: string; amount: Conversion }[] = [
        {
          why: 'the currencies differ but no rate is recorded',
          amount: {
            original: usd(10_000_000n),
            converted: eur(9_235_000n),
            rate: null,
          },
        },
        {
          why: 'a rate is recorded although nothing was converted',
          amount: {
            original: usd(10_000_000n),
            converted: usd(10_000_000n),
            rate: EUR_PER_USD,
          },
        },
        {
          why: 'the rate does not price the currency invoiced',
          amount: {
            original: jpy(1_000_000n),
            converted: eur(9_235_000n),
            rate: EUR_PER_USD,
          },
        },
        {
          why: 'the rate does not produce the currency held',
          amount: {
            original: usd(10_000_000n),
            converted: jpy(1_000_000n),
            rate: EUR_PER_USD,
          },
        },
      ];

      it.each(contradictions)('refuses a hold where $why', ({ amount }) => {
        expect(() =>
          Reservation.open({
            programId: 'program-1',
            invoiceId: 'invoice-1',
            amount,
            reservedAt: RESERVED_AT,
          }),
        ).toThrow(InvalidReservationError);
      });
    });

    it('carries a stable code the HTTP layer can translate', () => {
      expect(new InvalidReservationError('amount must be positive').code).toBe(
        'INVALID_RESERVATION',
      );
    });
  });

  describe('rehydrating a stored reservation', () => {
    it('reads back every field of an active row', () => {
      const reservation = activeReservation({
        originalAmount: usd(10_000_000n),
        reservedAmount: eur(9_235_000n),
        releasedAmount: eur(0n),
        fxRate: EUR_PER_USD,
      });

      expect([
        reservation.programId,
        reservation.invoiceId,
        reservation.status,
        reservation.reservedAmount.toString(),
        reservation.releasedAmount.toString(),
        reservation.fxRate,
        reservation.reservedAt,
      ]).toEqual([
        'program-1',
        'invoice-1',
        'ACTIVE',
        '92350.00 EUR',
        '0.00 EUR',
        EUR_PER_USD,
        RESERVED_AT,
      ]);
    });

    it('reads back why and when a released row was released', () => {
      const reservation = releasedReservation({ releaseReason: 'CANCELLED' });

      expect([
        reservation.status,
        reservation.releaseReason,
        reservation.releasedAt,
        reservation.outstandingAmount.isZero(),
      ]).toEqual(['RELEASED', 'CANCELLED', RELEASED_AT, true]);
    });

    it('hands back a copy of the reservation timestamp, not the stored one', () => {
      const reservation = activeReservation();

      reservation.reservedAt.setUTCFullYear(1999);

      expect(reservation.reservedAt).toEqual(RESERVED_AT);
    });

    it('hands back a copy of the release timestamp, not the stored one', () => {
      const reservation = releasedReservation();

      reservation.releasedAt?.setUTCFullYear(1999);

      expect(reservation.releasedAt).toEqual(RELEASED_AT);
    });

    const inconsistent: { why: string; state: Partial<ReservationState> }[] = [
      {
        why: 'it is active but says why it was released',
        state: { releaseReason: 'REPAID' },
      },
      {
        why: 'it is active but says when it was released',
        state: { releasedAt: RELEASED_AT },
      },
      {
        why: 'it is released but does not say when',
        state: {
          status: 'RELEASED',
          releasedAmount: usd(10_000_000n),
          releasedAt: null,
          releaseReason: 'REPAID',
        },
      },
      {
        why: 'it is released but does not say why',
        state: {
          status: 'RELEASED',
          releasedAmount: usd(10_000_000n),
          releasedAt: RELEASED_AT,
          releaseReason: null,
        },
      },
      {
        why: 'it is released but still holds capacity',
        state: {
          status: 'RELEASED',
          releasedAmount: usd(4_000_000n),
          releasedAt: RELEASED_AT,
          releaseReason: 'REPAID',
        },
      },
      {
        why: 'it has released more than it ever held',
        state: {
          status: 'RELEASED',
          releasedAmount: usd(10_000_001n),
          releasedAt: RELEASED_AT,
          releaseReason: 'REPAID',
        },
      },
      {
        why: 'it has released a negative amount',
        state: { releasedAmount: usd(-1n) },
      },
      {
        why: 'it holds nothing at all',
        state: { reservedAmount: usd(0n) },
      },
      {
        why: 'it holds a negative amount',
        state: { reservedAmount: usd(-10_000_000n) },
      },
      {
        why: 'what it released is not in the currency it holds',
        state: { releasedAmount: eur(0n) },
      },
      {
        why: 'the currencies differ but no rate was stored',
        state: { reservedAmount: eur(9_235_000n), fxRate: null },
      },
      {
        why: 'a rate was stored although nothing was converted',
        state: { fxRate: EUR_PER_USD },
      },
      {
        why: 'the stored rate does not price the currency invoiced',
        state: {
          originalAmount: jpy(1_000_000n),
          reservedAmount: eur(9_235_000n),
          fxRate: EUR_PER_USD,
        },
      },
      {
        why: 'the stored rate does not produce the currency held',
        state: {
          reservedAmount: jpy(1_000_000n),
          fxRate: EUR_PER_USD,
        },
      },
    ];

    it.each(inconsistent)('refuses a row where $why', ({ state }) => {
      expect(() => Reservation.rehydrate(storedState(state))).toThrow(
        InvalidReservationError,
      );
    });
  });

  describe('releasing a hold', () => {
    it('becomes released', () => {
      const reservation = activeReservation();

      reservation.release('REPAID', RELEASED_AT);

      expect(reservation.status).toBe('RELEASED');
    });

    it('gives back exactly what it held, as a negative delta', () => {
      const reservation = activeReservation();

      expect(
        reservation
          .release('REPAID', RELEASED_AT)
          .delta.equals(usd(-10_000_000n)),
      ).toBe(true);
    });

    it('gives back exactly the converted amount, never a re-converted one', () => {
      const reservation = activeReservation({
        originalAmount: usd(10_000_000n),
        reservedAmount: eur(9_235_000n),
        releasedAmount: eur(0n),
        fxRate: EUR_PER_USD,
      });

      expect(
        reservation
          .release('REPAID', RELEASED_AT)
          .delta.equals(eur(-9_235_000n)),
      ).toBe(true);
    });

    it('reports that something actually changed', () => {
      expect(activeReservation().release('REPAID', RELEASED_AT).applied).toBe(
        true,
      );
    });

    it('records the amount it gave back', () => {
      const reservation = activeReservation();

      reservation.release('REPAID', RELEASED_AT);

      expect(reservation.releasedAmount.equals(usd(10_000_000n))).toBe(true);
    });

    it('holds no outstanding exposure afterwards', () => {
      const reservation = activeReservation();

      reservation.release('REPAID', RELEASED_AT);

      expect(reservation.outstandingAmount.isZero()).toBe(true);
    });

    it('records when it was released', () => {
      const reservation = activeReservation();

      reservation.release('REPAID', RELEASED_AT);

      expect(reservation.releasedAt).toEqual(RELEASED_AT);
    });

    it.each<ReleaseReason>(['REPAID', 'CANCELLED'])(
      'records that it was released as %s',
      (reason) => {
        const reservation = activeReservation();

        reservation.release(reason, RELEASED_AT);

        expect(reservation.releaseReason).toBe(reason);
      },
    );

    it.each<ReleaseReason>(['REPAID', 'CANCELLED'])(
      'frees the same capacity whether it was %s',
      (reason) => {
        expect(
          activeReservation()
            .release(reason, RELEASED_AT)
            .delta.equals(usd(-10_000_000n)),
        ).toBe(true);
      },
    );

    it('keeps the original amount and the rate, which are evidence of what was quoted', () => {
      const reservation = activeReservation({
        originalAmount: usd(10_000_000n),
        reservedAmount: eur(9_235_000n),
        releasedAmount: eur(0n),
        fxRate: EUR_PER_USD,
      });

      reservation.release('REPAID', RELEASED_AT);

      expect([
        reservation.originalAmount.toString(),
        reservation.fxRate,
      ]).toEqual(['100000.00 USD', EUR_PER_USD]);
    });

    describe('when it has already been released', () => {
      const LATER = new Date('2026-05-01T00:00:00.000Z');

      it('frees nothing the second time', () => {
        expect(
          releasedReservation().release('REPAID', LATER).delta.isZero(),
        ).toBe(true);
      });

      it('reports that nothing changed, rather than raising a conflict a racing consumer would have to swallow', () => {
        expect(releasedReservation().release('REPAID', LATER).applied).toBe(
          false,
        );
      });

      it('keeps the reason the first release recorded', () => {
        const reservation = releasedReservation({ releaseReason: 'CANCELLED' });

        reservation.release('REPAID', LATER);

        expect(reservation.releaseReason).toBe('CANCELLED');
      });

      it('keeps the moment the first release recorded', () => {
        const reservation = releasedReservation();

        reservation.release('REPAID', LATER);

        expect(reservation.releasedAt).toEqual(RELEASED_AT);
      });

      it('still holds no outstanding exposure', () => {
        const reservation = releasedReservation();

        reservation.release('REPAID', LATER);

        expect(reservation.outstandingAmount.isZero()).toBe(true);
      });
    });
  });

  describe('correcting what a hold is worth', () => {
    it('raises the held amount to what treasury says', () => {
      const reservation = activeReservation();

      reservation.correctTo(usd(12_000_000n));

      expect(reservation.reservedAmount.equals(usd(12_000_000n))).toBe(true);
    });

    it('reports the rise as a positive delta for the program to apply', () => {
      expect(
        activeReservation()
          .correctTo(usd(12_000_000n))
          .delta.equals(usd(2_000_000n)),
      ).toBe(true);
    });

    it('reports a reduction as a negative delta', () => {
      expect(
        activeReservation()
          .correctTo(usd(4_000_000n))
          .delta.equals(usd(-6_000_000n)),
      ).toBe(true);
    });

    it('moves the outstanding exposure with the correction', () => {
      const reservation = activeReservation();

      reservation.correctTo(usd(4_000_000n));

      expect(reservation.outstandingAmount.equals(usd(4_000_000n))).toBe(true);
    });

    it('leaves the invoiced amount and the stored rate alone, because the quote is not what changed', () => {
      const reservation = activeReservation({
        originalAmount: usd(10_000_000n),
        reservedAmount: eur(9_235_000n),
        releasedAmount: eur(0n),
        fxRate: EUR_PER_USD,
      });

      reservation.correctTo(eur(9_300_000n));

      expect([
        reservation.originalAmount.toString(),
        reservation.fxRate,
      ]).toEqual(['100000.00 USD', EUR_PER_USD]);
    });

    it('corrects to an amount far beyond what a JS number could hold', () => {
      const reservation = activeReservation({
        reservedAmount: usd(BEYOND_SAFE_INTEGER),
      });

      expect(
        reservation.correctTo(usd(BEYOND_SAFE_INTEGER + 1n)).delta.minorUnits,
      ).toBe(1n);
    });

    describe('to the amount it already holds', () => {
      it('changes nothing', () => {
        expect(
          activeReservation().correctTo(usd(10_000_000n)).delta.isZero(),
        ).toBe(true);
      });

      it('reports that nothing changed, so a repeated snapshot writes no audit entry', () => {
        expect(activeReservation().correctTo(usd(10_000_000n)).applied).toBe(
          false,
        );
      });
    });

    it('refuses to correct a reservation that holds nothing any more', () => {
      expect(() => releasedReservation().correctTo(usd(12_000_000n))).toThrow(
        ReservationStateError,
      );
    });

    it('names the invoice and the state that blocked the correction', () => {
      const error = thrown(ReservationStateError, () =>
        releasedReservation().correctTo(usd(12_000_000n)),
      );

      expect([error.invoiceId, error.status]).toEqual([
        'invoice-1',
        'RELEASED',
      ]);
    });

    it('carries a stable code the HTTP layer can translate', () => {
      expect(
        new ReservationStateError('invoice-1', 'RELEASED', 'correct').code,
      ).toBe('RESERVATION_STATE_CONFLICT');
    });

    it.each([0n, -1n])(
      'refuses a correction to %p minor units, which is not an exposure',
      (minorUnits) => {
        expect(() => activeReservation().correctTo(usd(minorUnits))).toThrow(
          InvalidReservationError,
        );
      },
    );

    it('refuses a correction stated in another currency', () => {
      expect(() => activeReservation().correctTo(eur(9_235_000n))).toThrow(
        CurrencyMismatchError,
      );
    });
  });

  /**
   * Partial releases are out of scope (docs/PLAN.md 2.5, 5). The *schema* keeps
   * `reservedAmount` and `releasedAmount` apart so they remain a later feature
   * rather than a migration, but the *domain* accepts only states it can itself
   * produce: an active hold has released nothing, and a row claiming otherwise
   * does not load.
   *
   * This is a scope boundary, not a data-integrity rule. Nothing about such a
   * row is corrupt — it is a perfectly coherent description of a feature nobody
   * has written. Loading it would mean every operation quietly acquiring a
   * second case to be correct about, guarded by nothing and exercised by no
   * caller; the tests below are what stop that case existing until partial
   * releases are implemented deliberately, with their own rules and their own
   * audit semantics.
   */
  describe('a stored hold that claims to be half released', () => {
    /**
     * Holds 10,000.00 USD. Each case varies only what it claims to have given
     * back, and whether it fills in the lifecycle fields that would accompany
     * such a release — none of which makes the row loadable.
     */
    const halfReleased = (
      releasedAmount: Money,
      overrides: Partial<ReservationState> = {},
    ): ReservationState =>
      storedState({
        originalAmount: usd(1_000_000n),
        reservedAmount: usd(1_000_000n),
        releasedAmount,
        releasedAt: RELEASED_AT,
        releaseReason: 'CANCELLED',
        ...overrides,
      });

    const claims: { what: string; releasedAmount: Money }[] = [
      { what: 'part of what it holds', releasedAmount: usd(400_000n) },
      { what: 'a single minor unit', releasedAmount: usd(1n) },
      { what: 'everything it holds', releasedAmount: usd(1_000_000n) },
      { what: 'more than it ever held', releasedAmount: usd(1_000_001n) },
    ];

    it.each(claims)(
      'refuses an active row that says it has given back $what',
      ({ releasedAmount }) => {
        expect(() =>
          Reservation.rehydrate(halfReleased(releasedAmount)),
        ).toThrow(InvalidReservationError);
      },
    );

    it.each(claims)(
      'refuses it even with no release recorded against the $what it claims to have given back',
      ({ releasedAmount }) => {
        expect(() =>
          Reservation.rehydrate(
            halfReleased(releasedAmount, {
              releasedAt: null,
              releaseReason: null,
            }),
          ),
        ).toThrow(InvalidReservationError);
      },
    );

    it('loads the same row once it says it has given nothing back', () => {
      const reservation = Reservation.rehydrate(
        halfReleased(usd(0n), { releasedAt: null, releaseReason: null }),
      );

      expect([
        reservation.status,
        reservation.releasedAmount.isZero(),
        reservation.outstandingAmount.toString(),
      ]).toEqual(['ACTIVE', true, '10000.00 USD']);
    });

    it('still loads a row that gave everything back, which is a state the service does produce', () => {
      const reservation = releasedReservation();

      expect([
        reservation.status,
        reservation.outstandingAmount.isZero(),
      ]).toEqual(['RELEASED', true]);
    });

    it('holds the whole of what it reserved, so a release frees the whole of it', () => {
      // The consequence of the boundary, stated positively: with the partial
      // state unreachable, outstanding and reserved are the same quantity, and
      // a release can only ever hand capacity back.
      const reservation = activeReservation({
        reservedAmount: usd(1_000_000n),
      });

      expect(
        reservation
          .release('REPAID', RELEASED_AT)
          .delta.equals(usd(-1_000_000n)),
      ).toBe(true);
    });

    it('frees exactly what a correction left it holding, never more', () => {
      const reservation = activeReservation({
        reservedAmount: usd(1_000_000n),
      });

      reservation.correctTo(usd(800_000n));

      expect(
        reservation.release('REPAID', RELEASED_AT).delta.equals(usd(-800_000n)),
      ).toBe(true);
    });
  });

  /**
   * Cycle 1's `convert` guarantees these properties of a {@link Conversion}, but
   * `Reservation.open` is reached by callers that never went through it: cycle
   * 3's snapshot anti-corruption layer builds a conversion from a treasury
   * message, and a hand-assembled one needs no cast to typecheck. A conversion
   * is evidence, so the reservation checks the evidence rather than trusting its
   * provenance.
   */
  describe('a conversion that contradicts itself in ways the type cannot express', () => {
    const openWith = (amount: Conversion): Reservation =>
      Reservation.open({
        programId: 'program-1',
        invoiceId: 'invoice-1',
        amount,
        reservedAt: RESERVED_AT,
      });

    it('refuses a hold that consumes more than the invoice it was built from, although no currency changed', () => {
      // 100.00 USD invoiced, 999,000.00 USD held. Currencies agree, so the
      // FX rules have nothing to say; the two amounts still cannot both be true.
      expect(() =>
        openWith({
          original: usd(10_000n),
          converted: usd(99_900_000n),
          rate: null,
        }),
      ).toThrow(InvalidReservationError);
    });

    it('refuses a hold that consumes less than the invoice it was built from', () => {
      expect(() =>
        openWith({
          original: usd(10_000_000n),
          converted: usd(1n),
          rate: null,
        }),
      ).toThrow(InvalidReservationError);
    });

    it('accepts an unconverted hold whose two amounts agree', () => {
      expect(
        openWith(unconverted(usd(10_000_000n))).reservedAmount.equals(
          usd(10_000_000n),
        ),
      ).toBe(true);
    });

    it('refuses a hold whose stored rate does not produce the amount held', () => {
      // 100,000.00 USD at 0.9235 is 92,350.00 EUR, not 0.01 EUR. The rate is
      // documented as the reproducible half of the evidence, so a rate that
      // does not reproduce the figure next to it explains nothing.
      expect(() =>
        openWith({
          original: usd(10_000_000n),
          converted: eur(1n),
          rate: EUR_PER_USD,
        }),
      ).toThrow(InvalidReservationError);
    });

    it('refuses a hold whose stored rate produces one minor unit less than it holds', () => {
      expect(() =>
        openWith({
          original: usd(10_000_000n),
          converted: eur(9_235_001n),
          rate: EUR_PER_USD,
        }),
      ).toThrow(InvalidReservationError);
    });

    it('accepts the amount the stored rate actually produces, ceiling and all', () => {
      const amount: Conversion = {
        original: usd(10_000_000n),
        converted: applyRate(usd(10_000_000n), EUR_PER_USD),
        rate: EUR_PER_USD,
      };

      expect(openWith(amount).reservedAmount.equals(eur(9_235_000n))).toBe(
        true,
      );
    });

    it('accepts a rate whose conversion rounded up, since the ceiling is where the minor unit went', () => {
      // 0.01 USD at 0.9235 is 0.009235 EUR, which cycle 1 rounds up to 0.01
      // EUR. A checker that recomputed with truncation would reject this.
      const amount: Conversion = {
        original: usd(1n),
        converted: applyRate(usd(1n), EUR_PER_USD),
        rate: EUR_PER_USD,
      };

      expect(openWith(amount).reservedAmount.equals(eur(1n))).toBe(true);
    });

    /**
     * The invoiced amount is checked before anything is recomputed from it.
     * Otherwise the same malformed request is refused by two different classes
     * depending on whether a conversion happened — `applyRate` refuses a
     * negative amount itself, with cycle 1's `INVALID_AMOUNT` — and the HTTP
     * layer maps by class, so one shape of bad request would surface as two
     * different codes. Which one a client sees should not depend on the
     * program's currency.
     */
    describe('an invoiced amount that could never have been invoiced', () => {
      /** The code of the refusal, so the two shapes can be compared directly. */
      const codeOfRefusal = (amount: Conversion): string => {
        try {
          openWith(amount);
        } catch (error) {
          return error instanceof DomainError
            ? error.code
            : 'not a domain error';
        }

        return 'nothing was thrown';
      };

      const malformed: {
        what: string;
        converted: boolean;
        amount: Conversion;
      }[] = [
        {
          what: 'a negative invoiced amount',
          converted: false,
          amount: {
            original: usd(-10n),
            converted: usd(-10n),
            rate: null,
          },
        },
        {
          what: 'a negative invoiced amount',
          converted: true,
          amount: {
            original: usd(-10n),
            converted: eur(10n),
            rate: EUR_PER_USD,
          },
        },
        {
          what: 'an invoiced amount of nothing',
          converted: false,
          amount: {
            original: usd(0n),
            converted: usd(0n),
            rate: null,
          },
        },
        {
          what: 'an invoiced amount of nothing',
          converted: true,
          amount: {
            original: usd(0n),
            converted: eur(1n),
            rate: EUR_PER_USD,
          },
        },
      ];

      it.each(malformed)(
        'refuses $what as a broken reservation (converted: $converted)',
        ({ amount }) => {
          expect(() => openWith(amount)).toThrow(InvalidReservationError);
        },
      );

      it('refuses a negative invoiced amount with the same code whether or not a rate was involved', () => {
        expect([
          codeOfRefusal(malformed[1]!.amount),
          codeOfRefusal(malformed[0]!.amount),
        ]).toEqual(['INVALID_RESERVATION', 'INVALID_RESERVATION']);
      });

      it('refuses an invoiced amount of nothing with the same code whether or not a rate was involved', () => {
        expect([
          codeOfRefusal(malformed[3]!.amount),
          codeOfRefusal(malformed[2]!.amount),
        ]).toEqual(['INVALID_RESERVATION', 'INVALID_RESERVATION']);
      });

      it('still recomputes an acceptable hold through the rate, ceiling included', () => {
        // The guard goes in front of `applyRate`, not instead of it: the hold
        // has to keep being the figure cycle 1's rounding produces.
        expect(
          openWith({
            original: usd(1n),
            converted: eur(1n),
            rate: EUR_PER_USD,
          }).reservedAmount.equals(eur(1n)),
        ).toBe(true);
      });
    });

    it('still rehydrates an unconverted hold whose held amount is not the amount invoiced, because a correction restated it', () => {
      // The same boundary as below, for the no-rate case: `open` may insist that
      // an unconverted hold consumes exactly what was invoiced, but a stored row
      // must not, or no corrected reservation could ever be loaded again.
      const reservation = Reservation.rehydrate(
        storedState({
          originalAmount: usd(10_000_000n),
          reservedAmount: usd(12_000_000n),
        }),
      );

      expect(reservation.reservedAmount.toString()).toBe('120000.00 USD');
    });

    it('still rehydrates a converted hold whose held amount no longer matches its stored rate, because a correction restated it', () => {
      // The counterpart rule: reconciliation changes the held amount and
      // deliberately keeps the original rate (docs/PLAN.md 2.1, 2.3), so a
      // stored row is *expected* to drift from its rate. The rate check belongs
      // to `open` alone and must not migrate into the shared helper.
      const reservation = Reservation.rehydrate(
        storedState({
          originalAmount: usd(10_000_000n),
          reservedAmount: eur(9_300_000n),
          releasedAmount: eur(0n),
          fxRate: EUR_PER_USD,
        }),
      );

      expect(reservation.reservedAmount.toString()).toBe('93000.00 EUR');
    });

    it('does not re-check the stored rate when a correction restates the held amount', () => {
      const reservation = activeReservation({
        originalAmount: usd(10_000_000n),
        reservedAmount: eur(9_235_000n),
        releasedAmount: eur(0n),
        fxRate: EUR_PER_USD,
      });

      reservation.correctTo(eur(9_300_000n));

      expect([
        reservation.reservedAmount.toString(),
        reservation.fxRate,
      ]).toEqual(['93000.00 EUR', EUR_PER_USD]);
    });
  });

  /**
   * §2.1 decides whether a reservation missing from a snapshot is in flight or a
   * discrepancy by comparing its instant against the snapshot's `asOf`. Every
   * comparison against `NaN` is `false`, so a row with an unreadable timestamp
   * does not fail loudly — it silently sorts into "older than `asOf`" and is
   * flagged as a discrepancy. The instant is data the reconciliation depends on,
   * so it is validated like any other field.
   */
  describe('rehydrating a row whose timestamps cannot be read', () => {
    const NOT_A_DATE = new Date('not a date');

    it('refuses a row that does not say when the hold was taken', () => {
      expect(() =>
        Reservation.rehydrate(storedState({ reservedAt: NOT_A_DATE })),
      ).toThrow(InvalidReservationError);
    });

    it('refuses a released row that does not say when it was released', () => {
      expect(() =>
        Reservation.rehydrate(
          storedState({
            status: 'RELEASED',
            releasedAmount: usd(10_000_000n),
            releasedAt: NOT_A_DATE,
            releaseReason: 'REPAID',
          }),
        ),
      ).toThrow(InvalidReservationError);
    });

    it('refuses a row released before it was ever reserved', () => {
      expect(() =>
        Reservation.rehydrate(
          storedState({
            status: 'RELEASED',
            releasedAmount: usd(10_000_000n),
            reservedAt: RESERVED_AT,
            releasedAt: new Date('2022-01-15T10:32:00.000Z'),
            releaseReason: 'REPAID',
          }),
        ),
      ).toThrow(InvalidReservationError);
    });

    it('accepts a row released at the very instant it was reserved, which is legal if unusual', () => {
      const reservation = Reservation.rehydrate(
        storedState({
          status: 'RELEASED',
          releasedAmount: usd(10_000_000n),
          reservedAt: RESERVED_AT,
          releasedAt: RESERVED_AT,
          releaseReason: 'CANCELLED',
        }),
      );

      expect(reservation.releasedAt).toEqual(RESERVED_AT);
    });
  });

  describe('identifiers that arrived with padding', () => {
    it('trims the identifiers a new hold is opened with, so one invoice is not two', () => {
      const reservation = Reservation.open({
        programId: ' program-1 ',
        invoiceId: ' invoice-1\t',
        amount: unconverted(usd(10_000_000n)),
        reservedAt: RESERVED_AT,
      });

      expect([reservation.programId, reservation.invoiceId]).toEqual([
        'program-1',
        'invoice-1',
      ]);
    });

    it('trims the identifiers of a stored row as well', () => {
      const reservation = Reservation.rehydrate(
        storedState({ programId: '  program-1', invoiceId: 'invoice-1  ' }),
      );

      expect([reservation.programId, reservation.invoiceId]).toEqual([
        'program-1',
        'invoice-1',
      ]);
    });
  });
});

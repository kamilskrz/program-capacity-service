import {
  CapacityInvariantError,
  DuplicateInvoiceError,
  InsufficientCapacityError,
  InvalidCreditLimitError,
  InvalidProgramError,
  InvalidReservationError,
  MissingAuditContextError,
  ReservationNotInProgramError,
  ReservationStateError,
} from './capacity-errors';
import { type CapacityChangeContext } from './capacity-event';
import { CurrencyMismatchError } from './errors';
import { Money } from './money';
import { Program, type ProgramState, type ReservationRequest } from './program';
import { Reservation, type ReservationState } from './reservation';
import { type Conversion } from '../../fx/convert';
import { FxRate } from '../../fx/fx-rate';

const usd = (minorUnits: bigint): Money =>
  Money.fromMinorUnits(minorUnits, 'USD');
const eur = (minorUnits: bigint): Money =>
  Money.fromMinorUnits(minorUnits, 'EUR');

/** 10,000,000.00 USD — the program limit of docs/PLAN.md 1, in minor units. */
const LIMIT = 1_000_000_000n;

/**
 * Two above `Number.MAX_SAFE_INTEGER`. A 10M limit is only 1e9 minor units, so
 * a program has no business being near this — which is the point: neither the
 * availability arithmetic nor the audit delta may acquire a cliff that `Money`
 * does not have.
 */
const BEYOND_SAFE_INTEGER = 9_007_199_254_740_993n;

const OCCURRED_AT = new Date('2026-01-15T10:32:00.000Z');
const LATER = new Date('2026-04-15T09:00:00.000Z');

const EUR_PER_USD = FxRate.fromDecimalString({
  base: 'USD',
  quote: 'EUR',
  value: '0.9235',
  source: 'seed',
  asOf: OCCURRED_AT,
});

/** An invoice already in the program's currency: no conversion, no rate. */
const unconverted = (amount: Money): Conversion => ({
  original: amount,
  converted: amount,
  rate: null,
});

/** 100,000.00 USD priced into EUR at {@link EUR_PER_USD}. */
const usdInvoiceInEurProgram: Conversion = {
  original: usd(10_000_000n),
  converted: eur(9_235_000n),
  rate: EUR_PER_USD,
};

const programOf = (overrides: Partial<ProgramState> = {}): Program =>
  Program.rehydrate({
    id: 'program-1',
    ownerOrgId: 'org-1',
    currency: 'USD',
    creditLimit: usd(LIMIT),
    reserved: usd(0n),
    ...overrides,
  });

const eurProgramOf = (overrides: Partial<ProgramState> = {}): Program =>
  programOf({
    currency: 'EUR',
    creditLimit: eur(LIMIT),
    reserved: eur(0n),
    ...overrides,
  });

const request = (
  overrides: Partial<ReservationRequest> = {},
): ReservationRequest => ({
  invoiceId: 'invoice-1',
  amount: unconverted(usd(250_000_000n)),
  ...overrides,
});

const context = (
  overrides: Partial<CapacityChangeContext> = {},
): CapacityChangeContext => ({
  actor: 'user-42',
  source: 'API',
  correlationId: 'request-7',
  occurredAt: OCCURRED_AT,
  ...overrides,
});

/** A stored, active hold in `program-1`, by default for 2,500,000.00 USD. */
const heldReservation = (
  overrides: Partial<ReservationState> = {},
): Reservation =>
  Reservation.rehydrate({
    programId: 'program-1',
    invoiceId: 'invoice-1',
    status: 'ACTIVE',
    originalAmount: usd(250_000_000n),
    reservedAmount: usd(250_000_000n),
    releasedAmount: usd(0n),
    fxRate: null,
    reservedAt: OCCURRED_AT,
    releasedAt: null,
    releaseReason: null,
    ...overrides,
  });

/** The same hold, already released. */
const releasedReservation = (
  overrides: Partial<ReservationState> = {},
): Reservation =>
  heldReservation({
    status: 'RELEASED',
    releasedAmount: usd(250_000_000n),
    releasedAt: LATER,
    releaseReason: 'REPAID',
    ...overrides,
  });

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

describe('Program', () => {
  describe('opening a program', () => {
    const opened = (): Program =>
      Program.create({
        id: 'program-1',
        ownerOrgId: 'org-1',
        currency: 'USD',
        creditLimit: usd(LIMIT),
      });

    it('starts with nothing reserved', () => {
      expect(opened().reserved.isZero()).toBe(true);
    });

    it('starts with its whole limit available', () => {
      expect(opened().available.equals(usd(LIMIT))).toBe(true);
    });

    it('is not over-utilised', () => {
      expect(opened().overUtilized).toBe(false);
    });

    it('keeps the agreement it was opened under', () => {
      const program = opened();

      expect([
        program.id,
        program.ownerOrgId,
        program.currency,
        program.creditLimit.toString(),
      ]).toEqual(['program-1', 'org-1', 'USD', '10000000.00 USD']);
    });

    it('accepts a zero limit, which is how a program is suspended rather than deleted', () => {
      const program = Program.create({
        id: 'program-1',
        ownerOrgId: 'org-1',
        currency: 'USD',
        creditLimit: usd(0n),
      });

      expect(program.hasCapacityFor(usd(1n))).toBe(false);
    });

    it('refuses a negative credit limit', () => {
      expect(() =>
        Program.create({
          id: 'program-1',
          ownerOrgId: 'org-1',
          currency: 'USD',
          creditLimit: usd(-1n),
        }),
      ).toThrow(InvalidCreditLimitError);
    });

    it('refuses a limit stated in a currency other than the program currency', () => {
      expect(() =>
        Program.create({
          id: 'program-1',
          ownerOrgId: 'org-1',
          currency: 'USD',
          creditLimit: eur(LIMIT),
        }),
      ).toThrow(InvalidCreditLimitError);
    });

    it.each(['', '   '])('refuses the blank program id %p', (id) => {
      expect(() =>
        Program.create({
          id,
          ownerOrgId: 'org-1',
          currency: 'USD',
          creditLimit: usd(LIMIT),
        }),
      ).toThrow(InvalidProgramError);
    });

    it('refuses a program that belongs to nobody', () => {
      expect(() =>
        Program.create({
          id: 'program-1',
          ownerOrgId: ' ',
          currency: 'USD',
          creditLimit: usd(LIMIT),
        }),
      ).toThrow(InvalidProgramError);
    });

    it('carries a stable code the HTTP layer can translate', () => {
      expect(new InvalidCreditLimitError('negative').code).toBe(
        'INVALID_CREDIT_LIMIT',
      );
    });
  });

  describe('rehydrating a stored program', () => {
    it('reads the denormalized reserved total back', () => {
      expect(
        programOf({ reserved: usd(250_000_000n) }).reserved.toString(),
      ).toBe('2500000.00 USD');
    });

    it('reads back a program that is already over its limit, because that state has to load', () => {
      const program = programOf({ reserved: usd(LIMIT + 1n) });

      expect([program.overUtilized, program.available.toString()]).toEqual([
        true,
        '-0.01 USD',
      ]);
    });

    it('refuses a negative reserved total, mirroring the CHECK constraint', () => {
      expect(() => programOf({ reserved: usd(-1n) })).toThrow(
        InvalidProgramError,
      );
    });

    it('refuses a reserved total stated in another currency', () => {
      expect(() => programOf({ reserved: eur(0n) })).toThrow(
        InvalidProgramError,
      );
    });
  });

  describe('the capacity a program has left', () => {
    const cases: { limit: bigint; reserved: bigint; available: bigint }[] = [
      { limit: LIMIT, reserved: 0n, available: LIMIT },
      { limit: LIMIT, reserved: 250_000_000n, available: 750_000_000n },
      { limit: LIMIT, reserved: LIMIT, available: 0n },
      { limit: LIMIT, reserved: LIMIT + 1n, available: -1n },
      { limit: 0n, reserved: 0n, available: 0n },
      { limit: 0n, reserved: 250_000_000n, available: -250_000_000n },
    ];

    it.each(cases)(
      'has $available minor units available on a limit of $limit with $reserved reserved',
      ({ limit, reserved, available }) => {
        expect(
          programOf({
            creditLimit: usd(limit),
            reserved: usd(reserved),
          }).available.minorUnits,
        ).toBe(available);
      },
    );

    it('goes below zero rather than clamping, so an overrun can be reported and alerted on', () => {
      expect(
        programOf({
          creditLimit: usd(400_000_000n),
          reserved: usd(1_000_000_000n),
        }).available.minorUnits,
      ).toBe(-600_000_000n);
    });

    const utilisation: { reserved: bigint; overUtilized: boolean }[] = [
      { reserved: 0n, overUtilized: false },
      { reserved: LIMIT - 1n, overUtilized: false },
      { reserved: LIMIT, overUtilized: false },
      { reserved: LIMIT + 1n, overUtilized: true },
    ];

    it.each(utilisation)(
      'reports overUtilized=$overUtilized with $reserved reserved',
      ({ reserved, overUtilized }) => {
        expect(programOf({ reserved: usd(reserved) }).overUtilized).toBe(
          overUtilized,
        );
      },
    );

    it('computes availability exactly past the range a JS number can hold', () => {
      expect(
        programOf({
          creditLimit: usd(BEYOND_SAFE_INTEGER + 1n),
          reserved: usd(BEYOND_SAFE_INTEGER),
        }).available.minorUnits,
      ).toBe(1n);
    });

    it('fits an amount exactly equal to what is available', () => {
      expect(
        programOf({ reserved: usd(900_000_000n) }).hasCapacityFor(
          usd(100_000_000n),
        ),
      ).toBe(true);
    });

    it('does not fit an amount one minor unit above what is available', () => {
      expect(
        programOf({ reserved: usd(900_000_000n) }).hasCapacityFor(
          usd(100_000_001n),
        ),
      ).toBe(false);
    });

    it('fits nothing at all once availability is negative', () => {
      expect(
        programOf({ reserved: usd(LIMIT + 1n) }).hasCapacityFor(usd(1n)),
      ).toBe(false);
    });

    it('refuses to weigh an amount in another currency against the limit', () => {
      expect(() => programOf().hasCapacityFor(eur(1n))).toThrow(
        CurrencyMismatchError,
      );
    });
  });

  describe('knowing which organisation a program belongs to', () => {
    it('recognises its owner', () => {
      expect(programOf().isOwnedBy('org-1')).toBe(true);
    });

    it('does not recognise another tenant', () => {
      expect(programOf().isOwnedBy('org-2')).toBe(false);
    });

    it('does not treat a blank organisation as a match', () => {
      expect(programOf().isOwnedBy('')).toBe(false);
    });
  });

  describe('reserving capacity for an invoice', () => {
    it('holds the requested amount against the limit', () => {
      const program = programOf();

      program.reserve(request(), null, context());

      expect(program.reserved.equals(usd(250_000_000n))).toBe(true);
    });

    it('leaves the rest of the limit available', () => {
      const program = programOf();

      program.reserve(request(), null, context());

      expect(program.available.equals(usd(750_000_000n))).toBe(true);
    });

    it('leaves the credit limit untouched', () => {
      const program = programOf();

      program.reserve(request(), null, context());

      expect(program.creditLimit.equals(usd(LIMIT))).toBe(true);
    });

    it('hands back an active reservation for the invoice', () => {
      const { reservation } = programOf().reserve(request(), null, context());

      expect([
        reservation.programId,
        reservation.invoiceId,
        reservation.status,
      ]).toEqual(['program-1', 'invoice-1', 'ACTIVE']);
    });

    it('dates the reservation from the moment the caller observed, not from a clock in the domain', () => {
      const { reservation } = programOf().reserve(
        request(),
        null,
        context({ occurredAt: LATER }),
      );

      expect(reservation.reservedAt).toEqual(LATER);
    });

    it('accepts an amount that fits exactly, to the last minor unit', () => {
      const program = programOf({ reserved: usd(900_000_000n) });

      program.reserve(
        request({ amount: unconverted(usd(100_000_000n)) }),
        null,
        context(),
      );

      expect(program.available.isZero()).toBe(true);
    });

    it('refuses an amount that exceeds what is available by one minor unit', () => {
      const program = programOf({ reserved: usd(900_000_000n) });

      expect(() =>
        program.reserve(
          request({ amount: unconverted(usd(100_000_001n)) }),
          null,
          context(),
        ),
      ).toThrow(InsufficientCapacityError);
    });

    it('holds nothing when it refuses', () => {
      const program = programOf({ reserved: usd(900_000_000n) });

      expect(() =>
        program.reserve(
          request({ amount: unconverted(usd(100_000_001n)) }),
          null,
          context(),
        ),
      ).toThrow(InsufficientCapacityError);
      expect(program.reserved.equals(usd(900_000_000n))).toBe(true);
    });

    it('refuses everything once the limit is fully drawn', () => {
      expect(() =>
        programOf({ reserved: usd(LIMIT) }).reserve(
          request({ amount: unconverted(usd(1n)) }),
          null,
          context(),
        ),
      ).toThrow(InsufficientCapacityError);
    });

    it('refuses everything while the program is over-utilised', () => {
      expect(() =>
        programOf({ reserved: usd(LIMIT + 1n) }).reserve(
          request({ amount: unconverted(usd(1n)) }),
          null,
          context(),
        ),
      ).toThrow(InsufficientCapacityError);
    });

    it('reports what was asked for and what was left, including a negative balance', () => {
      const error = thrown(InsufficientCapacityError, () =>
        programOf({ reserved: usd(LIMIT + 400_000_000n) }).reserve(
          request(),
          null,
          context(),
        ),
      );

      expect([
        error.programId,
        error.requested.toString(),
        error.available.toString(),
      ]).toEqual(['program-1', '2500000.00 USD', '-4000000.00 USD']);
    });

    it('carries a stable code the HTTP layer can translate to 409', () => {
      expect(
        new InsufficientCapacityError('program-1', usd(1n), usd(0n)).code,
      ).toBe('INSUFFICIENT_CAPACITY');
    });

    it('reserves an amount far beyond what a JS number could hold', () => {
      const program = programOf({
        creditLimit: usd(BEYOND_SAFE_INTEGER),
        reserved: usd(0n),
      });

      program.reserve(
        request({ amount: unconverted(usd(BEYOND_SAFE_INTEGER)) }),
        null,
        context(),
      );

      expect(program.available.isZero()).toBe(true);
    });

    it.each([0n, -250_000_000n])(
      'refuses to reserve %p minor units',
      (minorUnits) => {
        expect(() =>
          programOf().reserve(
            request({ amount: unconverted(usd(minorUnits)) }),
            null,
            context(),
          ),
        ).toThrow(InvalidReservationError);
      },
    );

    it('refuses a blank invoice id', () => {
      expect(() =>
        programOf().reserve(request({ invoiceId: '' }), null, context()),
      ).toThrow(InvalidReservationError);
    });
  });

  describe('reserving an invoice stated in another currency', () => {
    it('holds the converted amount, because only the program currency consumes the limit', () => {
      const program = eurProgramOf();

      program.reserve(
        request({ amount: usdInvoiceInEurProgram }),
        null,
        context(),
      );

      expect(program.reserved.equals(eur(9_235_000n))).toBe(true);
    });

    it('keeps the amount the client actually stated', () => {
      const { reservation } = eurProgramOf().reserve(
        request({ amount: usdInvoiceInEurProgram }),
        null,
        context(),
      );

      expect(reservation.originalAmount.equals(usd(10_000_000n))).toBe(true);
    });

    it('stores the rate as the evidence of how the held amount was arrived at', () => {
      const { reservation } = eurProgramOf().reserve(
        request({ amount: usdInvoiceInEurProgram }),
        null,
        context(),
      );

      expect(reservation.fxRate).toBe(EUR_PER_USD);
    });

    it('stores no FX evidence when the invoice was already in the program currency', () => {
      const { reservation } = programOf().reserve(request(), null, context());

      expect(reservation.fxRate).toBeNull();
    });

    it('refuses a conversion that did not land in the program currency', () => {
      expect(() =>
        programOf().reserve(
          request({ amount: usdInvoiceInEurProgram }),
          null,
          context(),
        ),
      ).toThrow(CurrencyMismatchError);
    });

    it('refuses an unconverted invoice in a currency the program does not use', () => {
      expect(() =>
        programOf().reserve(
          request({ amount: unconverted(eur(9_235_000n)) }),
          null,
          context(),
        ),
      ).toThrow(CurrencyMismatchError);
    });

    it('refuses a conversion whose rate does not price the currency invoiced', () => {
      expect(() =>
        eurProgramOf().reserve(
          request({
            amount: {
              original: eur(9_235_000n),
              converted: eur(9_235_000n),
              rate: EUR_PER_USD,
            },
          }),
          null,
          context(),
        ),
      ).toThrow(InvalidReservationError);
    });
  });

  describe('reserving an invoice this program already knows', () => {
    it('returns the stored reservation rather than holding capacity twice', () => {
      const program = programOf({ reserved: usd(250_000_000n) });
      const existing = heldReservation();

      const { reservation } = program.reserve(request(), existing, context());

      expect(reservation).toBe(existing);
    });

    it('does not move the reserved total on a replay', () => {
      const program = programOf({ reserved: usd(250_000_000n) });

      program.reserve(request(), heldReservation(), context());

      expect(program.reserved.equals(usd(250_000_000n))).toBe(true);
    });

    it('records nothing in the audit log for a replay, since nothing happened', () => {
      const { event } = programOf({ reserved: usd(250_000_000n) }).reserve(
        request(),
        heldReservation(),
        context(),
      );

      expect(event).toBeNull();
    });

    it('recognises the replay by the amount invoiced, not the amount held, because the rate was frozen at reservation time', () => {
      const program = eurProgramOf({ reserved: eur(9_235_000n) });
      const existing = Reservation.rehydrate({
        programId: 'program-1',
        invoiceId: 'invoice-1',
        status: 'ACTIVE',
        originalAmount: usd(10_000_000n),
        reservedAmount: eur(9_235_000n),
        releasedAmount: eur(0n),
        fxRate: EUR_PER_USD,
        reservedAt: OCCURRED_AT,
        releasedAt: null,
        releaseReason: null,
      });

      // The same invoice, re-sent after the rate moved: conversion today would
      // produce a different held amount, and that must not make it a new
      // request or re-price the existing hold.
      const { reservation, event } = program.reserve(
        request({
          amount: {
            original: usd(10_000_000n),
            converted: eur(9_400_000n),
            rate: FxRate.fromDecimalString({
              base: 'USD',
              quote: 'EUR',
              value: '0.94',
              source: 'seed',
              asOf: LATER,
            }),
          },
        }),
        existing,
        context({ occurredAt: LATER }),
      );

      expect([
        event,
        reservation.reservedAmount.toString(),
        program.reserved.toString(),
      ]).toEqual([null, '92350.00 EUR', '92350.00 EUR']);
    });

    it('refuses a repeat that states a different amount', () => {
      expect(() =>
        programOf({ reserved: usd(250_000_000n) }).reserve(
          request({ amount: unconverted(usd(250_000_001n)) }),
          heldReservation(),
          context(),
        ),
      ).toThrow(DuplicateInvoiceError);
    });

    it('refuses a repeat that states another currency', () => {
      expect(() =>
        eurProgramOf({ reserved: eur(9_235_000n) }).reserve(
          request({ amount: unconverted(eur(9_235_000n)) }),
          Reservation.rehydrate({
            programId: 'program-1',
            invoiceId: 'invoice-1',
            status: 'ACTIVE',
            originalAmount: usd(10_000_000n),
            reservedAmount: eur(9_235_000n),
            releasedAmount: eur(0n),
            fxRate: EUR_PER_USD,
            reservedAt: OCCURRED_AT,
            releasedAt: null,
            releaseReason: null,
          }),
          context(),
        ),
      ).toThrow(DuplicateInvoiceError);
    });

    it('refuses to reserve an invoice that was already released, because an invoice is financed once', () => {
      expect(() =>
        programOf().reserve(request(), releasedReservation(), context()),
      ).toThrow(DuplicateInvoiceError);
    });

    it('refuses even an identical repeat once the invoice has been released', () => {
      const error = thrown(DuplicateInvoiceError, () =>
        programOf().reserve(request(), releasedReservation(), context()),
      );

      expect([error.programId, error.invoiceId]).toEqual([
        'program-1',
        'invoice-1',
      ]);
    });

    it('carries a stable code the HTTP layer can translate to 409', () => {
      expect(
        new DuplicateInvoiceError('program-1', 'invoice-1', 'released').code,
      ).toBe('DUPLICATE_INVOICE');
    });

    it('refuses a reservation that belongs to a different program', () => {
      expect(() =>
        programOf().reserve(
          request(),
          heldReservation({ programId: 'program-2' }),
          context(),
        ),
      ).toThrow(ReservationNotInProgramError);
    });

    it('refuses a reservation for a different invoice', () => {
      expect(() =>
        programOf().reserve(
          request(),
          heldReservation({ invoiceId: 'invoice-2' }),
          context(),
        ),
      ).toThrow(ReservationNotInProgramError);
    });
  });

  describe('the audit entry a reservation produces', () => {
    const reserved = () =>
      programOf({ reserved: usd(250_000_000n) }).reserve(
        request({ invoiceId: 'invoice-2' }),
        null,
        context(),
      ).event!;

    it('records that capacity was reserved', () => {
      expect(reserved().type).toBe('RESERVED');
    });

    it('names the program and the invoice it concerns', () => {
      expect([reserved().programId, reserved().invoiceId]).toEqual([
        'program-1',
        'invoice-2',
      ]);
    });

    it('records the amount held as a positive delta', () => {
      expect(reserved().delta.equals(usd(250_000_000n))).toBe(true);
    });

    it('records the resulting reserved total, so the log can be checked against the row', () => {
      expect(reserved().resultingReserved.equals(usd(500_000_000n))).toBe(true);
    });

    it('agrees with the program it just changed', () => {
      const program = programOf({ reserved: usd(250_000_000n) });

      const { event } = program.reserve(
        request({ invoiceId: 'invoice-2' }),
        null,
        context(),
      );

      expect(event!.resultingReserved.equals(program.reserved)).toBe(true);
    });

    it('carries the provenance the caller supplied, which the domain could not know', () => {
      const event = reserved();

      expect([
        event.actor,
        event.source,
        event.correlationId,
        event.occurredAt,
      ]).toEqual(['user-42', 'API', 'request-7', OCCURRED_AT]);
    });

    it('accepts a change with no correlation id, which is how Kafka may deliver it', () => {
      const { event } = programOf().reserve(
        request(),
        null,
        context({ correlationId: null, source: 'TREASURY_SNAPSHOT' }),
      );

      expect([event!.correlationId, event!.source]).toEqual([
        null,
        'TREASURY_SNAPSHOT',
      ]);
    });

    it('records the amount invoiced next to the amount held', () => {
      const { event } = eurProgramOf().reserve(
        request({ amount: usdInvoiceInEurProgram }),
        null,
        context(),
      );

      expect(event!.metadata.originalAmount).toEqual({
        amount: '10000000',
        currency: 'USD',
      });
    });

    it('records the rate that priced a converted invoice', () => {
      const { event } = eurProgramOf().reserve(
        request({ amount: usdInvoiceInEurProgram }),
        null,
        context(),
      );

      expect(event!.metadata.fxRate).toEqual(EUR_PER_USD.toJSON());
    });

    it('records no rate when none was used, rather than an identity nobody quoted', () => {
      expect(reserved().metadata.fxRate).toBeUndefined();
    });

    it('takes provenance the caller alone knows, such as the snapshot it came from', () => {
      const { event } = programOf().reserve(
        request(),
        null,
        context({
          source: 'TREASURY_SNAPSHOT',
          actor: 'treasury:kafka',
          metadata: { snapshotSequence: 42 },
        }),
      );

      expect(event!.metadata.snapshotSequence).toBe(42);
    });

    it('does not let caller-supplied metadata restate a fact the domain computed', () => {
      const { event } = programOf().reserve(
        request(),
        null,
        context({
          metadata: { originalAmount: { amount: '1', currency: 'USD' } },
        }),
      );

      expect(event!.metadata.originalAmount).toEqual({
        amount: '250000000',
        currency: 'USD',
      });
    });
  });

  describe('releasing capacity', () => {
    it('returns the reserved total to exactly what it was before the hold', () => {
      const program = programOf();
      const { reservation } = program.reserve(request(), null, context());

      program.release(reservation, 'REPAID', context({ occurredAt: LATER }));

      expect(program.reserved.isZero()).toBe(true);
    });

    it('returns the reserved total to exactly its prior value for a converted hold', () => {
      const program = eurProgramOf({ reserved: eur(400_000_000n) });
      const { reservation } = program.reserve(
        request({ amount: usdInvoiceInEurProgram }),
        null,
        context(),
      );

      program.release(reservation, 'REPAID', context({ occurredAt: LATER }));

      expect(program.reserved.equals(eur(400_000_000n))).toBe(true);
    });

    it('frees exactly what was held, never what the invoice would convert to today', () => {
      const program = eurProgramOf({ reserved: eur(9_235_000n) });
      const reservation = Reservation.rehydrate({
        programId: 'program-1',
        invoiceId: 'invoice-1',
        status: 'ACTIVE',
        originalAmount: usd(10_000_000n),
        reservedAmount: eur(9_235_000n),
        releasedAmount: eur(0n),
        fxRate: EUR_PER_USD,
        reservedAt: OCCURRED_AT,
        releasedAt: null,
        releaseReason: null,
      });

      const { event } = program.release(
        reservation,
        'REPAID',
        context({ occurredAt: LATER }),
      );

      expect([program.reserved.isZero(), event!.delta.toString()]).toEqual([
        true,
        '-92350.00 EUR',
      ]);
    });

    it('marks the reservation released', () => {
      const program = programOf({ reserved: usd(250_000_000n) });
      const reservation = heldReservation();

      program.release(reservation, 'REPAID', context({ occurredAt: LATER }));

      expect([
        reservation.status,
        reservation.releaseReason,
        reservation.releasedAt,
      ]).toEqual(['RELEASED', 'REPAID', LATER]);
    });

    it.each(['REPAID', 'CANCELLED'] as const)(
      'frees the capacity whether the invoice was %s',
      (reason) => {
        const program = programOf({ reserved: usd(250_000_000n) });

        program.release(heldReservation(), reason, context());

        expect(program.reserved.isZero()).toBe(true);
      },
    );

    it.each(['REPAID', 'CANCELLED'] as const)(
      'records %s in the audit trail, because risk reads the two differently',
      (reason) => {
        const { event } = programOf({
          reserved: usd(250_000_000n),
        }).release(heldReservation(), reason, context());

        expect(event!.metadata.reason).toBe(reason);
      },
    );

    it('makes capacity available again', () => {
      const program = programOf({ reserved: usd(LIMIT) });

      program.release(heldReservation(), 'REPAID', context());

      expect(program.available.equals(usd(250_000_000n))).toBe(true);
    });

    it('refuses a reservation belonging to another program', () => {
      expect(() =>
        programOf({ reserved: usd(250_000_000n) }).release(
          heldReservation({ programId: 'program-2' }),
          'REPAID',
          context(),
        ),
      ).toThrow(ReservationNotInProgramError);
    });

    it('names both programs so the mix-up can be traced', () => {
      const error = thrown(ReservationNotInProgramError, () =>
        programOf({ reserved: usd(250_000_000n) }).release(
          heldReservation({ programId: 'program-2' }),
          'REPAID',
          context(),
        ),
      );

      expect([error.programId, error.reservationProgramId]).toEqual([
        'program-1',
        'program-2',
      ]);
    });

    it('refuses a reservation holding another currency', () => {
      expect(() =>
        programOf({ reserved: usd(250_000_000n) }).release(
          heldReservation({
            originalAmount: eur(250_000_000n),
            reservedAmount: eur(250_000_000n),
            releasedAmount: eur(0n),
          }),
          'REPAID',
          context(),
        ),
      ).toThrow(CurrencyMismatchError);
    });

    it('refuses to free more than the program has reserved, rather than manufacturing capacity', () => {
      expect(() =>
        programOf({ reserved: usd(100_000_000n) }).release(
          heldReservation(),
          'REPAID',
          context(),
        ),
      ).toThrow(CapacityInvariantError);
    });

    it('carries a stable code for the invariant breach', () => {
      expect(
        new CapacityInvariantError('reserved would go negative').code,
      ).toBe('CAPACITY_INVARIANT_VIOLATED');
    });
  });

  describe('releasing an invoice that is already released', () => {
    it('leaves the reserved total exactly where it was', () => {
      const program = programOf({ reserved: usd(250_000_000n) });

      program.release(releasedReservation(), 'REPAID', context());

      expect(program.reserved.equals(usd(250_000_000n))).toBe(true);
    });

    it('writes no second audit entry, so the log does not claim capacity moved twice', () => {
      const { event } = programOf({ reserved: usd(250_000_000n) }).release(
        releasedReservation(),
        'REPAID',
        context(),
      );

      expect(event).toBeNull();
    });

    it('hands back the reservation in its current state, which is what a racing REST call and InvoiceRepaid both need', () => {
      const existing = releasedReservation();

      const { reservation } = programOf({
        reserved: usd(250_000_000n),
      }).release(existing, 'CANCELLED', context());

      expect([reservation, reservation.releaseReason]).toEqual([
        existing,
        'REPAID',
      ]);
    });

    it('releases only once when the same release arrives twice', () => {
      const program = programOf();
      const { reservation } = program.reserve(request(), null, context());

      program.release(reservation, 'REPAID', context({ occurredAt: LATER }));
      program.release(reservation, 'REPAID', context({ occurredAt: LATER }));

      expect(program.reserved.isZero()).toBe(true);
    });
  });

  describe('the audit entry a release produces', () => {
    const released = () =>
      programOf({ reserved: usd(400_000_000n) }).release(
        heldReservation(),
        'REPAID',
        context(),
      ).event!;

    it('records that capacity was released', () => {
      expect(released().type).toBe('RELEASED');
    });

    it('records what was freed as a negative delta', () => {
      expect(released().delta.equals(usd(-250_000_000n))).toBe(true);
    });

    it('records the resulting reserved total', () => {
      expect(released().resultingReserved.equals(usd(150_000_000n))).toBe(true);
    });

    it('names the invoice whose hold was freed', () => {
      expect(released().invoiceId).toBe('invoice-1');
    });
  });

  describe('a program that is over its limit', () => {
    /** 12.5M reserved against a 10M limit: 2.5M over. */
    const overUtilized = (): Program =>
      programOf({ reserved: usd(1_250_000_000n) });

    it('reports itself as over-utilised', () => {
      expect(overUtilized().overUtilized).toBe(true);
    });

    it('reports how far over it is, as a negative availability', () => {
      expect(overUtilized().available.toString()).toBe('-2500000.00 USD');
    });

    it('refuses even the smallest new reservation', () => {
      expect(() =>
        overUtilized().reserve(
          request({ amount: unconverted(usd(1n)) }),
          null,
          context(),
        ),
      ).toThrow(InsufficientCapacityError);
    });

    it('still accepts a release, which is the only way back', () => {
      const program = overUtilized();

      program.release(heldReservation(), 'REPAID', context());

      expect(program.reserved.equals(usd(1_000_000_000n))).toBe(true);
    });

    it('reduces the overrun by exactly what the release freed', () => {
      const program = overUtilized();

      program.release(
        heldReservation({
          originalAmount: usd(100_000_000n),
          reservedAmount: usd(100_000_000n),
        }),
        'REPAID',
        context(),
      );

      expect(program.available.toString()).toBe('-1500000.00 USD');
    });

    it('is back within its limit once enough has been released', () => {
      const program = overUtilized();

      program.release(heldReservation(), 'REPAID', context());

      expect([program.overUtilized, program.available.isZero()]).toEqual([
        false,
        true,
      ]);
    });

    it('accepts reservations again once enough has been freed to leave room', () => {
      const program = programOf({ reserved: usd(1_250_000_000n) });

      program.release(
        heldReservation({
          originalAmount: usd(300_000_000n),
          reservedAmount: usd(300_000_000n),
        }),
        'REPAID',
        context(),
      );
      program.reserve(
        request({
          invoiceId: 'invoice-2',
          amount: unconverted(usd(1n)),
        }),
        null,
        context(),
      );

      expect(program.reserved.equals(usd(950_000_001n))).toBe(true);
    });
  });

  describe('correcting a hold after reconciliation', () => {
    it('raises the reserved total by the difference when treasury says the invoice is bigger', () => {
      const program = programOf({ reserved: usd(250_000_000n) });

      program.correctReservation(
        heldReservation(),
        usd(300_000_000n),
        context(),
      );

      expect(program.reserved.equals(usd(300_000_000n))).toBe(true);
    });

    it('lowers it by the difference when the invoice is smaller', () => {
      const program = programOf({ reserved: usd(250_000_000n) });

      program.correctReservation(
        heldReservation(),
        usd(100_000_000n),
        context(),
      );

      expect(program.reserved.equals(usd(100_000_000n))).toBe(true);
    });

    it('leaves the rest of the reserved total alone, adjusting only the difference', () => {
      const program = programOf({ reserved: usd(400_000_000n) });

      program.correctReservation(
        heldReservation(),
        usd(300_000_000n),
        context(),
      );

      expect(program.reserved.equals(usd(450_000_000n))).toBe(true);
    });

    it('restates what the reservation holds', () => {
      const program = programOf({ reserved: usd(250_000_000n) });
      const reservation = heldReservation();

      program.correctReservation(reservation, usd(300_000_000n), context());

      expect(reservation.reservedAmount.equals(usd(300_000_000n))).toBe(true);
    });

    it('lets treasury push the program past its limit, because the exposure is real either way', () => {
      const program = programOf({ reserved: usd(900_000_000n) });

      program.correctReservation(
        heldReservation(),
        usd(400_000_000n),
        context(),
      );

      expect([program.overUtilized, program.available.toString()]).toEqual([
        true,
        '-500000.00 USD',
      ]);
    });

    it('frees the corrected amount when the reservation is later released', () => {
      const program = programOf({ reserved: usd(250_000_000n) });
      const reservation = heldReservation();

      program.correctReservation(reservation, usd(300_000_000n), context());
      program.release(reservation, 'REPAID', context({ occurredAt: LATER }));

      expect(program.reserved.isZero()).toBe(true);
    });

    it('changes nothing when the correction matches what is already held', () => {
      const program = programOf({ reserved: usd(250_000_000n) });

      const { event } = program.correctReservation(
        heldReservation(),
        usd(250_000_000n),
        context(),
      );

      expect([event, program.reserved.toString()]).toEqual([
        null,
        '2500000.00 USD',
      ]);
    });

    it('refuses to correct a reservation that has been released', () => {
      expect(() =>
        programOf({ reserved: usd(250_000_000n) }).correctReservation(
          releasedReservation(),
          usd(300_000_000n),
          context(),
        ),
      ).toThrow(ReservationStateError);
    });

    it('refuses a reservation belonging to another program', () => {
      expect(() =>
        programOf({ reserved: usd(250_000_000n) }).correctReservation(
          heldReservation({ programId: 'program-2' }),
          usd(300_000_000n),
          context(),
        ),
      ).toThrow(ReservationNotInProgramError);
    });

    it.each([0n, -1n])(
      'refuses a correction to %p minor units',
      (minorUnits) => {
        expect(() =>
          programOf({ reserved: usd(250_000_000n) }).correctReservation(
            heldReservation(),
            usd(minorUnits),
            context(),
          ),
        ).toThrow(InvalidReservationError);
      },
    );

    it('refuses a correction stated in another currency', () => {
      expect(() =>
        programOf({ reserved: usd(250_000_000n) }).correctReservation(
          heldReservation(),
          eur(300_000_000n),
          context(),
        ),
      ).toThrow(CurrencyMismatchError);
    });

    it('refuses a reduction that would drive the reserved total below zero', () => {
      expect(() =>
        programOf({ reserved: usd(10_000n) }).correctReservation(
          heldReservation(),
          usd(1n),
          context(),
        ),
      ).toThrow(CapacityInvariantError);
    });
  });

  describe('the audit entry a correction produces', () => {
    const corrected = (to: bigint) =>
      programOf({ reserved: usd(400_000_000n) }).correctReservation(
        heldReservation(),
        usd(to),
        context({ source: 'TREASURY_SNAPSHOT', actor: 'treasury:kafka' }),
      ).event!;

    it('records that reconciliation adjusted the hold', () => {
      expect(corrected(300_000_000n).type).toBe('RECONCILIATION_ADJUSTMENT');
    });

    it('records an increase as a positive delta', () => {
      expect(corrected(300_000_000n).delta.equals(usd(50_000_000n))).toBe(true);
    });

    it('records a decrease as a negative delta', () => {
      expect(corrected(100_000_000n).delta.equals(usd(-150_000_000n))).toBe(
        true,
      );
    });

    it('records the resulting reserved total', () => {
      expect(
        corrected(300_000_000n).resultingReserved.equals(usd(450_000_000n)),
      ).toBe(true);
    });

    it('records what the hold was worth before and after, so the adjustment can be read back', () => {
      const event = corrected(300_000_000n);

      expect([
        event.metadata.previousReservedAmount,
        event.metadata.correctedAmount,
      ]).toEqual([
        { amount: '250000000', currency: 'USD' },
        { amount: '300000000', currency: 'USD' },
      ]);
    });

    it('attributes the change to treasury rather than to a user', () => {
      const event = corrected(300_000_000n);

      expect([event.actor, event.source]).toEqual([
        'treasury:kafka',
        'TREASURY_SNAPSHOT',
      ]);
    });
  });

  describe('changing the credit limit', () => {
    it('raises the limit treasury agreed', () => {
      const program = programOf();

      program.changeCreditLimit(usd(2_000_000_000n), context());

      expect(program.creditLimit.equals(usd(2_000_000_000n))).toBe(true);
    });

    it('makes the extra capacity available immediately', () => {
      const program = programOf({ reserved: usd(900_000_000n) });

      program.changeCreditLimit(usd(2_000_000_000n), context());

      expect(program.available.equals(usd(1_100_000_000n))).toBe(true);
    });

    it('leaves the reserved total untouched, since a limit change frees nothing', () => {
      const program = programOf({ reserved: usd(900_000_000n) });

      program.changeCreditLimit(usd(400_000_000n), context());

      expect(program.reserved.equals(usd(900_000_000n))).toBe(true);
    });

    it('accepts a reduction below what is already reserved', () => {
      const program = programOf({ reserved: usd(900_000_000n) });

      program.changeCreditLimit(usd(400_000_000n), context());

      expect(program.available.toString()).toBe('-5000000.00 USD');
    });

    it('leaves the program over-utilised after such a reduction', () => {
      const program = programOf({ reserved: usd(900_000_000n) });

      program.changeCreditLimit(usd(400_000_000n), context());

      expect(program.overUtilized).toBe(true);
    });

    it('refuses new reservations once the reduction has taken effect', () => {
      const program = programOf({ reserved: usd(900_000_000n) });

      program.changeCreditLimit(usd(400_000_000n), context());

      expect(() =>
        program.reserve(
          request({ amount: unconverted(usd(1n)) }),
          null,
          context(),
        ),
      ).toThrow(InsufficientCapacityError);
    });

    it('still accepts releases once the reduction has taken effect', () => {
      const program = programOf({ reserved: usd(900_000_000n) });

      program.changeCreditLimit(usd(400_000_000n), context());
      program.release(heldReservation(), 'REPAID', context());

      expect(program.reserved.equals(usd(650_000_000n))).toBe(true);
    });

    it('accepts a limit of zero, which suspends the program without deleting it', () => {
      const program = programOf();

      program.changeCreditLimit(usd(0n), context());

      expect(program.hasCapacityFor(usd(1n))).toBe(false);
    });

    it('changes nothing when the limit is set to what it already is', () => {
      const program = programOf();

      const { event } = program.changeCreditLimit(usd(LIMIT), context());

      expect([event, program.creditLimit.toString()]).toEqual([
        null,
        '10000000.00 USD',
      ]);
    });

    it('refuses a negative limit', () => {
      expect(() => programOf().changeCreditLimit(usd(-1n), context())).toThrow(
        InvalidCreditLimitError,
      );
    });

    it('refuses a limit stated in another currency', () => {
      expect(() =>
        programOf().changeCreditLimit(eur(LIMIT), context()),
      ).toThrow(InvalidCreditLimitError);
    });

    it('changes nothing when it refuses', () => {
      const program = programOf();

      expect(() => program.changeCreditLimit(usd(-1n), context())).toThrow(
        InvalidCreditLimitError,
      );
      expect(program.creditLimit.equals(usd(LIMIT))).toBe(true);
    });

    it('raises a limit far beyond what a JS number could hold', () => {
      const program = programOf();

      program.changeCreditLimit(usd(BEYOND_SAFE_INTEGER), context());

      expect(program.available.minorUnits).toBe(BEYOND_SAFE_INTEGER);
    });
  });

  describe('the audit entry a limit change produces', () => {
    const changed = () =>
      programOf({ reserved: usd(250_000_000n) }).changeCreditLimit(
        usd(400_000_000n),
        context({ source: 'TREASURY_EVENT', actor: 'treasury:kafka' }),
      ).event!;

    it('records that the limit changed', () => {
      expect(changed().type).toBe('LIMIT_CHANGED');
    });

    it('concerns no single invoice', () => {
      expect(changed().invoiceId).toBeNull();
    });

    it('records a delta of zero, because no capacity moved', () => {
      expect(changed().delta.isZero()).toBe(true);
    });

    it('records the unchanged reserved total, so the log still reconciles', () => {
      expect(changed().resultingReserved.equals(usd(250_000_000n))).toBe(true);
    });

    it('records the limit before and after in its metadata', () => {
      const event = changed();

      expect([
        event.metadata.previousCreditLimit,
        event.metadata.creditLimit,
      ]).toEqual([
        { amount: '1000000000', currency: 'USD' },
        { amount: '400000000', currency: 'USD' },
      ]);
    });
  });

  describe('attributing every capacity change', () => {
    const operations: {
      name: string;
      run: (program: Program, changeContext: CapacityChangeContext) => unknown;
    }[] = [
      {
        name: 'reserving',
        run: (program, changeContext) =>
          program.reserve(
            request({ invoiceId: 'invoice-2' }),
            null,
            changeContext,
          ),
      },
      {
        name: 'releasing',
        run: (program, changeContext) =>
          program.release(heldReservation(), 'REPAID', changeContext),
      },
      {
        name: 'correcting a reservation',
        run: (program, changeContext) =>
          program.correctReservation(
            heldReservation(),
            usd(300_000_000n),
            changeContext,
          ),
      },
      {
        name: 'changing the limit',
        run: (program, changeContext) =>
          program.changeCreditLimit(usd(400_000_000n), changeContext),
      },
    ];

    it.each(operations)(
      'refuses $name with no actor, because an unattributable change cannot be audited',
      ({ run }) => {
        expect(() =>
          run(
            programOf({ reserved: usd(250_000_000n) }),
            context({ actor: '' }),
          ),
        ).toThrow(MissingAuditContextError);
      },
    );

    it.each(operations)('refuses $name with a blank actor', ({ run }) => {
      expect(() =>
        run(
          programOf({ reserved: usd(250_000_000n) }),
          context({ actor: '   ' }),
        ),
      ).toThrow(MissingAuditContextError);
    });

    it.each(operations)('refuses $name with no usable timestamp', ({ run }) => {
      expect(() =>
        run(
          programOf({ reserved: usd(250_000_000n) }),
          context({ occurredAt: new Date('not a date') }),
        ),
      ).toThrow(MissingAuditContextError);
    });

    it('changes nothing when it refuses an unattributable reservation', () => {
      const program = programOf({ reserved: usd(250_000_000n) });

      expect(() =>
        program.reserve(
          request({ invoiceId: 'invoice-2' }),
          null,
          context({ actor: '' }),
        ),
      ).toThrow(MissingAuditContextError);
      expect(program.reserved.equals(usd(250_000_000n))).toBe(true);
    });

    it('carries a stable code and names what was missing', () => {
      const error = new MissingAuditContextError('actor');

      expect([error.code, error.field]).toEqual([
        'MISSING_AUDIT_CONTEXT',
        'actor',
      ]);
    });
  });

  /**
   * The realistic shape of this situation, and the one the existing cases miss: a
   * released hold no longer counts towards the reserved total, so the program's
   * counter has already come down by the full amount. Any projection of "what
   * would the total become" is therefore short by that amount, which must not be
   * mistaken for the counter and the reservations disagreeing.
   *
   * The distinction is load-bearing beyond the message. Cycle 3 branches on the
   * error: `CAPACITY_INVARIANT_VIOLATED` says the stored state is corrupt and
   * somebody has to look at it, while §2.5 requires treasury correcting an
   * invoice we consider closed to be a state conflict that reconciliation
   * records as a discrepancy.
   */
  describe('correcting a hold the program has already released', () => {
    /** The program after the release: the 2,500,000.00 hold is no longer counted. */
    const afterRelease = (): Program => programOf({ reserved: usd(0n) });

    const directions: { direction: string; to: bigint }[] = [
      { direction: 'downward', to: 50_000n },
      { direction: 'to the amount it held', to: 250_000_000n },
      { direction: 'upward', to: 300_000_000n },
    ];

    it.each(directions)(
      'refuses a correction $direction as a state conflict',
      ({ to }) => {
        expect(() =>
          afterRelease().correctReservation(
            releasedReservation(),
            usd(to),
            context(),
          ),
        ).toThrow(ReservationStateError);
      },
    );

    it.each(directions)(
      'does not mistake a correction $direction for a corrupt counter, which cycle 3 would alarm on',
      ({ to }) => {
        expect(() =>
          afterRelease().correctReservation(
            releasedReservation(),
            usd(to),
            context(),
          ),
        ).not.toThrow(CapacityInvariantError);
      },
    );

    it('leaves the reserved total exactly where the release left it', () => {
      const program = afterRelease();

      expect(() =>
        program.correctReservation(
          releasedReservation(),
          usd(50_000n),
          context(),
        ),
      ).toThrow(ReservationStateError);
      expect(program.reserved.isZero()).toBe(true);
    });

    it('refuses the correction after a release this program itself performed', () => {
      const program = programOf();
      const { reservation } = program.reserve(request(), null, context());

      program.release(reservation, 'REPAID', context({ occurredAt: LATER }));

      expect(() =>
        program.correctReservation(reservation, usd(50_000n), context()),
      ).toThrow(ReservationStateError);
    });
  });

  describe('reserving against a conversion that contradicts itself', () => {
    /**
     * Hand-built rather than produced by cycle 1's `convert`, which is the point:
     * cycle 3's snapshot anti-corruption layer will assemble conversions from
     * treasury messages without going through it, and neither of these needs a
     * cast to typecheck. The audit entry records both figures side by side, so a
     * conversion that contradicts itself makes the log contradict itself too.
     */
    const inflated: Conversion = {
      original: usd(10_000n),
      converted: usd(99_900_000n),
      rate: null,
    };

    it('refuses a request that holds far more capacity than the invoice it states', () => {
      expect(() =>
        programOf().reserve(request({ amount: inflated }), null, context()),
      ).toThrow(InvalidReservationError);
    });

    it('holds nothing when it refuses one', () => {
      const program = programOf();

      expect(() =>
        program.reserve(request({ amount: inflated }), null, context()),
      ).toThrow(InvalidReservationError);
      expect(program.reserved.isZero()).toBe(true);
    });

    it('refuses a request whose invoiced amount is negative, as one broken reservation rather than as a bad number', () => {
      // With a rate present the invoiced amount reaches cycle 1's `applyRate`,
      // which refuses a negative amount with its own `INVALID_AMOUNT`. The HTTP
      // layer maps by class, so the code a client sees would otherwise depend on
      // whether the program's currency happened to match the invoice's.
      expect(() =>
        eurProgramOf().reserve(
          request({
            amount: {
              original: usd(-10n),
              converted: eur(10n),
              rate: EUR_PER_USD,
            },
          }),
          null,
          context(),
        ),
      ).toThrow(InvalidReservationError);
    });

    it('refuses a request whose rate does not produce the amount it would hold', () => {
      expect(() =>
        eurProgramOf().reserve(
          request({
            amount: {
              original: usd(10_000_000n),
              converted: eur(1n),
              rate: EUR_PER_USD,
            },
          }),
          null,
          context(),
        ),
      ).toThrow(InvalidReservationError);
    });
  });

  describe('replaying a request the program has to judge before trusting it', () => {
    /**
     * The same conversion fault as above, arriving on the replay path: the
     * original amount matches the stored hold, so the duplicate rule alone would
     * answer `200` and hand back a reservation, while the identical request with
     * no existing hold is refused. The same request cannot be valid or invalid
     * depending on whether it has been seen before.
     */
    const foreignConversion: Conversion = {
      original: usd(250_000_000n),
      converted: eur(250_000_000n),
      rate: EUR_PER_USD,
    };

    it('refuses a replay whose conversion did not land in the program currency', () => {
      expect(() =>
        programOf({ reserved: usd(250_000_000n) }).reserve(
          request({ amount: foreignConversion }),
          heldReservation(),
          context(),
        ),
      ).toThrow(CurrencyMismatchError);
    });

    it('refuses the very same request when there is no hold to replay, which is why the two must agree', () => {
      expect(() =>
        programOf().reserve(
          request({ amount: foreignConversion }),
          null,
          context(),
        ),
      ).toThrow(CurrencyMismatchError);
    });

    it('still replays a request whose conversion is sound', () => {
      const existing = heldReservation();

      const { reservation, event } = programOf({
        reserved: usd(250_000_000n),
      }).reserve(request(), existing, context());

      expect([reservation, event]).toEqual([existing, null]);
    });
  });

  describe('identifiers that arrived with padding', () => {
    it('trims the identifiers a new program is opened with', () => {
      const program = Program.create({
        id: ' program-1 ',
        ownerOrgId: '  org-1  ',
        currency: 'USD',
        creditLimit: usd(LIMIT),
      });

      expect([program.id, program.ownerOrgId]).toEqual(['program-1', 'org-1']);
    });

    it('recognises the rightful tenant whose organisation was stored with padding', () => {
      // Otherwise the owner of the program is told it does not exist
      // (docs/PLAN.md 2.7 answers a failed ownership check with a 404), which is
      // the least debuggable outcome available.
      const program = Program.create({
        id: 'program-1',
        ownerOrgId: '  org-1  ',
        currency: 'USD',
        creditLimit: usd(LIMIT),
      });

      expect(program.isOwnedBy('org-1')).toBe(true);
    });

    it('trims the identifiers of a stored program as well', () => {
      const program = programOf({ id: 'program-1 ', ownerOrgId: ' org-1' });

      expect([program.id, program.isOwnedBy('org-1')]).toEqual([
        'program-1',
        true,
      ]);
    });

    it('names the same invoice on the reservation and on its audit entry, whatever padding the request carried', () => {
      const { reservation, event } = programOf().reserve(
        request({ invoiceId: ' invoice-9 ' }),
        null,
        context(),
      );

      expect([reservation.invoiceId, event!.invoiceId]).toEqual([
        'invoice-9',
        'invoice-9',
      ]);
    });

    it('recognises a replay whose invoice id arrived with padding, rather than reading it as a row for another invoice', () => {
      const existing = heldReservation();

      const { reservation, event } = programOf({
        reserved: usd(250_000_000n),
      }).reserve(request({ invoiceId: ' invoice-1 ' }), existing, context());

      expect([reservation, event]).toEqual([existing, null]);
    });
  });

  describe('the metadata an audit entry actually carries', () => {
    it('leaves the FX rate out altogether when no conversion happened', () => {
      // Not merely `undefined`: a persistence layer that iterates `Object.keys`
      // would write `fxRate: null` into jsonb, recording that a rate was looked
      // for and absent rather than that none was ever needed (docs/PLAN.md 2.3).
      const { event } = programOf().reserve(request(), null, context());

      expect(Object.keys(event!.metadata).sort()).toEqual(['originalAmount']);
    });

    it('carries both FX fields when a conversion did happen', () => {
      const { event } = eurProgramOf().reserve(
        request({ amount: usdInvoiceInEurProgram }),
        null,
        context(),
      );

      expect(Object.keys(event!.metadata).sort()).toEqual([
        'fxRate',
        'originalAmount',
      ]);
    });

    it('carries only the reason on a release', () => {
      const { event } = programOf({ reserved: usd(250_000_000n) }).release(
        heldReservation(),
        'REPAID',
        context(),
      );

      expect(Object.keys(event!.metadata).sort()).toEqual(['reason']);
    });
  });
});

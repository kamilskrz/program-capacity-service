import { type CapacityChangeContext } from '../../../src/capacity/domain/capacity-event';
import { type CurrencyCode } from '../../../src/capacity/domain/currency';
import { Money } from '../../../src/capacity/domain/money';
import {
  Program,
  type ReservationChange,
} from '../../../src/capacity/domain/program';
import { type Reservation } from '../../../src/capacity/domain/reservation';
import { applyRate, type Conversion } from '../../../src/fx/convert';
import { FxRate } from '../../../src/fx/fx-rate';

// Builders for the domain objects the persistence suite stores and loads back,
// going through the domain's own factories rather than object literals
// (docs/PLAN.md §2.10). `rows.ts` is the one place that deliberately writes a
// shape the domain would refuse.

/** 10,000,000.00 USD — the program limit of docs/PLAN.md §1, in minor units. */
export const LIMIT = 1_000_000_000n;

// Two above `Number.MAX_SAFE_INTEGER`: the `BIGINT` column is the second place
// this cliff could appear, since `pg` hands it back as a string.
export const BEYOND_SAFE_INTEGER = 9_007_199_254_740_993n;

export const usd = (minorUnits: bigint): Money =>
  Money.fromMinorUnits(minorUnits, 'USD');
export const eur = (minorUnits: bigint): Money =>
  Money.fromMinorUnits(minorUnits, 'EUR');
/** JPY has 0 decimals: one minor unit is one yen. */
export const jpy = (minorUnits: bigint): Money =>
  Money.fromMinorUnits(minorUnits, 'JPY');
/** KWD has 3 decimals: one minor unit is a thousandth of a dinar. */
export const kwd = (minorUnits: bigint): Money =>
  Money.fromMinorUnits(minorUnits, 'KWD');

export const OCCURRED_AT = new Date('2026-01-15T10:32:00.000Z');
export const LATER = new Date('2026-04-15T09:00:00.000Z');

/** The seeded USD→EUR quote of `seed.ts`, as a value object. */
export const EUR_PER_USD = FxRate.fromDecimalString({
  base: 'USD',
  quote: 'EUR',
  value: '0.9235',
  source: 'seed',
  asOf: OCCURRED_AT,
});

// A JPY→USD quote: the two currencies have different exponents, which a
// mapping could easily confuse with the stored `fx_scale`.
export const USD_PER_JPY = FxRate.fromDecimalString({
  base: 'JPY',
  quote: 'USD',
  value: '0.0067',
  source: 'seed',
  asOf: OCCURRED_AT,
});

export interface ProgramOptions {
  readonly id?: string;
  readonly ownerOrgId?: string;
  readonly currency?: CurrencyCode;
  readonly creditLimit?: Money;
}

/** A program with nothing reserved against it. */
export function aProgram(options: ProgramOptions = {}): Program {
  const currency = options.currency ?? 'USD';

  return Program.create({
    id: options.id ?? 'prog-northwind',
    ownerOrgId: options.ownerOrgId ?? 'org-northwind',
    currency,
    creditLimit: options.creditLimit ?? Money.fromMinorUnits(LIMIT, currency),
  });
}

/** An invoice already in the program's currency: no conversion, no rate. */
export function unconverted(amount: Money): Conversion {
  return { original: amount, converted: amount, rate: null };
}

// Computed through the domain's own `applyRate`, because `Reservation.open`
// reproduces it and would reject a hand-written `converted` that doesn't match.
export function convertedThrough(amount: Money, rate: FxRate): Conversion {
  return { original: amount, converted: applyRate(amount, rate), rate };
}

export interface ContextOptions {
  readonly actor?: string;
  readonly source?: CapacityChangeContext['source'];
  readonly correlationId?: string | null;
  readonly occurredAt?: Date;
  readonly metadata?: CapacityChangeContext['metadata'];
}

/** The attribution every capacity change carries (docs/PLAN.md §2.8). */
export function anAuditContext(
  options: ContextOptions = {},
): CapacityChangeContext {
  return {
    actor: options.actor ?? 'user-42',
    source: options.source ?? 'API',
    correlationId:
      options.correlationId === undefined ? 'corr-0001' : options.correlationId,
    occurredAt: options.occurredAt ?? OCCURRED_AT,
    metadata: options.metadata,
  };
}

// Returns the `ReservationChange`, not just the reservation, because the event
// is half of what this cycle stores.
export function reserveOn(
  program: Program,
  invoiceId: string,
  amount: Conversion,
  context: CapacityChangeContext = anAuditContext(),
): ReservationChange {
  return program.reserve({ invoiceId, amount }, null, context);
}

/** The reservation half of {@link reserveOn}, for tests that need only the row. */
export function aReservation(
  program: Program,
  invoiceId: string,
  amount: Conversion,
  context: CapacityChangeContext = anAuditContext(),
): Reservation {
  return reserveOn(program, invoiceId, amount, context).reservation;
}

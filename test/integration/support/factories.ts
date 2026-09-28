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

/**
 * Builders for the domain objects the persistence suite stores and loads back.
 *
 * **Factories, not JSON fixtures** (docs/PLAN.md 2.10), and they go through the
 * domain's own factories rather than object literals: a test that stored a shape
 * `Program.create` would refuse would be asserting the round-trip of something
 * production cannot produce. The one place this suite deliberately writes a shape
 * the domain would refuse is `rows.ts`, which speaks SQL for exactly that reason.
 */

/** 10,000,000.00 USD — the program limit of docs/PLAN.md 1, in minor units. */
export const LIMIT = 1_000_000_000n;

/**
 * Two above `Number.MAX_SAFE_INTEGER`, the same constant the unit suites use.
 *
 * It is here because the `BIGINT` column is the second place the cliff could
 * appear: `Money` survives it in memory, and the round trip has to survive it
 * through `pg`, which hands a `BIGINT` over as a string (docs/PLAN.md 2.6).
 */
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

/**
 * A JPY→USD quote: a pair whose two currencies have **different exponents**.
 *
 * Worth having in the persistence suite as well as the unit one, because the
 * conversion's exponent delta and the stored `fx_scale` are two different scales
 * that a mapping could easily confuse (docs/PLAN.md 2.3).
 */
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

/**
 * A program with nothing reserved against it.
 *
 * Defaults to the USD 10M program of docs/PLAN.md 1; every test that cares about
 * a currency, an owner or a limit states it.
 */
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

/**
 * An invoice in another currency, priced through `rate`.
 *
 * The conversion is computed by the domain's own `applyRate`, because
 * `Reservation.open` reproduces it and refuses evidence that does not match the
 * figure it is attached to — a hand-written `converted` would fail as a broken
 * reservation rather than as a broken round trip.
 */
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

/**
 * The attribution every capacity change has to carry (docs/PLAN.md 2.8): who,
 * how, under which correlation id, and at which instant the caller read.
 */
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

/**
 * Opens a hold on `program` through the aggregate, which is the only way a
 * reservation and the counter move together.
 *
 * Returns the `ReservationChange` rather than just the reservation, because the
 * event is half of what this cycle stores and a test that dropped it would be
 * storing a change with no explanation.
 */
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

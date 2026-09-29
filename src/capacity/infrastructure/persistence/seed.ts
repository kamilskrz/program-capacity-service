import { type EntityManager } from '@mikro-orm/postgresql';

import { MikroOrmCapacityEventLog } from './mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from './mikro-orm-program.repository';
import { MikroOrmReservationRepository } from './mikro-orm-reservation.repository';
import { type CapacityChangeContext } from '../../domain/capacity-event';
import { type CurrencyCode } from '../../domain/currency';
import { Money } from '../../domain/money';
import { Program } from '../../domain/program';
import { convert } from '../../../fx/convert';
import { FxRate } from '../../../fx/fx-rate';
import { DatabaseFxRateProvider } from '../../../fx/persistence/database-fx-rate.provider';
import {
  fxRateSchema,
  toFxRateRow,
} from '../../../fx/persistence/fx-rate.mapping';

/**
 * One seeded program, stated the way a client would: decimal amounts and a
 * currency, never minor units. `holds` are created through the domain, not
 * written as a counter value, so `reserved_amount` always equals what they
 * add up to (docs/PLAN.md 2.4).
 */
export interface SeedProgram {
  readonly id: string;
  readonly ownerOrgId: string;
  readonly currency: CurrencyCode;
  /** Decimal string in {@link currency}, e.g. `"10000000.00"`. */
  readonly creditLimit: string;
  readonly description: string;
  readonly holds: readonly SeedHold[];
}

/** One invoice the seeded program already holds capacity for. */
export interface SeedHold {
  readonly invoiceId: string;
  /** Decimal string in {@link currency} — the amount as invoiced. */
  readonly amount: string;
  /** The invoice's own currency; converted through the seeded rates if it differs from the program's. */
  readonly currency: CurrencyCode;
}

/** One seeded rate, one direction of one pair. */
export interface SeedRate {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  /** Decimal string, at most 12 fraction digits. */
  readonly value: string;
}

/** Fixed rather than `new Date()`, so a re-run produces byte-identical rows. */
export const SEED_RATE_AS_OF = new Date('2026-09-01T00:00:00.000Z');

/** The `source` every seeded rate records, so a seeded quote is recognisable. */
export const SEED_RATE_SOURCE = 'seed';

/** The programs a fresh clone comes up with (docs/PLAN.md 2.9). */
export const SEED_PROGRAMS: readonly SeedProgram[] = [
  {
    id: 'prog-usd-northwind',
    ownerOrgId: 'org-northwind',
    currency: 'USD',
    creditLimit: '10000000.00',
    description:
      'USD program with head-room: the ordinary reserve/release path',
    holds: [{ invoiceId: 'inv-nw-0001', amount: '250000.00', currency: 'USD' }],
  },
  {
    id: 'prog-usd-tightrope',
    ownerOrgId: 'org-northwind',
    currency: 'USD',
    creditLimit: '5000000.00',
    description:
      'USD program with 1,000.00 available: reserve 1,000.00 and it fits, reserve 1,000.01 and it is refused',
    holds: [
      { invoiceId: 'inv-tr-0001', amount: '4999000.00', currency: 'USD' },
    ],
  },
  {
    id: 'prog-eur-hanseatic',
    ownerOrgId: 'org-hanseatic',
    currency: 'EUR',
    creditLimit: '2000000.00',
    description:
      'EUR program holding one EUR invoice (no FX evidence) and one USD invoice (converted, rate frozen)',
    holds: [
      { invoiceId: 'inv-ha-0001', amount: '120000.00', currency: 'EUR' },
      { invoiceId: 'inv-ha-0002', amount: '100000.00', currency: 'USD' },
    ],
  },
];

/**
 * The FX rates the seeded programs need, both directions of the pair
 * (docs/PLAN.md 2.3) even though only one is used, since rates are never
 * inverted. The two values are deliberately not exact inverses of each
 * other, so a bug that divides by a rate instead of looking up its own
 * direction fails loudly instead of passing by coincidence.
 */
export const SEED_RATES: readonly SeedRate[] = [
  { base: 'USD', quote: 'EUR', value: '0.9235' },
  { base: 'EUR', quote: 'USD', value: '1.0828' },
];

/** `actor: 'seed'` and a fixed `occurredAt` so every seeded hold is attributable and reproducible. */
const SEED_CONTEXT: CapacityChangeContext = {
  actor: 'seed',
  source: 'API',
  correlationId: null,
  occurredAt: SEED_RATE_AS_OF,
};

/** What a seed run did, for the log line and for the tests. */
export interface SeedOutcome {
  readonly programsInserted: readonly string[];
  readonly programsLeftAlone: readonly string[];
  readonly reservationsInserted: number;
  readonly ratesUpserted: number;
}

/**
 * Writes the seed data through the domain and one transaction, so every
 * seeded row is a shape the service could actually have produced itself.
 *
 * Idempotent: rates are upserted (a re-run restates the same quote), and a
 * program that already exists is left completely alone, holds untouched, so
 * a restart cannot erase what a developer did against it.
 *
 * @param em the `EntityManager` to work through; the caller owns the
 * transaction, so a partially applied seed is not a state anybody can observe.
 */
export async function seedDatabase(em: EntityManager): Promise<SeedOutcome> {
  // Written first: converting a foreign-currency hold below reads them back.
  const ratesUpserted = await upsertRates(em);

  const programs = new MikroOrmProgramRepository(em);
  const reservations = new MikroOrmReservationRepository(em);
  const log = new MikroOrmCapacityEventLog(em);
  const rates = new DatabaseFxRateProvider(em);

  const programsInserted: string[] = [];
  const programsLeftAlone: string[] = [];
  let reservationsInserted = 0;

  for (const seeded of SEED_PROGRAMS) {
    if ((await programs.findById(seeded.id)) !== null) {
      programsLeftAlone.push(seeded.id);
      continue;
    }

    const program = Program.create({
      id: seeded.id,
      ownerOrgId: seeded.ownerOrgId,
      currency: seeded.currency,
      creditLimit: Money.fromDecimalString(seeded.creditLimit, seeded.currency),
    });

    programs.add(program);
    programsInserted.push(program.id);

    for (const hold of seeded.holds) {
      const conversion = await convert(
        Money.fromDecimalString(hold.amount, hold.currency),
        seeded.currency,
        rates,
      );
      const change = program.reserve(
        { invoiceId: hold.invoiceId, amount: conversion },
        null,
        SEED_CONTEXT,
      );

      reservations.add(change.reservation);
      // Non-null by construction: a brand-new hold is never a replay.
      log.append(change.event!);
      reservationsInserted += 1;
    }
  }

  await em.flush();

  return {
    programsInserted,
    programsLeftAlone,
    reservationsInserted,
    ratesUpserted,
  };
}

/**
 * Writes every declared rate, restating one that is already there.
 * @returns how many rows were written — every declared rate, since each is restated.
 */
async function upsertRates(em: EntityManager): Promise<number> {
  for (const seeded of SEED_RATES) {
    const rate = FxRate.fromDecimalString({
      base: seeded.base,
      quote: seeded.quote,
      value: seeded.value,
      source: SEED_RATE_SOURCE,
      asOf: SEED_RATE_AS_OF,
    });

    await em.upsert(fxRateSchema, toFxRateRow(rate));
  }

  return SEED_RATES.length;
}

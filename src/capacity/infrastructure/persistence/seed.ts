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
 * One seeded program, stated the way a client would state it: decimal amounts and
 * a currency, never minor units.
 *
 * `holds` are the reservations the program starts with. They are not decoration:
 * docs/PLAN.md 2.4's invariant is `reserved_amount == SUM(active reservations) ==
 * SUM(deltas in capacity_events)`, so a program seeded with a non-zero counter and
 * no reservations would be a program that reconciliation immediately rejects as
 * `COUNTER_DRIFT` and that cycle 5's invariant test would fail on. The counter is
 * therefore never written directly — it is whatever the holds add up to, because
 * the seed creates them through the domain.
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
  /**
   * The invoice's own currency. When it differs from the program's, the seed
   * converts through the seeded rate table and the reservation stores the six FX
   * columns; when it matches, no rate is looked up and the columns stay null
   * (docs/PLAN.md 2.3).
   */
  readonly currency: CurrencyCode;
}

/** One seeded rate, one direction of one pair. */
export interface SeedRate {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  /** Decimal string, at most 12 fraction digits. */
  readonly value: string;
}

/**
 * The instant every seeded rate is quoted at.
 *
 * Fixed rather than `new Date()`: a seed that produces different rows on every run
 * cannot be asserted against, and the one property the integration test cares about
 * — running it twice changes nothing — would be untestable. It is also what makes a
 * failure in a demo reproducible a week later.
 */
export const SEED_RATE_AS_OF = new Date('2026-09-01T00:00:00.000Z');

/** The `source` every seeded rate records, so a seeded quote is recognisable. */
export const SEED_RATE_SOURCE = 'seed';

/**
 * The programs a fresh clone comes up with (docs/PLAN.md 2.9, 2.10).
 *
 * Three, each chosen to make one thing demonstrable without setting it up by hand:
 *
 * 1. **head-room, single currency.** The ordinary case: a reservation succeeds, a
 *    release frees it again, and nothing about FX is involved.
 * 2. **near exhaustion.** USD 1,000.00 of availability against a USD 5,000,000.00
 *    limit, so `409 insufficient capacity` is one request away — the rejection
 *    docs/PLAN.md 2.9 asks the seed to make easy to demonstrate — while a small
 *    reservation still fits, so the boundary can be shown from both sides. The
 *    counter is carried by one real hold, not written directly.
 * 3. **non-USD, mixed invoice currencies.** A EUR program holding one EUR invoice
 *    (no rate, the columns null) and one USD invoice (converted, the six FX columns
 *    filled), which is the pair of shapes every later cycle has to handle and the
 *    one asymmetry a reviewer should be able to see in a single `select`.
 *
 * The identifiers are readable rather than UUIDs: they appear in `requests.http`, in
 * log lines and in this file, and a demo that has to copy a UUID between three
 * windows is a demo nobody runs twice.
 */
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
 * The FX rates the seeded programs need — **both directions of the pair**
 * (docs/PLAN.md 2.3).
 *
 * `prog-eur-hanseatic` holds a USD invoice, so USD→EUR is required to seed it at all.
 * EUR→USD is required by nothing in this file, and is seeded anyway: rates are
 * directional and are never inverted, so without it the first demo that reserves an
 * EUR invoice against a USD program gets a `422` for a pair the table appears to
 * contain. That is precisely the trap the plan warns about, and a seed is the cheapest
 * place to not fall into it.
 *
 * The two values are **not** exact inverses (0.9235 against 1.0828, where 1/0.9235 is
 * 1.0828...), which is deliberate on two counts: real quotes carry a spread, and a
 * seed whose directions were exact inverses would let a bug that divides by a rate
 * pass every test that uses it.
 */
export const SEED_RATES: readonly SeedRate[] = [
  { base: 'USD', quote: 'EUR', value: '0.9235' },
  { base: 'EUR', quote: 'USD', value: '1.0828' },
];

/**
 * The attribution every seeded hold is recorded under.
 *
 * `actor` names the seed rather than a person, because the audit log has to be
 * able to say that nobody asked for these holds — they came with the database.
 * `source` is `API`, the closed union's only value for a change this service made
 * of its own accord; the alternatives both claim treasury said something.
 * `occurredAt` is the fixed {@link SEED_RATE_AS_OF} for the same reason the rate
 * timestamp is fixed: a seed that produces a different row on every run cannot be
 * asserted against.
 */
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
 * Writes the seed data, through the domain and through one transaction.
 *
 * # It goes through the aggregates, not through `INSERT`
 *
 * Every seeded hold is created by calling `Program.reserve` on a `Program.create`d
 * aggregate, with the conversion produced by `convert` against the rates this same
 * run has just written, and both the reservation and the `RESERVED` event it returns
 * are persisted through the repositories. Hand-written inserts would be faster to
 * write and would be the wrong thing twice: the seeded counter could disagree with
 * the holds that are supposed to add up to it (docs/PLAN.md 2.4), and the seeded rows
 * could be shapes the service itself cannot produce — which is exactly what makes
 * fixture data stop matching reality. Going through the domain means the seed is a
 * client of the same rules as the API.
 *
 * The rates are written first, because the conversion for `inv-ha-0002` reads them.
 *
 * # Idempotency, stated exactly
 *
 * `docker compose up` runs this after every `migration:up`, so it runs repeatedly
 * against a database that already has it, and it is safe to:
 *
 * - **rates are upserted.** They are reference data with a natural key
 *   `(base, quote)`; re-running restates the seeded quote, which is the point.
 * - **a program that already exists is left completely alone** — not restated, not
 *   reset, and its holds are not touched. A developer who has spent ten minutes
 *   reserving and releasing against `prog-usd-tightrope` must not have that erased by
 *   a restart, and a seed that reset counters would also be a seed that could
 *   contradict the audit log it does not rewrite.
 *
 * So it is idempotent, and deliberately not a "reset to seed state" command. Wiping
 * and reseeding is `docker compose down -v` followed by `up`, which says what it does.
 *
 * @param em the `EntityManager` to work through; the caller owns the transaction, so
 * a partially applied seed is not a state anybody can observe.
 */
export async function seedDatabase(em: EntityManager): Promise<SeedOutcome> {
  // Written first: the conversion for a foreign-currency hold reads them back
  // through the same provider the API uses.
  const ratesUpserted = await upsertRates(em);

  const programs = new MikroOrmProgramRepository(em);
  const reservations = new MikroOrmReservationRepository(em);
  const log = new MikroOrmCapacityEventLog(em);
  const rates = new DatabaseFxRateProvider(em);

  const programsInserted: string[] = [];
  const programsLeftAlone: string[] = [];
  let reservationsInserted = 0;

  for (const seeded of SEED_PROGRAMS) {
    // A program that already exists is left completely alone — not restated, not
    // reset, and its holds are not touched. A developer's ten minutes of
    // reserving and releasing against it has to survive a restart, and a seed
    // that reset counters would also be a seed that contradicts the audit log it
    // cannot rewrite.
    if ((await programs.findById(seeded.id)) !== null) {
      programsLeftAlone.push(seeded.id);
      continue;
    }

    const program = Program.create({
      id: seeded.id,
      ownerOrgId: seeded.ownerOrgId,
      currency: seeded.currency,
      // Stated the way a client states it and parsed by the domain, so the
      // seeded limit cannot be a figure the API would have refused.
      creditLimit: Money.fromDecimalString(seeded.creditLimit, seeded.currency),
    });

    programs.add(program);
    programsInserted.push(program.id);

    for (const hold of seeded.holds) {
      // Through the aggregate, exactly as a reservation use case does: the
      // counter is therefore whatever the holds add up to, and every seeded row
      // is a shape the service can actually produce (docs/PLAN.md 2.4).
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
      // Non-null by construction: a brand-new hold is never a replay, so the
      // aggregate always has a `RESERVED` fact to record.
      log.append(change.event!);
      reservationsInserted += 1;
    }
  }

  // One flush, inside the caller's transaction, so a partially applied seed is
  // not a state anybody can observe.
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
 *
 * Reference data with a natural key `(base, quote)`, so this is an upsert and not
 * an insert-if-absent: re-running restates the seeded quote, which is the point.
 * Each direction is its own row, because a rate is never inverted
 * (docs/PLAN.md 2.3).
 *
 * @returns how many rows were written — the count of declared rates, since every
 * one of them is restated.
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

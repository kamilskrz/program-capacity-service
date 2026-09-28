import { BigIntType, EntitySchema } from '@mikro-orm/core';

import { moneyAmount, moneyFromColumns } from './money-amount.type';
import {
  type CapacityEvent,
  type CapacityEventMetadata,
  type CapacityEventSource,
  type CapacityEventType,
} from '../../domain/capacity-event';
import { type CurrencyCode } from '../../domain/currency';
import { CurrencyMismatchError } from '../../domain/errors';
import { type Money } from '../../domain/money';

/** Every value of `capacity_events.type` (docs/PLAN.md 2.8). */
export const CAPACITY_EVENT_TYPES: readonly CapacityEventType[] = [
  'RESERVED',
  'RELEASED',
  'LIMIT_CHANGED',
  'RECONCILIATION_APPLIED',
  'RECONCILIATION_ADJUSTMENT',
  'DISCREPANCY_FLAGGED',
];

/** Every value of `capacity_events.source` (docs/PLAN.md 2.8). */
export const CAPACITY_EVENT_SOURCES: readonly CapacityEventSource[] = [
  'API',
  'TREASURY_SNAPSHOT',
  'TREASURY_EVENT',
];

/**
 * One `capacity_events` row.
 *
 * **A row shape rather than the domain object, and this is the one place that is
 * right.** `Program` and `Reservation` are aggregates the unit of work tracks, so
 * they are mapped as themselves (docs/PLAN.md 2.6) and mutated in place. A
 * `CapacityEvent` is an immutable value the domain *returns*, the table is
 * append-only, and no operation ever loads one to change it. Mapping it through a
 * row and two pure functions costs nothing in tracking and buys a `bigint`
 * primary key the domain has no business carrying — the cursor docs/PLAN.md 2.7's
 * audit pagination needs.
 */
export interface CapacityEventRow {
  /**
   * `bigserial`. Assigned by the database, and the ordering the audit log is read
   * in: two events written in the same transaction share `occurred_at` to the
   * microsecond, so a cursor over a timestamp cannot page deterministically.
   */
  id: bigint;
  type: CapacityEventType;
  programId: string;
  invoiceId: string | null;
  /** The change to the reserved total. Zero for `LIMIT_CHANGED`. */
  delta: Money;
  /** The reserved total after the change. */
  resultingReserved: Money;
  /**
   * The currency of both amounts, **once per row**: a program has one currency,
   * and both figures are stated in it. Two columns could only disagree.
   */
  currency: CurrencyCode;
  actor: string;
  source: CapacityEventSource;
  correlationId: string | null;
  /** When the change happened, as the caller observed it. */
  occurredAt: Date;
  /**
   * When the row was written, by the database's clock. Not in the domain event:
   * `occurredAt` is the caller's reading and is what docs/PLAN.md 2.1's in-flight
   * rule compares, while this is the only instant in the system nobody can pass
   * in — which is exactly what makes it useful when a clock turns out to have
   * been wrong.
   */
  recordedAt: Date;
  metadata: CapacityEventMetadata;
}

/**
 * `capacity_events` — the append-only audit log of docs/PLAN.md 2.8.
 *
 * ## Append-only, enforced by the database
 *
 * The migration installs a `BEFORE UPDATE OR DELETE` trigger that raises. Not a
 * `REVOKE`, because the test harness and the local stack connect as the database
 * owner, whose privileges a `REVOKE` does not constrain in practice — the
 * guarantee would be true in production and untestable, which is the sort of
 * safety net that is discovered to be missing during an incident. The trigger
 * holds for every role.
 *
 * `TRUNCATE` is deliberately **not** guarded. It is not a way to rewrite history
 * — it takes an `ACCESS EXCLUSIVE` lock, cannot touch a single row and is not
 * granted in production — and it is how the integration suite isolates tests
 * (docs/PLAN.md 2.10). A statement-level truncate trigger would buy nothing and
 * would cost the isolation strategy the whole suite is built on.
 *
 * MikroORM never issues an `UPDATE` against this table by itself, because nothing
 * loads a row to change it; the trigger is there for everything that is not
 * MikroORM.
 *
 * ## `delta` means one thing
 *
 * The change to the **reserved total**, signed. Zero for `LIMIT_CHANGED`, whose
 * two limits travel in `metadata`, so that `SUM(delta) = reserved_amount` remains
 * the invariant docs/PLAN.md 2.4 asserts. `CHECK (resulting_reserved >= 0)`
 * mirrors the counter's own constraint; `delta` carries no sign check, a release
 * being negative by definition.
 *
 * ## `metadata`
 *
 * `jsonb`, not null, defaulting to `{}`. Every field of `CapacityEventMetadata` is
 * a JSON primitive or a shape that serialises to one — amounts as `MoneyJson`
 * (minor units as a string) and a rate as its `FxRateSnapshot` — so the column
 * needs no transformer and loses no precision. `jsonb` rather than `json` so that
 * a future index on, say, `metadata->>'snapshotSequence'` is available; the cost
 * is that key order is not preserved, which nothing here depends on.
 */
export const capacityEventSchema = new EntitySchema<CapacityEventRow>({
  name: 'CapacityEvent',
  tableName: 'capacity_events',
  properties: {
    id: {
      type: new BigIntType(),
      primary: true,
      autoincrement: true,
      fieldName: 'id',
    },
    type: { enum: true, items: [...CAPACITY_EVENT_TYPES], fieldName: 'type' },
    programId: {
      // A `mapToPk` relation: the property is the plain identifier the domain
      // event carries, and MikroORM owns the foreign key — so the constraint is
      // part of the mapping the drift test compares, not a hand-written statement
      // in the migration that the comparison would report as drift.
      kind: 'm:1',
      entity: () => 'Program',
      mapToPk: true,
      fieldName: 'program_id',
      updateRule: 'cascade',
      deleteRule: 'restrict',
    },
    invoiceId: {
      type: 'string',
      length: 128,
      nullable: true,
      fieldName: 'invoice_id',
    },
    delta: { type: moneyAmount, fieldName: 'delta' },
    resultingReserved: {
      type: moneyAmount,
      fieldName: 'resulting_reserved',
    },
    currency: { type: 'string', length: 3, fieldName: 'currency' },
    actor: { type: 'string', length: 255, fieldName: 'actor' },
    source: {
      enum: true,
      items: [...CAPACITY_EVENT_SOURCES],
      fieldName: 'source',
    },
    correlationId: {
      type: 'string',
      length: 128,
      nullable: true,
      fieldName: 'correlation_id',
    },
    occurredAt: { type: 'datetime', fieldName: 'occurred_at' },
    recordedAt: {
      type: 'datetime',
      fieldName: 'recorded_at',
      defaultRaw: 'now()',
    },
    metadata: { type: 'json', fieldName: 'metadata', defaultRaw: "'{}'" },
  },
  indexes: [
    {
      // The audit read of docs/PLAN.md 2.7: one program's log, paged by the
      // cursor. Also the index the `SUM(delta)` invariant check walks.
      name: 'capacity_events_program_id_id_index',
      properties: ['programId', 'id'],
    },
    {
      // "Why did available capacity drop by 1.8M at 10:32?" — the question
      // docs/PLAN.md 2.8 says the log exists to answer.
      name: 'capacity_events_program_id_occurred_at_index',
      properties: ['programId', 'occurredAt'],
    },
    {
      // Every event about one invoice, across programs: the release path's
      // history, and what an investigation into a single invoice reads.
      name: 'capacity_events_invoice_id_index',
      properties: ['invoiceId'],
    },
  ],
  checks: [
    {
      name: 'capacity_events_resulting_reserved_non_negative',
      expression: 'resulting_reserved >= 0',
    },
    {
      // `LIMIT_CHANGED` concerns no single invoice and every other type does.
      // Stated in DDL because the log is what later cycles reconstruct state
      // from, and a `RESERVED` row with no invoice would be unattributable.
      // A `LIMIT_CHANGED` concerns the limit and a `RECONCILIATION_APPLIED` a
      // whole snapshot; every other type is about one invoice and must name it.
      // Written as a boolean equality rather than two `or`-ed branches so the
      // rule reads as the biconditional it is.
      name: 'capacity_events_invoice_id_presence',
      expression:
        "(type = any(array['LIMIT_CHANGED', 'RECONCILIATION_APPLIED'])) = (invoice_id is null)",
    },
  ],
});

/**
 * The columns a new event is written from — everything except what the database
 * assigns.
 */
export type NewCapacityEventRow = Omit<CapacityEventRow, 'id' | 'recordedAt'>;

/**
 * Flattens a domain event into its row.
 *
 * `delta` and `resultingReserved` share one currency column, so this is also where
 * an event that states them in two different currencies is refused: such an event
 * could only come from an aggregate whose counter and delta disagree, and writing
 * it would leave a log row that means nothing.
 *
 * `metadata` is passed through as it is. It is already all JSON primitives by
 * construction (see `CapacityEventMetadata`), which is why no transformer sits
 * here to reshape it — the round-trip test asserts the loaded metadata deep-equals
 * what the domain produced, `MoneyJson` strings and `FxRateSnapshot` included.
 *
 * @throws {CurrencyMismatchError} if the two amounts are stated in different
 * currencies.
 */
export function toCapacityEventRow(event: CapacityEvent): NewCapacityEventRow {
  const { delta, resultingReserved } = event;

  if (delta.currency !== resultingReserved.currency) {
    throw new CurrencyMismatchError(
      'record a capacity event',
      delta.currency,
      resultingReserved.currency,
    );
  }

  return {
    type: event.type,
    programId: event.programId,
    invoiceId: event.invoiceId,
    delta,
    resultingReserved,
    // One column for both amounts, taken from the delta now that the two are
    // known to agree.
    currency: delta.currency,
    actor: event.actor,
    source: event.source,
    correlationId: event.correlationId,
    occurredAt: event.occurredAt,
    metadata: event.metadata,
  };
}

/**
 * Rebuilds the domain event from its row, pairing both amounts with the row's
 * currency through `Money.fromMinorUnits` — so an unsupported currency code is
 * refused here exactly as it is for a program or a hold.
 *
 * The `id` and `recordedAt` are dropped: the domain event is the fact, and neither
 * is part of it. Cycle 7's audit endpoint reads the row directly for its cursor.
 *
 * @throws {UnknownCurrencyError} if the stored currency is not supported.
 */
export function capacityEventFromRow(row: CapacityEventRow): CapacityEvent {
  return {
    type: row.type,
    programId: row.programId,
    invoiceId: row.invoiceId,
    // `row.delta` is declared `Money` because that is what a write hands over;
    // on the way back it is the `bigint` `MoneyAmountType` produced, which is
    // exactly what `moneyFromColumns` pairs with the row's currency.
    delta: moneyFromColumns(row.delta, row.currency),
    resultingReserved: moneyFromColumns(row.resultingReserved, row.currency),
    actor: row.actor,
    source: row.source,
    correlationId: row.correlationId,
    occurredAt: row.occurredAt,
    metadata: row.metadata,
  };
}

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
 * One `capacity_events` row. Mapped as a row and two pure functions rather
 * than as a tracked aggregate: the event is an immutable value the domain
 * returns, the table is append-only, and nothing ever loads a row to change it.
 */
export interface CapacityEventRow {
  /** `bigserial`, assigned by the database — the order the log is read in. */
  id: bigint;
  type: CapacityEventType;
  programId: string;
  invoiceId: string | null;
  /** The change to the reserved total. Zero for `LIMIT_CHANGED`. */
  delta: Money;
  /** The reserved total after the change. */
  resultingReserved: Money;
  /** The currency of both amounts, once per row. */
  currency: CurrencyCode;
  actor: string;
  source: CapacityEventSource;
  correlationId: string | null;
  /** When the change happened, as the caller observed it. */
  occurredAt: Date;
  /** When the row was written, by the database's clock. */
  recordedAt: Date;
  metadata: CapacityEventMetadata;
}

/**
 * `capacity_events` — the append-only audit log of docs/PLAN.md 2.8.
 *
 * Append-only is enforced by a `BEFORE UPDATE OR DELETE` trigger from the
 * migration, not a `REVOKE` (the test harness connects as the table owner,
 * whose privileges a `REVOKE` would not actually constrain). `TRUNCATE` is
 * deliberately left ungated: it cannot touch a single row and is how the
 * integration suite isolates tests (docs/PLAN.md 2.10).
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
      name: 'capacity_events_program_id_id_index',
      properties: ['programId', 'id'],
    },
    {
      name: 'capacity_events_program_id_occurred_at_index',
      properties: ['programId', 'occurredAt'],
    },
    {
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
      // Boolean equality, not two `or`-ed branches, so the rule reads as the
      // biconditional it is: these two types never name an invoice, every
      // other type must.
      name: 'capacity_events_invoice_id_presence',
      expression:
        "(type = any(array['LIMIT_CHANGED', 'RECONCILIATION_APPLIED'])) = (invoice_id is null)",
    },
  ],
});

/** The columns a new event is written from — everything except what the database assigns. */
export type NewCapacityEventRow = Omit<CapacityEventRow, 'id' | 'recordedAt'>;

/**
 * Flattens a domain event into its row.
 * @throws {CurrencyMismatchError} if `delta` and `resultingReserved` are
 * stated in different currencies — the row has one currency column for both.
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
    currency: delta.currency,
    actor: event.actor,
    source: event.source,
    correlationId: event.correlationId,
    occurredAt: event.occurredAt,
    metadata: event.metadata,
  };
}

/**
 * Rebuilds the domain event from its row, pairing both amounts with the
 * row's currency.
 * @throws {UnknownCurrencyError} if the stored currency is not supported.
 */
export function capacityEventFromRow(row: CapacityEventRow): CapacityEvent {
  return {
    type: row.type,
    programId: row.programId,
    invoiceId: row.invoiceId,
    // `row.delta` is declared `Money` (the write shape); on the way back
    // it's the raw amount `moneyFromColumns` pairs with `row.currency`.
    delta: moneyFromColumns(row.delta, row.currency),
    resultingReserved: moneyFromColumns(row.resultingReserved, row.currency),
    actor: row.actor,
    source: row.source,
    correlationId: row.correlationId,
    occurredAt: row.occurredAt,
    metadata: row.metadata,
  };
}

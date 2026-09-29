import { type EntityManager } from '@mikro-orm/postgresql';

// Raw SQL against the run's database: for staging a row the domain would
// refuse to write (hydration/constraint tests), and for reading a column as
// the driver hands it over rather than through `MoneyAmountType`.

/** A `bigint` column as this suite states it: minor units, never a decimal. */
export type MinorUnits = string;

export interface ProgramRowValues {
  id: string;
  owner_org_id: string;
  currency: string;
  credit_limit: MinorUnits;
  reserved_amount: MinorUnits;
  last_snapshot_sequence: string | null;
  last_reconciled_at: Date | null;
}

const PROGRAM_ROW_DEFAULTS: ProgramRowValues = {
  id: 'prog-northwind',
  owner_org_id: 'org-northwind',
  currency: 'USD',
  credit_limit: '1000000000',
  reserved_amount: '0',
  last_snapshot_sequence: null,
  last_reconciled_at: null,
};

// Inserts one `programs` row exactly as given; throws whatever Postgres says
// if a constraint refuses it, which is what the CHECK tests assert on.
export async function insertProgramRow(
  em: EntityManager,
  values: Partial<ProgramRowValues> = {},
): Promise<ProgramRowValues> {
  const row = { ...PROGRAM_ROW_DEFAULTS, ...values };

  await execute(
    em,
    `insert into "programs" ("id", "owner_org_id", "currency", "credit_limit", "reserved_amount", "last_snapshot_sequence", "last_reconciled_at")
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.owner_org_id,
      row.currency,
      row.credit_limit,
      row.reserved_amount,
      row.last_snapshot_sequence,
      row.last_reconciled_at,
    ],
  );

  return row;
}

export interface ReservationRowValues {
  program_id: string;
  invoice_id: string;
  status: string;
  original_amount: MinorUnits;
  original_currency: string;
  reserved_amount: MinorUnits;
  released_amount: MinorUnits;
  held_currency: string;
  fx_base: string | null;
  fx_quote: string | null;
  fx_scaled_value: MinorUnits | null;
  fx_scale: number | null;
  fx_source: string | null;
  fx_as_of: Date | null;
  reserved_at: Date;
  released_at: Date | null;
  release_reason: string | null;
}

const RESERVATION_ROW_DEFAULTS: ReservationRowValues = {
  program_id: 'prog-northwind',
  invoice_id: 'inv-0001',
  status: 'ACTIVE',
  original_amount: '10000000',
  original_currency: 'USD',
  reserved_amount: '10000000',
  released_amount: '0',
  held_currency: 'USD',
  fx_base: null,
  fx_quote: null,
  fx_scaled_value: null,
  fx_scale: null,
  fx_source: null,
  fx_as_of: null,
  reserved_at: new Date('2026-01-15T10:32:00.000Z'),
  released_at: null,
  release_reason: null,
};

/** Inserts one `reservations` row exactly as given. */
export async function insertReservationRow(
  em: EntityManager,
  values: Partial<ReservationRowValues> = {},
): Promise<ReservationRowValues> {
  const row = { ...RESERVATION_ROW_DEFAULTS, ...values };

  await execute(
    em,
    `insert into "reservations" ("program_id", "invoice_id", "status", "original_amount", "original_currency", "reserved_amount", "released_amount", "held_currency", "fx_base", "fx_quote", "fx_scaled_value", "fx_scale", "fx_source", "fx_as_of", "reserved_at", "released_at", "release_reason")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.program_id,
      row.invoice_id,
      row.status,
      row.original_amount,
      row.original_currency,
      row.reserved_amount,
      row.released_amount,
      row.held_currency,
      row.fx_base,
      row.fx_quote,
      row.fx_scaled_value,
      row.fx_scale,
      row.fx_source,
      row.fx_as_of,
      row.reserved_at,
      row.released_at,
      row.release_reason,
    ],
  );

  return row;
}

export interface CapacityEventRowValues {
  type: string;
  program_id: string;
  invoice_id: string | null;
  delta: MinorUnits;
  resulting_reserved: MinorUnits;
  currency: string;
  actor: string;
  source: string;
  correlation_id: string | null;
  occurred_at: Date;
  metadata: string;
}

const CAPACITY_EVENT_ROW_DEFAULTS: CapacityEventRowValues = {
  type: 'RESERVED',
  program_id: 'prog-northwind',
  invoice_id: 'inv-0001',
  delta: '10000000',
  resulting_reserved: '10000000',
  currency: 'USD',
  actor: 'user-42',
  source: 'API',
  correlation_id: 'corr-0001',
  occurred_at: new Date('2026-01-15T10:32:00.000Z'),
  metadata: '{}',
};

/** Inserts one `capacity_events` row and returns the `bigserial` it was given. */
export async function insertCapacityEventRow(
  em: EntityManager,
  values: Partial<CapacityEventRowValues> = {},
): Promise<bigint> {
  const row = { ...CAPACITY_EVENT_ROW_DEFAULTS, ...values };

  const inserted = await execute<{ id: string }[]>(
    em,
    `insert into "capacity_events" ("type", "program_id", "invoice_id", "delta", "resulting_reserved", "currency", "actor", "source", "correlation_id", "occurred_at", "metadata")
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     returning "id"`,
    [
      row.type,
      row.program_id,
      row.invoice_id,
      row.delta,
      row.resulting_reserved,
      row.currency,
      row.actor,
      row.source,
      row.correlation_id,
      row.occurred_at,
      row.metadata,
    ],
  );

  return BigInt(inserted[0]!.id);
}

export interface FxRateRowValues {
  base: string;
  quote: string;
  scaled_value: MinorUnits;
  scale: number;
  source: string;
  as_of: Date;
}

const FX_RATE_ROW_DEFAULTS: FxRateRowValues = {
  base: 'USD',
  quote: 'EUR',
  scaled_value: '923500000000',
  scale: 12,
  source: 'seed',
  as_of: new Date('2026-09-01T00:00:00.000Z'),
};

/** Inserts one `fx_rates` row — one direction of one pair. */
export async function insertFxRateRow(
  em: EntityManager,
  values: Partial<FxRateRowValues> = {},
): Promise<FxRateRowValues> {
  const row = { ...FX_RATE_ROW_DEFAULTS, ...values };

  await execute(
    em,
    `insert into "fx_rates" ("base", "quote", "scaled_value", "scale", "source", "as_of")
     values (?, ?, ?, ?, ?, ?)`,
    [row.base, row.quote, row.scaled_value, row.scale, row.source, row.as_of],
  );

  return row;
}

/** One statement, on the connection this `EntityManager` is working through. */
export async function execute<T = unknown>(
  em: EntityManager,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T> {
  const rows: unknown = await em
    .getConnection()
    .execute(sql, [...params], 'all', em.getTransactionContext());

  return rows as T;
}

/** The single row a query is expected to return, or `undefined`. */
export async function selectRow<T extends object>(
  em: EntityManager,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  const rows = await execute<T[]>(em, sql, params);

  return rows[0];
}

/** How many rows a table currently holds, as a `number`. */
export async function countRows(
  em: EntityManager,
  table: string,
): Promise<number> {
  const row = await selectRow<{ count: string }>(
    em,
    `select count(*) as count from "${table}"`,
  );

  return Number(row?.count);
}

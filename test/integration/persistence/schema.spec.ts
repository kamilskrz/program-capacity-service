import { type MikroORM } from '@mikro-orm/postgresql';

import { initTestOrm, mappedTables, resetDatabase } from '../support/orm';
import { execute, insertProgramRow } from '../support/rows';

// The hand-written migration and the EntitySchema mappings describe one
// schema; nothing keeps them in sync except care, and a mismatched CHECK or
// column can stay silent until a row nobody can explain shows up in
// production. `getUpdateSchemaSQL` diffs the live, migrated database against
// the metadata and must return nothing. It can't see triggers or the
// composite foreign key `program.mapping.ts` deliberately omits, which is why
// constraints are also named by hand below.
describe('the schema the migration produced', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  // Clean before, not after, like every other spec: every file truncates on
  // the way in and leaves its rows behind, so cleaning up only here would make
  // this file depend on run order (Jest's sequencer can reorder by file size).
  beforeEach(async () => {
    await resetDatabase(orm);
  });

  it('matches the mappings exactly, with nothing left to alter', async () => {
    const drift = await orm
      .getSchemaGenerator()
      .getUpdateSchemaSQL({ safe: false, dropTables: false });

    expect(drift.trim()).toBe('');
  });

  it('has a table for every mapped entity', async () => {
    const present = await execute<{ table_name: string }[]>(
      orm.em,
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = present.map((row) => row.table_name);

    expect(names).toEqual(expect.arrayContaining(mappedTables(orm)));
  });

  describe('the constraints the domain depends on', () => {
    // Named rather than counted, so a failure says which rule the database
    // stopped enforcing.
    const expectedChecks = [
      // Deliberately not accompanied by an `available >= 0` check (docs/PLAN.md §2.4).
      'programs_reserved_amount_non_negative',
      'programs_credit_limit_non_negative',
      'reservations_reserved_amount_positive',
      'reservations_released_amount_non_negative',
      'reservations_fx_evidence_complete',
      'reservations_fx_scaled_value_positive',
      'reservations_lifecycle',
      'reservations_released_after_reserved',
      'capacity_events_resulting_reserved_non_negative',
      'capacity_events_invoice_id_presence',
      'treasury_discrepancies_has_an_amount',
      'treasury_discrepancies_last_seen_after_first_seen',
      'fx_rates_scaled_value_positive',
      'fx_rates_base_differs_from_quote',
    ];

    it.each(expectedChecks)('enforces %s', async (name) => {
      const found = await execute<{ conname: string }[]>(
        orm.em,
        `select conname from pg_constraint where contype = 'c' and conname = ?`,
        [name],
      );

      expect(found).toHaveLength(1);
    });
  });

  describe('the keys that make idempotency and upserts possible', () => {
    // A primary key, as the ordered list of columns it covers. These are
    // natural keys, not surrogates, and the order matters: it's the
    // idempotency key of docs/PLAN.md §2.5 and the upsert key of §2.8.
    const primaryKeyOf = async (table: string): Promise<string[]> => {
      const rows = await execute<{ column_name: string }[]>(
        orm.em,
        `select a.attname as column_name
           from pg_constraint c
           join pg_class t on t.oid = c.conrelid
           join unnest(c.conkey) with ordinality as k(attnum, ord) on true
           join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
          where c.contype = 'p' and t.relname = ?
          order by k.ord`,
        [table],
      );

      return rows.map((row) => row.column_name);
    };

    it('keys a reservation by the invoice it funds within its program', async () => {
      await expect(primaryKeyOf('reservations')).resolves.toEqual([
        'program_id',
        'invoice_id',
      ]);
    });

    it('keys a discrepancy by program, invoice and reason, so the same invoice can be wrong in two ways', async () => {
      await expect(primaryKeyOf('treasury_discrepancies')).resolves.toEqual([
        'program_id',
        'invoice_id',
        'reason',
      ]);
    });

    // Proved here in raw SQL because `discrepancy.mapping.ts` ships no
    // repository yet, but its contract already promises this upsert works.
    it('upserts a discrepancy by its key, moving last_seen without duplicating the row or disturbing first_seen', async () => {
      await insertProgramRow(orm.em);

      const firstSeen = new Date('2026-09-01T00:00:00.000Z');
      const lastSeenLater = new Date('2026-09-05T00:00:00.000Z');

      const upsert = (lastSeen: Date) =>
        execute(
          orm.em,
          `insert into "treasury_discrepancies"
             ("program_id", "invoice_id", "reason", "detail", "held_amount", "reported_amount", "currency", "first_seen", "last_seen")
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict ("program_id", "invoice_id", "reason")
           do update set "last_seen" = excluded."last_seen"`,
          [
            'prog-northwind',
            'inv-0001',
            'HELD_BUT_NOT_REPORTED',
            'held locally but never reported by treasury',
            '1800000',
            null,
            'USD',
            firstSeen,
            lastSeen,
          ],
        );

      await upsert(firstSeen);
      await upsert(lastSeenLater);

      // Raw connection hands timestamptz back as a string, parsed here before comparing.
      const rows = await execute<{ first_seen: string; last_seen: string }[]>(
        orm.em,
        `select "first_seen", "last_seen" from "treasury_discrepancies"
          where "program_id" = ? and "invoice_id" = ? and "reason" = ?`,
        ['prog-northwind', 'inv-0001', 'HELD_BUT_NOT_REPORTED'],
      );

      expect(rows).toHaveLength(1);
      expect(new Date(rows[0]!.first_seen).toISOString()).toBe(
        firstSeen.toISOString(),
      );
      expect(new Date(rows[0]!.last_seen).toISOString()).toBe(
        lastSeenLater.toISOString(),
      );
    });

    it('keys an FX rate by one direction of the pair, because a rate is never inverted', async () => {
      await expect(primaryKeyOf('fx_rates')).resolves.toEqual([
        'base',
        'quote',
      ]);
    });

    it('gives the audit log a sequence of its own to page by', async () => {
      await expect(primaryKeyOf('capacity_events')).resolves.toEqual(['id']);
    });
  });

  describe('the column types amounts depend on', () => {
    it('stores every amount as bigint, so no amount can be rounded by the database', async () => {
      const columns = await execute<
        { table_name: string; column_name: string }[]
      >(
        orm.em,
        `select table_name, column_name, data_type
           from information_schema.columns
          where table_schema = 'public'
            and column_name in ('credit_limit', 'reserved_amount', 'released_amount', 'original_amount', 'delta', 'resulting_reserved', 'held_amount', 'reported_amount', 'scaled_value', 'fx_scaled_value')
            and data_type <> 'bigint'`,
      );

      expect(columns).toEqual([]);
    });

    it('stores every instant with its zone, so a treasury asOf cannot be reinterpreted locally', async () => {
      const columns = await execute<
        { table_name: string; column_name: string }[]
      >(
        orm.em,
        `select table_name, column_name, data_type
           from information_schema.columns
          where table_schema = 'public'
            and table_name <> 'mikro_orm_migrations'
            and data_type like 'timestamp%'
            and data_type <> 'timestamp with time zone'`,
      );

      expect(columns).toEqual([]);
    });
  });
});

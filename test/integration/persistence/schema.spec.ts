import { type MikroORM } from '@mikro-orm/postgresql';

import { initTestOrm, mappedTables, resetDatabase } from '../support/orm';
import { execute, insertProgramRow } from '../support/rows';

/**
 * The migration and the mappings describe one schema.
 *
 * # Why this test exists
 *
 * The migration is hand-written (docs/PLAN.md 2.6: never `schema:update`), and the
 * `EntitySchema` mappings are what MikroORM believes about the same tables. Nothing
 * makes the two agree except care, and a disagreement is silent in the worst
 * possible way: the ORM issues SQL for the schema it believes in, so a column the
 * migration spelled differently, a `CHECK` the mapping declares and the migration
 * forgot, or a foreign key only one side knows about all surface as a runtime error
 * in an unrelated cycle — or, for a missing `CHECK`, as no error at all until a row
 * nobody can explain is in production.
 *
 * MikroORM can answer the question directly: `getUpdateSchemaSQL` introspects the
 * live database, compares it with the metadata, and returns the statements that
 * would be needed to make one match the other. The assertion is that there are
 * none.
 *
 * The schema under test is the one `globalSetup` produced by running the migrator,
 * which is the same code path as `npm run migration:up` and as the one-shot
 * `migrate` container — so what is compared is a deployed schema, not one a test
 * created for itself.
 *
 * ## What the diff cannot see
 *
 * Triggers (the append-only guard of docs/PLAN.md 2.8, covered by
 * `capacity-event-log.spec.ts`) and the composite foreign key `program.mapping.ts`
 * explains it deliberately does not declare. Everything else is in scope, which is
 * why the constraint names are also asserted by hand below: a `CHECK` is the one
 * kind of drift whose absence changes nothing until it matters, so it is worth
 * naming the constraints rather than trusting that the comparator looked.
 */
describe('the schema the migration produced', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  // Clean **before**, like every other spec, rather than after the one test that
  // writes. Cleaning up afterwards reads as tidy and is not: it makes the file
  // depend on whoever ran before it leaving the database empty, which no other spec
  // promises — they all truncate on the way in and leave their last test's rows
  // behind. This file got away with it until an unrelated edit changed file sizes,
  // which is enough to reorder the run (Jest's default sequencer orders by size), at
  // which point the program row this file inserts collided with one left by the spec
  // now scheduled ahead of it.
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
    /**
     * Every `CHECK` the mappings declare, by the name the migration gives it.
     *
     * Named rather than counted: a failure has to say *which* rule the database
     * stopped enforcing, because each of these is a rule the domain also states
     * and the pair is the point — a migration that loosens one must not silently
     * loosen the service.
     */
    const expectedChecks = [
      // docs/PLAN.md 2.4: the counter is a sum of holds, and a negative sum is
      // corruption. Deliberately not accompanied by an `available >= 0` check.
      'programs_reserved_amount_non_negative',
      'programs_credit_limit_non_negative',
      // A hold that consumes nothing, or creates capacity, is not a hold.
      'reservations_reserved_amount_positive',
      'reservations_released_amount_non_negative',
      // docs/PLAN.md 2.3: the FX evidence is nullable as a group of six.
      'reservations_fx_evidence_complete',
      'reservations_fx_scaled_value_positive',
      // docs/PLAN.md 2.5: the two shapes this service can produce, and no
      // half-released row in between.
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
    /**
     * A primary key, read as the ordered list of columns it covers.
     *
     * These are natural keys, not surrogates, and their column order is part of
     * the design: `(program_id, invoice_id)` is the idempotency key of
     * docs/PLAN.md 2.5, and `(program_id, invoice_id, reason)` is the upsert key
     * of 2.8 — the part of the schema cycle 8 could not change later without a
     * data migration.
     */
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

    /**
     * The upsert itself, in raw SQL, against the key the previous test only shows
     * the shape of.
     *
     * `discrepancy.mapping.ts` deliberately ships no repository — cycle 8 owns the
     * use case — but its docblock promises exactly this: "an upsert of the same
     * triple twice must leave one row with a moved `last_seen`". That is a claim
     * about the schema, not about a use case nobody has written yet, so it is
     * proved here with `insert ... on conflict` rather than left for cycle 8 to
     * discover the key does not support it.
     */
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

      // The raw connection hands a `timestamptz` back as a string (the same
      // `pg`-driver behaviour docs/PLAN.md 2.6 warns about for `bigint`), so it
      // is parsed back into a `Date` before comparing instants.
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

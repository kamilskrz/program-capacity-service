import { type MikroORM } from '@mikro-orm/postgresql';

import { initTestOrm, mappedTables, resetDatabase } from '../support/orm';
import { execute } from '../support/rows';

/**
 * `down()` undoes what `up()` did, and `up()` puts it back.
 *
 * # Why this is worth a test at all
 *
 * The migration's own docblock states the claim: `down` is "written even though
 * nothing in this service's deployment runs it: a migration whose `down` was never
 * written is a migration nobody can undo on the one occasion it matters, and a
 * developer iterating locally reaches for it daily." Nothing exercised it. A `down`
 * that is never run is a `down` that is wrong — a table left behind, a function left
 * behind, a `drop` in an order the foreign keys refuse — and it is wrong exactly when
 * somebody needs it, in the middle of the incident or the rebase that made them reach
 * for it.
 *
 * `schema.spec.ts` proves that the schema `up()` produced matches the mappings. This
 * proves the same thing **after a round trip**, which is a different claim: it catches
 * a `down` that drops four of the five tables and an `up` that then succeeds only
 * because `create table` never ran for the fifth.
 *
 * ## What the schema diff cannot see, and is therefore checked by hand
 *
 * MikroORM does not introspect triggers or functions, so the append-only guard of
 * docs/PLAN.md 2.8 is invisible to `getUpdateSchemaSQL`. It is the one object in the
 * schema that only the migration knows about, which makes it the one most likely to be
 * forgotten by a `down` — and a restored schema whose audit log is silently writable
 * again is the worst possible outcome of running a migration backwards.
 *
 * ## Leaving the database usable
 *
 * The suite shares one container for the whole run (`support/postgres-container.ts`)
 * and every other spec assumes the schema is there, so this file restores it in the
 * same test and then again in an `afterAll` safety net. `up()` leaves the tables
 * empty, which is the state `resetDatabase` would have produced anyway, so nothing
 * downstream can tell the difference — and `--runInBand` means no other file is
 * reading while this one is mid-round-trip.
 */
describe('the migration, run backwards and forwards again', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    // The safety net: whatever happened above, the next spec file finds a migrated
    // database. An assertion failure mid-round-trip would otherwise take the rest of
    // the run with it and hide its own cause behind thirty unrelated errors.
    if ((await orm.getMigrator().getPendingMigrations()).length > 0) {
      await orm.getMigrator().up();
    }

    await resetDatabase(orm);
    await orm.close(true);
  });

  beforeEach(async () => {
    await resetDatabase(orm);
  });

  /** Every table in the schema right now, the migrations table included. */
  async function tables(): Promise<string[]> {
    const rows = await execute<{ table_name: string }[]>(
      orm.em,
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );

    return rows.map((row) => row.table_name);
  }

  /** The names of the triggers this schema installs. */
  async function triggers(): Promise<string[]> {
    const rows = await execute<{ trigger_name: string }[]>(
      orm.em,
      `select distinct trigger_name from information_schema.triggers where trigger_schema = 'public' order by trigger_name`,
    );

    return rows.map((row) => row.trigger_name);
  }

  /** The names of the functions this schema installs. */
  async function functions(): Promise<string[]> {
    const rows = await execute<{ routine_name: string }[]>(
      orm.em,
      `select routine_name from information_schema.routines where routine_schema = 'public' order by routine_name`,
    );

    return rows.map((row) => row.routine_name);
  }

  it('drops all five tables plus the append-only trigger and its function, and restores them', async () => {
    const before = await tables();

    // The premise, asserted rather than assumed: the round trip below is only
    // meaningful against a schema that was fully there to begin with.
    expect(before).toEqual(expect.arrayContaining(mappedTables(orm)));
    expect(await triggers()).toEqual(['capacity_events_append_only']);
    expect(await functions()).toEqual(['capacity_events_append_only']);

    await orm.getMigrator().down();

    // Nothing of the service's schema is left. The migrations table is not the
    // migration's to drop — it is the migrator's own bookkeeping, and
    // `support/orm.ts` excludes it from truncation for the same reason.
    expect(await tables()).toEqual(['mikro_orm_migrations']);
    // The function outlives the table it guards unless `down` says otherwise, which
    // is exactly the kind of leftover a `drop table ... cascade` hides.
    expect(await functions()).toEqual([]);
    expect(await triggers()).toEqual([]);

    await orm.getMigrator().up();

    expect(await tables()).toEqual(before);
    expect(await triggers()).toEqual(['capacity_events_append_only']);
    expect(await functions()).toEqual(['capacity_events_append_only']);
  });

  it('leaves no drift behind, so the restored schema is the one the mappings describe', async () => {
    await orm.getMigrator().down();
    await orm.getMigrator().up();

    const drift = await orm
      .getSchemaGenerator()
      .getUpdateSchemaSQL({ safe: false, dropTables: false });

    // The same assertion `schema.spec.ts` makes about the deployed schema, made
    // again about the restored one: a `down`/`up` pair that quietly loses a `CHECK`
    // is a schema that accepts a row nobody can explain, and no runtime error would
    // ever point at the migration that did it.
    expect(drift.trim()).toBe('');
    expect(await orm.getMigrator().getPendingMigrations()).toHaveLength(0);
    expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(1);
  });

  it('restores an append-only log, not merely a table with the right columns', async () => {
    // The trigger's *effect*, because a restored trigger that points at a restored
    // function is still only two catalogue rows until something tries to rewrite
    // history. `capacity-event-log.spec.ts` asserts this for the deployed schema;
    // asserting it again here is what makes "the round trip restored the guard" a
    // fact rather than an inference from two names.
    await orm.getMigrator().down();
    await orm.getMigrator().up();

    await execute(
      orm.em,
      `insert into "programs" ("id", "owner_org_id", "currency", "credit_limit", "reserved_amount")
       values ('prog-northwind', 'org-northwind', 'USD', '1000000000', '0')`,
    );
    await execute(
      orm.em,
      `insert into "capacity_events" ("type", "program_id", "invoice_id", "delta", "resulting_reserved", "currency", "actor", "source", "occurred_at")
       values ('RESERVED', 'prog-northwind', 'inv-0001', '1800000', '1800000', 'USD', 'user-42', 'API', now())`,
    );

    await expect(
      execute(orm.em, `update "capacity_events" set "actor" = 'somebody-else'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      execute(orm.em, `delete from "capacity_events"`),
    ).rejects.toThrow(/append-only/);
  });
});

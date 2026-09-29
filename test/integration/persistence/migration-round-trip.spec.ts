import { type MikroORM } from '@mikro-orm/postgresql';

import { initTestOrm, mappedTables, resetDatabase } from '../support/orm';
import { execute } from '../support/rows';

// `down()` undoes what `up()` did, and `up()` puts it back — otherwise
// untested, and wrong exactly when an incident or a local rebase needs it.
// Triggers and functions aren't visible to `getUpdateSchemaSQL`, so the
// append-only guard (docs/PLAN.md §2.8) is checked by hand; it's the one
// object only the migration knows about and the likeliest to be left behind
// by a `down`. The suite shares one container for the whole run, so this
// file restores the schema itself, plus an `afterAll` safety net for the
// other spec files.
describe('the migration, run backwards and forwards again', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    // Safety net: an assertion failure mid-round-trip must still leave the
    // next spec file a migrated database.
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

    expect(before).toEqual(expect.arrayContaining(mappedTables(orm)));
    expect(await triggers()).toEqual(['capacity_events_append_only']);
    expect(await functions()).toEqual(['capacity_events_append_only']);

    // `{ to: 0 }`: the bare form only reverts the single most recent migration,
    // and there are two now.
    await orm.getMigrator().down({ to: 0 });

    // The migrations table is the migrator's own bookkeeping, not this migration's to drop.
    expect(await tables()).toEqual(['mikro_orm_migrations']);
    // A function outlives the table it guards unless `down` says otherwise —
    // exactly the leftover `drop table ... cascade` would hide.
    expect(await functions()).toEqual([]);
    expect(await triggers()).toEqual([]);

    await orm.getMigrator().up();

    expect(await tables()).toEqual(before);
    expect(await triggers()).toEqual(['capacity_events_append_only']);
    expect(await functions()).toEqual(['capacity_events_append_only']);
  });

  it('leaves no drift behind, so the restored schema is the one the mappings describe', async () => {
    await orm.getMigrator().down({ to: 0 });
    await orm.getMigrator().up();

    const drift = await orm
      .getSchemaGenerator()
      .getUpdateSchemaSQL({ safe: false, dropTables: false });

    expect(drift.trim()).toBe('');
    expect(await orm.getMigrator().getPendingMigrations()).toHaveLength(0);
    expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(2);
  });

  it('restores an append-only log, not merely a table with the right columns', async () => {
    // The trigger's effect, not just its name: a restored trigger pointing at
    // a restored function is still only two catalogue rows until tested.
    await orm.getMigrator().down({ to: 0 });
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

import { type MikroORM } from '@mikro-orm/postgresql';

import { initTestOrm, mappedTables, resetDatabase } from './support/orm';

/**
 * The harness itself: a container is up, the migrations are applied, the ORM
 * connects, and truncation leaves a usable database behind.
 *
 * It exists so that a failure in the plumbing is reported as a failure of the
 * plumbing. Every other spec in this directory assumes all of the above, and a
 * broken container start would otherwise surface as thirty assertion failures with
 * nothing pointing at the cause.
 */
describe('integration harness', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await resetDatabase(orm);
  });

  it('connects to the container the run started', async () => {
    const [row] = await orm.em
      .getConnection()
      .execute<{ one: number }[]>('select 1 as one');

    expect(row?.one).toBe(1);
  });

  it('has applied every migration', async () => {
    const executed = await orm.getMigrator().getExecutedMigrations();
    const pending = await orm.getMigrator().getPendingMigrations();

    expect(pending).toHaveLength(0);
    // Not "at least one": until the migration lands there is nothing to apply,
    // and this assertion is what turns that into a visible fact rather than a
    // silent pass.
    expect(executed.length).toBeGreaterThan(0);
  });

  it('truncates every mapped table between tests', async () => {
    const tables = mappedTables(orm);

    expect(tables).toEqual(
      expect.arrayContaining([
        'programs',
        'reservations',
        'capacity_events',
        'treasury_discrepancies',
        'fx_rates',
      ]),
    );

    const counts = await Promise.all(
      tables.map(async (table) => {
        const [row] = await orm.em
          .getConnection()
          .execute<{ count: string }[]>(
            `select count(*) as count from "${table}"`,
          );

        return [table, Number(row?.count)] as const;
      }),
    );

    expect(counts).toEqual(tables.map((table) => [table, 0]));
  });
});

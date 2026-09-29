import { type MikroORM } from '@mikro-orm/postgresql';

import { initTestOrm, mappedTables, resetDatabase } from './support/orm';

// Checks the plumbing itself, so a broken container or migration is reported
// as that, rather than as unexplained failures across every other spec.
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

import { type MikroORM } from '@mikro-orm/postgresql';

import { expectSameMoney } from '../support/expect-domain';
import { LATER, OCCURRED_AT, usd } from '../support/factories';
import { initTestOrm, resetDatabase } from '../support/orm';
import { insertProgramRow } from '../support/rows';
import { discrepancySchema } from '../../../src/treasury-sync/infrastructure/persistence/discrepancy.mapping';
import { MikroOrmDiscrepancyRepository } from '../../../src/treasury-sync/infrastructure/persistence/mikro-orm-discrepancy.repository';
import { type UpsertDiscrepancyInput } from '../../../src/treasury-sync/application/ports/discrepancy.repository';

// `MikroOrmDiscrepancyRepository` over the schema `discrepancy-mapping.spec.ts`
// and `schema.spec.ts` already proved in raw SQL: this suite is the same
// upsert key, exercised through the port cycle 8 actually calls.
describe('a stored treasury discrepancy, through the repository', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await resetDatabase(orm);
    await insertProgramRow(orm.em);
  });

  function repo(): MikroOrmDiscrepancyRepository {
    return new MikroOrmDiscrepancyRepository(orm.em.fork());
  }

  const BASE: UpsertDiscrepancyInput = {
    programId: 'prog-northwind',
    invoiceId: 'inv-0001',
    reason: 'HELD_BUT_NOT_REPORTED',
    detail: 'held locally but never reported by treasury',
    held: usd(1_800_000n),
    localStatus: 'ACTIVE',
    reported: null,
    reportedStatus: null,
    currency: 'USD',
    seenAt: OCCURRED_AT,
  };

  it('inserts a new row on the first upsert', async () => {
    await repo().upsert(BASE);

    const open = await repo().findOpenByProgram('prog-northwind');

    expect(open).toHaveLength(1);
    expect(open[0]?.invoiceId).toBe('inv-0001');
    expect(open[0]?.reason).toBe('HELD_BUT_NOT_REPORTED');
    expectSameMoney(open[0]!.held!, usd(1_800_000n));
    expect(open[0]?.reported).toBeNull();
    expect(open[0]?.firstSeen.toISOString()).toBe(OCCURRED_AT.toISOString());
    expect(open[0]?.lastSeen.toISOString()).toBe(OCCURRED_AT.toISOString());
    expect(open[0]?.resolvedAt).toBeNull();
  });

  it('refreshes detail, amounts and lastSeen on a second upsert, but preserves firstSeen', async () => {
    await repo().upsert(BASE);
    await repo().upsert({
      ...BASE,
      detail: 'still held, still unreported, a later snapshot',
      held: usd(2_500_000n),
      seenAt: LATER,
    });

    const open = await repo().findOpenByProgram('prog-northwind');

    expect(open).toHaveLength(1);
    expect(open[0]?.detail).toBe(
      'still held, still unreported, a later snapshot',
    );
    expectSameMoney(open[0]!.held!, usd(2_500_000n));
    expect(open[0]?.firstSeen.toISOString()).toBe(OCCURRED_AT.toISOString());
    expect(open[0]?.lastSeen.toISOString()).toBe(LATER.toISOString());
  });

  it('resolve sets resolvedAt, and the row no longer counts as open', async () => {
    await repo().upsert(BASE);
    await repo().resolve(
      'prog-northwind',
      'inv-0001',
      'HELD_BUT_NOT_REPORTED',
      LATER,
    );

    const open = await repo().findOpenByProgram('prog-northwind');

    expect(open).toHaveLength(0);

    const stored = await orm.em.fork().findOne(discrepancySchema, {
      programId: 'prog-northwind',
      invoiceId: 'inv-0001',
      reason: 'HELD_BUT_NOT_REPORTED',
    });

    expect(stored?.resolvedAt?.toISOString()).toBe(LATER.toISOString());
  });

  it('a resolved row still round-trips, just excluded from findOpenByProgram', async () => {
    await repo().upsert(BASE);
    await repo().upsert({
      ...BASE,
      invoiceId: 'inv-0002',
      reason: 'UNUSABLE_AMOUNT',
      held: null,
      reported: usd(0n),
      reportedStatus: 'OUTSTANDING',
    });
    await repo().resolve(
      'prog-northwind',
      'inv-0001',
      'HELD_BUT_NOT_REPORTED',
      LATER,
    );

    const open = await repo().findOpenByProgram('prog-northwind');

    expect(open.map((row) => row.invoiceId)).toEqual(['inv-0002']);
  });

  it('keys by (programId, invoiceId, reason): a different reason for the same invoice is a distinct row', async () => {
    await repo().upsert(BASE);
    await repo().upsert({
      ...BASE,
      reason: 'REPORTED_AGAINST_RELEASED_HOLD',
      detail: 'a different disagreement about the same invoice',
    });

    const open = await repo().findOpenByProgram('prog-northwind');

    expect(open).toHaveLength(2);
    expect(open.map((row) => row.reason).sort()).toEqual([
      'HELD_BUT_NOT_REPORTED',
      'REPORTED_AGAINST_RELEASED_HOLD',
    ]);
  });

  it('findOpenByProgram reads nothing for another program', async () => {
    await insertProgramRow(orm.em, { id: 'prog-hanseatic' });
    await repo().upsert(BASE);

    const open = await repo().findOpenByProgram('prog-hanseatic');

    expect(open).toHaveLength(0);
  });

  it('reopens a previously resolved discrepancy that reappears, clearing resolvedAt', async () => {
    await repo().upsert(BASE);
    await repo().resolve(
      'prog-northwind',
      'inv-0001',
      'HELD_BUT_NOT_REPORTED',
      OCCURRED_AT,
    );
    await repo().upsert({ ...BASE, seenAt: LATER });

    const open = await repo().findOpenByProgram('prog-northwind');

    expect(open).toHaveLength(1);
    expect(open[0]?.resolvedAt).toBeNull();
  });
});

import { type MikroORM } from '@mikro-orm/postgresql';

import {
  EUR_PER_USD,
  LIMIT,
  aProgram,
  anAuditContext,
  convertedThrough,
  eur,
  reserveOn,
  unconverted,
  usd,
} from '../support/factories';
import { initTestOrm, resetDatabase } from '../support/orm';
import { captureSql, writeStatements } from '../support/sql-log';
import { MikroOrmCapacityEventLog } from '../../../src/capacity/infrastructure/persistence/mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmReservationRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-reservation.repository';

// A transaction that only reads writes nothing. `DomainHydrator` validates
// without adopting, and `MoneyAmountType.compareAsType()` compares minor
// units rather than object identity, precisely so a clean row can't flush
// itself back on every read. Both are invisible when wrong — the service
// keeps working, but `capacity_events` is append-only behind a trigger (a
// read-triggered write there fails in production), a write takes the row
// lock `findById` promises not to queue behind, and every phantom UPDATE
// pollutes the audit trail this table exists to be.
describe('a read-only transaction', () => {
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

  const PROGRAM_ID = 'prog-hanseatic';
  const CONVERTED_INVOICE = 'inv-0002';
  const PLAIN_INVOICE = 'inv-0001';

  // A EUR program with both shapes of hold, an audit entry for each and a
  // watermark — every row type a read path touches.
  async function storeEverything(): Promise<void> {
    const program = aProgram({
      id: PROGRAM_ID,
      currency: 'EUR',
      creditLimit: eur(LIMIT),
    });
    const plain = reserveOn(
      program,
      PLAIN_INVOICE,
      unconverted(eur(1_200_000n)),
    );
    const converted = program.reserve(
      {
        invoiceId: CONVERTED_INVOICE,
        amount: convertedThrough(usd(10_000_000n), EUR_PER_USD),
      },
      null,
      anAuditContext(),
    );

    await orm.em.fork().transactional(async (tx) => {
      const reservations = new MikroOrmReservationRepository(tx);
      const log = new MikroOrmCapacityEventLog(tx);

      new MikroOrmProgramRepository(tx).add(program);
      reservations.add(plain.reservation);
      log.append(plain.event!);
      reservations.add(converted.reservation);
      log.append(converted.event!);

      await tx.flush();
    });

    // Its own transaction: `advanceWatermark` stages on a program the context
    // has read for a capacity change.
    await orm.em.fork().transactional(async (tx) => {
      const programs = new MikroOrmProgramRepository(tx);

      await programs.findForCapacityChange(PROGRAM_ID);
      programs.advanceWatermark(PROGRAM_ID, {
        appliedSequence: 7n,
        reconciledAt: new Date('2026-06-01T08:00:00.000Z'),
      });
    });
  }

  it('issues no insert, update or delete for a transaction that loads everything and flushes', async () => {
    await storeEverything();

    const em = orm.em.fork();
    const { statements } = await captureSql(orm, async () => {
      await em.transactional(async (tx) => {
        const programs = new MikroOrmProgramRepository(tx);
        const reservations = new MikroOrmReservationRepository(tx);
        const log = new MikroOrmCapacityEventLog(tx);

        // Watermark first, so its two-column select reaches the database
        // rather than being answered from the identity map by the full read.
        await programs.findWatermark(PROGRAM_ID);
        await programs.findById(PROGRAM_ID);
        await reservations.findForInvoice(PROGRAM_ID, CONVERTED_INVOICE);
        await reservations.findForReconciliation(PROGRAM_ID, [
          CONVERTED_INVOICE,
        ]);
        await log.findByProgram(PROGRAM_ID, { limit: 10 });
        await log.sumDeltas(PROGRAM_ID);

        // The flush is the point: without it no change set is ever computed.
        await tx.flush();
      });
    });

    expect(writeStatements(statements)).toEqual([]);
    // Guards the capture: an empty write list only means something if reads were seen.
    expect(statements.length).toBeGreaterThan(3);
  });

  it('issues no write when the same rows are loaded and flushed twice over', async () => {
    // A second flush is where an adopted normalisation would show up even if
    // the first happened to match: the snapshot rebuilds after every flush.
    await storeEverything();

    const em = orm.em.fork();
    const { statements } = await captureSql(orm, async () => {
      await em.transactional(async (tx) => {
        const programs = new MikroOrmProgramRepository(tx);

        await programs.findById(PROGRAM_ID);
        await new MikroOrmReservationRepository(tx).findForReconciliation(
          PROGRAM_ID,
          [],
        );
        await tx.flush();
        await tx.flush();
      });
    });

    expect(writeStatements(statements)).toEqual([]);
  });

  it('issues no write when a program is read outside a transaction and the context is flushed', async () => {
    // The shape GET /capacity runs in: one request-scoped EntityManager, one
    // read, and whatever flush the framework performs at request end.
    await storeEverything();

    const em = orm.em.fork();
    const { statements } = await captureSql(orm, async () => {
      await new MikroOrmProgramRepository(em).findById(PROGRAM_ID);
      await em.flush();
    });

    expect(writeStatements(statements)).toEqual([]);
  });
});

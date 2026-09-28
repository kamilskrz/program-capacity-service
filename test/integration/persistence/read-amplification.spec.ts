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

/**
 * A transaction that only reads writes nothing.
 *
 * # The argument this file turns into a test
 *
 * `DomainHydrator` explains at length why it validates without adopting: "adopting
 * the factory's output would write normalised values (a trimmed identifier, a cloned
 * `Date`) onto an entity whose change-detection snapshot was taken from the raw row,
 * and a clean row would flush itself back on every read." `MoneyAmountType` makes the
 * same argument from the other end — `convertToDatabaseValue` accepts a `Money` *as
 * well as* a `bigint` precisely so the comparator can rebuild the snapshot from a
 * freshly assembled amount, and `compareAsType()` returns `string` so a change is
 * judged on the minor units that reach the column rather than on object identity,
 * "a `Money` being immutable and every write replacing the instance".
 *
 * Two careful decisions, and nothing asserted either of them. Both are invisible when
 * wrong: the service keeps working, and every `GET /capacity` quietly issues an
 * `UPDATE` that sets a column to the value it already holds.
 *
 * ## Why that would matter here more than in most services
 *
 * - `capacity_events` is append-only and enforced by a trigger; a read that flushed
 *   a tracked event row would raise `restrict_violation` in production, on a read.
 * - A write takes a row lock. `findById` promises a read that "must not queue behind
 *   a reservation in flight" — an `UPDATE` inside it would make every capacity read
 *   contend with every capacity change, which is the opposite of the O(1) primary-key
 *   read docs/PLAN.md 2.8 designed the denormalized counter for.
 * - The audit trail is the answer to "why did available capacity drop at 10:32?".
 *   Rows rewritten by reads pollute `xmin`, `recorded_at` on anything defaulted, and
 *   any future trigger that watches for real changes.
 *
 * The statements are collected through MikroORM's own `onQuery` hook — see
 * `support/sql-log.ts` for why that and not a second ORM with a capturing logger.
 */
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

  /**
   * A EUR program with both shapes of hold, an audit entry for each and a watermark
   * — every row type a read path touches, so "nothing was written" is a statement
   * about all of them rather than about the simplest one.
   */
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

    // The watermark is its own transaction, because `advanceWatermark` stages the
    // move on a program the context has read for a capacity change.
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

        // The watermark first, so its deliberate two-column select actually
        // reaches the database rather than being answered from the identity map by
        // the full read below.
        await programs.findWatermark(PROGRAM_ID);
        await programs.findById(PROGRAM_ID);
        await reservations.findForInvoice(PROGRAM_ID, CONVERTED_INVOICE);
        await reservations.findForReconciliation(PROGRAM_ID, [
          CONVERTED_INVOICE,
        ]);
        await log.findByProgram(PROGRAM_ID, { limit: 10 });
        await log.sumDeltas(PROGRAM_ID);

        // The flush is the point of the test. Without it the unit of work never
        // computes a change set and the assertion would prove nothing.
        await tx.flush();
      });
    });

    expect(writeStatements(statements)).toEqual([]);
    // A guard on the capture itself: an empty list of writes is only meaningful if
    // the reads were seen at all.
    expect(statements.length).toBeGreaterThan(3);
  });

  it('issues no write when the same rows are loaded and flushed twice over', async () => {
    // The second flush is where an adopted normalisation would show up even if the
    // first one happened to match: the snapshot is rebuilt after every flush, so a
    // value that differs from the column by a trimmed space or a cloned `Date`
    // produces one `UPDATE` per flush, for ever.
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
    // The shape `GET /capacity` runs in: one request-scoped `EntityManager`, one
    // read, and whatever flush the framework performs at the end of the request.
    await storeEverything();

    const em = orm.em.fork();
    const { statements } = await captureSql(orm, async () => {
      await new MikroOrmProgramRepository(em).findById(PROGRAM_ID);
      await em.flush();
    });

    expect(writeStatements(statements)).toEqual([]);
  });
});

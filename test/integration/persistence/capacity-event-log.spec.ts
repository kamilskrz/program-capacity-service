import { type MikroORM } from '@mikro-orm/postgresql';

import { expectSameEvent, expectSameMoney } from '../support/expect-domain';
import {
  EUR_PER_USD,
  LATER,
  OCCURRED_AT,
  aProgram,
  anAuditContext,
  convertedThrough,
  eur,
  reserveOn,
  unconverted,
  usd,
} from '../support/factories';
import { initTestOrm, resetDatabase } from '../support/orm';
import {
  countRows,
  execute,
  insertCapacityEventRow,
  insertProgramRow,
  selectRow,
} from '../support/rows';
import { type CapacityEvent } from '../../../src/capacity/domain/capacity-event';
import { CurrencyMismatchError } from '../../../src/capacity/domain/errors';
import { Money } from '../../../src/capacity/domain/money';
import { type Program } from '../../../src/capacity/domain/program';
import { MikroOrmCapacityEventLog } from '../../../src/capacity/infrastructure/persistence/mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmReservationRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-reservation.repository';

// `capacity_events` — the audit log (docs/PLAN.md §2.8). Three properties
// covered here: a row survives exactly as produced, nothing can rewrite it
// (a trigger, since the connection is the database owner and REVOKE can't
// constrain that), and it commits in the same transaction as the change.
describe('the capacity event log', () => {
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

  /** Stores a program and its first hold, the way a reservation use case will. */
  async function storeProgramWithHold(
    program: Program,
    invoiceId: string,
    change = reserveOn(program, invoiceId, unconverted(usd(1_800_000n))),
  ): Promise<CapacityEvent> {
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      new MikroOrmProgramRepository(tx).add(program);
      new MikroOrmReservationRepository(tx).add(change.reservation);
      new MikroOrmCapacityEventLog(tx).append(change.event!);

      await tx.flush();
    });

    return change.event!;
  }

  /** The program's log, read through a context that has never seen it. */
  async function readLog(programId: string) {
    return new MikroOrmCapacityEventLog(orm.em.fork()).findByProgram(programId);
  }

  describe('round trip', () => {
    it('comes back as the fact the domain produced', async () => {
      const program = aProgram();
      const event = await storeProgramWithHold(program, 'inv-0001');

      const page = await readLog(program.id);

      expect(page.entries).toHaveLength(1);
      expectSameEvent(page.entries[0]!.event, event);
    });

    it('comes back with its metadata, jsonb and all', async () => {
      const program = aProgram({ id: 'prog-hanseatic', currency: 'EUR' });
      const change = reserveOn(
        program,
        'inv-0002',
        convertedThrough(usd(10_000_000n), EUR_PER_USD),
        anAuditContext({
          actor: 'treasury:kafka',
          source: 'TREASURY_SNAPSHOT',
          correlationId: 'snapshot-0042',
          metadata: { snapshotSequence: 42, note: 'reported outstanding' },
        }),
      );

      await storeProgramWithHold(program, 'inv-0002', change);

      const page = await readLog(program.id);
      const loaded = page.entries[0]!.event;

      expect(loaded.metadata).toEqual({
        snapshotSequence: 42,
        note: 'reported outstanding',
        originalAmount: { amount: '10000000', currency: 'USD' },
        fxRate: {
          base: 'USD',
          quote: 'EUR',
          scaledValue: '923500000000',
          scale: 12,
          source: 'seed',
          asOf: OCCURRED_AT.toISOString(),
        },
      });
      // Minor units as a string, so it doesn't depend on a JSON number's range.
      expect(typeof loaded.metadata.originalAmount?.amount).toBe('string');
    });

    it('records no rate at all for a hold that was never converted, rather than a null one', async () => {
      const program = aProgram();

      await storeProgramWithHold(program, 'inv-0001');

      const page = await readLog(program.id);

      // Absent, not null: `fxRate: null` would say a rate was looked for and
      // missing, a different fact from "never converted".
      expect('fxRate' in page.entries[0]!.event.metadata).toBe(false);
      expect(page.entries[0]!.event.metadata).toEqual({
        originalAmount: { amount: '1800000', currency: 'USD' },
      });
    });

    it('carries a negative delta for a release, because the log records the change to the reserved total', async () => {
      const program = aProgram();
      const hold = reserveOn(program, 'inv-0001', unconverted(usd(1_800_000n)));

      await storeProgramWithHold(program, 'inv-0001', hold);

      const em = orm.em.fork();

      await em.transactional(async (tx) => {
        const locked = await new MikroOrmProgramRepository(
          tx,
        ).findForCapacityChange(program.id);
        const existing = await new MikroOrmReservationRepository(
          tx,
        ).findForInvoice(program.id, 'inv-0001');
        const released = locked!.release(
          existing!,
          'REPAID',
          anAuditContext({ occurredAt: LATER }),
        );

        new MikroOrmCapacityEventLog(tx).append(released.event!);
      });

      const page = await readLog(program.id);
      const release = page.entries[1]!.event;

      expect(release.type).toBe('RELEASED');
      expectSameMoney(release.delta, usd(-1_800_000n));
      expectSameMoney(release.resultingReserved, usd(0n));
      expect(release.metadata.reason).toBe('REPAID');
    });

    it('carries a zero delta for a limit change, so the sum of deltas stays the reserved total', async () => {
      const program = aProgram({ creditLimit: usd(1_000_000_000n) });
      const em = orm.em.fork();

      // No `await` needed: `add`/`changeCreditLimit`/`append` only queue the
      // write, and `em.transactional` flushes and commits it itself.
      await em.transactional((tx) => {
        new MikroOrmProgramRepository(tx).add(program);

        const change = program.changeCreditLimit(
          usd(2_000_000_000n),
          anAuditContext(),
        );

        new MikroOrmCapacityEventLog(tx).append(change.event!);
      });

      const page = await readLog(program.id);
      const event = page.entries[0]!.event;

      expect(event.type).toBe('LIMIT_CHANGED');
      expect(event.invoiceId).toBeNull();
      expectSameMoney(event.delta, usd(0n));
      expect(event.metadata.previousCreditLimit).toEqual({
        amount: '1000000000',
        currency: 'USD',
      });
      expect(event.metadata.creditLimit).toEqual({
        amount: '2000000000',
        currency: 'USD',
      });
    });

    it('reads both amounts back as bigint in the currency the row states', async () => {
      const program = aProgram({ id: 'prog-hanseatic', currency: 'EUR' });

      await storeProgramWithHold(
        program,
        'inv-0002',
        reserveOn(program, 'inv-0002', unconverted(eur(9_235_000n))),
      );

      const page = await readLog(program.id);
      const event = page.entries[0]!.event;

      expectSameMoney(event.delta, eur(9_235_000n));
      expectSameMoney(event.resultingReserved, eur(9_235_000n));
      expect(typeof event.delta.minorUnits).toBe('bigint');
    });

    it('stamps the row with the database clock, which is the one instant nobody can pass in', async () => {
      const before = new Date();
      const program = aProgram();

      await storeProgramWithHold(program, 'inv-0001');

      const page = await readLog(program.id);
      const entry = page.entries[0]!;

      expect(entry.event.occurredAt.toISOString()).toBe(
        OCCURRED_AT.toISOString(),
      );
      expect(entry.recordedAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1_000,
      );
      expect(entry.recordedAt.getTime()).toBeGreaterThan(
        entry.event.occurredAt.getTime(),
      );
    });
  });

  describe('append-only', () => {
    it('refuses an update, for every role including the owner the tests connect as', async () => {
      await insertProgramRow(orm.em);
      await insertCapacityEventRow(orm.em);

      await expect(
        execute(
          orm.em,
          `update "capacity_events" set "actor" = 'somebody-else'`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('refuses a delete', async () => {
      await insertProgramRow(orm.em);
      await insertCapacityEventRow(orm.em);

      await expect(
        execute(orm.em, `delete from "capacity_events"`),
      ).rejects.toThrow(/append-only/);
    });

    it('leaves the row untouched after a refused update', async () => {
      await insertProgramRow(orm.em);

      const id = await insertCapacityEventRow(orm.em, { actor: 'user-42' });

      await expect(
        execute(
          orm.em,
          `update "capacity_events" set "actor" = 'somebody-else'`,
        ),
      ).rejects.toThrow();

      const row = await selectRow<{ actor: string }>(
        orm.em,
        `select "actor" from "capacity_events" where "id" = ?`,
        [id.toString()],
      );

      expect(row?.actor).toBe('user-42');
    });

    it('still permits truncation, which is how the suite isolates tests rather than a way to rewrite history', async () => {
      // Deliberately not guarded against truncate: that would cost the
      // isolation strategy the whole suite is built on.
      await insertProgramRow(orm.em);
      await insertCapacityEventRow(orm.em);

      await expect(
        execute(orm.em, `truncate table "capacity_events"`),
      ).resolves.toBeDefined();
      await expect(countRows(orm.em, 'capacity_events')).resolves.toBe(0);
    });
  });

  describe('written in the same transaction as the change it records', () => {
    it('commits the counter movement, the hold and the event together', async () => {
      const program = aProgram();

      await storeProgramWithHold(program, 'inv-0001');

      await expect(countRows(orm.em, 'programs')).resolves.toBe(1);
      await expect(countRows(orm.em, 'reservations')).resolves.toBe(1);
      await expect(countRows(orm.em, 'capacity_events')).resolves.toBe(1);
    });

    it('leaves neither the counter movement nor the event behind when the transaction rolls back', async () => {
      const program = aProgram();
      const em = orm.em.fork();

      await em.transactional(async (tx) => {
        new MikroOrmProgramRepository(tx).add(program);

        await tx.flush();
      });

      const failing = orm.em.fork();

      await expect(
        failing.transactional(async (tx) => {
          const locked = await new MikroOrmProgramRepository(
            tx,
          ).findForCapacityChange(program.id);
          const change = locked!.reserve(
            {
              invoiceId: 'inv-0001',
              amount: unconverted(usd(1_800_000n)),
            },
            null,
            anAuditContext(),
          );

          new MikroOrmReservationRepository(tx).add(change.reservation);
          new MikroOrmCapacityEventLog(tx).append(change.event!);

          await tx.flush();

          throw new Error('the request failed after the flush');
        }),
      ).rejects.toThrow('the request failed after the flush');

      const row = await selectRow<{ reserved_amount: string }>(
        orm.em,
        `select "reserved_amount" from "programs" where "id" = ?`,
        [program.id],
      );

      expect(row?.reserved_amount).toBe('0');
      await expect(countRows(orm.em, 'reservations')).resolves.toBe(0);
      await expect(countRows(orm.em, 'capacity_events')).resolves.toBe(0);
    });
  });

  describe('what a row may say', () => {
    it('refuses an event about one invoice that does not name it', async () => {
      await insertProgramRow(orm.em);

      await expect(
        insertCapacityEventRow(orm.em, {
          type: 'RESERVED',
          invoice_id: null,
        }),
      ).rejects.toThrow(/capacity_events_invoice_id_presence/);
    });

    it('refuses a limit change that names an invoice, because it concerns none', async () => {
      await insertProgramRow(orm.em);

      await expect(
        insertCapacityEventRow(orm.em, {
          type: 'LIMIT_CHANGED',
          invoice_id: 'inv-0001',
          delta: '0',
        }),
      ).rejects.toThrow(/capacity_events_invoice_id_presence/);
    });

    it('accepts a snapshot application that names no invoice', async () => {
      await insertProgramRow(orm.em);

      await expect(
        insertCapacityEventRow(orm.em, {
          type: 'RECONCILIATION_APPLIED',
          invoice_id: null,
          delta: '0',
        }),
      ).resolves.toBeDefined();
    });

    it('refuses a resulting total below zero, mirroring the counter it describes', async () => {
      await insertProgramRow(orm.em);

      await expect(
        insertCapacityEventRow(orm.em, { resulting_reserved: '-1' }),
      ).rejects.toThrow(/capacity_events_resulting_reserved_non_negative/);
    });

    it('refuses an event for a program that does not exist', async () => {
      await expect(
        insertCapacityEventRow(orm.em, { program_id: 'prog-ghost' }),
      ).rejects.toThrow(/capacity_events_program_id_foreign/);
    });

    it('refuses an event whose two amounts are stated in different currencies', () => {
      // One currency column carries both; such an event could only come from
      // an aggregate whose counter and delta already disagree.
      const contradictory: CapacityEvent = {
        type: 'RESERVED',
        programId: 'prog-northwind',
        invoiceId: 'inv-0001',
        delta: usd(1_800_000n),
        resultingReserved: eur(1_800_000n),
        actor: 'user-42',
        source: 'API',
        correlationId: null,
        occurredAt: OCCURRED_AT,
        metadata: {},
      };
      // `append` throws synchronously, so plain `toThrow`, not `rejects.toThrow`.
      expect(() =>
        new MikroOrmCapacityEventLog(orm.em.fork()).append(contradictory),
      ).toThrow(CurrencyMismatchError);
    });

    it('refuses the null the domain returns for a no-op, rather than accepting it quietly', () => {
      // A no-op (replay, repeated release, a correction to the amount already
      // held) produces no event; forwarding null here would be a caller's bug.
      expect(() =>
        new MikroOrmCapacityEventLog(orm.em.fork()).append(
          null as unknown as CapacityEvent,
        ),
      ).toThrow(TypeError);
    });
  });

  describe('reading a program log', () => {
    /** Three events for one program, written in three separate transactions. */
    async function threeEvents(program: Program): Promise<void> {
      await storeProgramWithHold(
        program,
        'inv-0001',
        reserveOn(program, 'inv-0001', unconverted(usd(1_000_000n))),
      );

      for (const invoiceId of ['inv-0002', 'inv-0003']) {
        const em = orm.em.fork();

        await em.transactional(async (tx) => {
          const locked = await new MikroOrmProgramRepository(
            tx,
          ).findForCapacityChange(program.id);
          const change = locked!.reserve(
            { invoiceId, amount: unconverted(usd(1_000_000n)) },
            null,
            anAuditContext(),
          );

          new MikroOrmReservationRepository(tx).add(change.reservation);
          new MikroOrmCapacityEventLog(tx).append(change.event!);
        });
      }
    }

    it('reads the log oldest first, ordered by the sequence and not by a timestamp two rows can share', async () => {
      const program = aProgram();

      await threeEvents(program);

      const page = await readLog(program.id);

      expect(page.entries.map((entry) => entry.event.invoiceId)).toEqual([
        'inv-0001',
        'inv-0002',
        'inv-0003',
      ]);
      expect(page.entries.map((entry) => entry.id)).toEqual([1n, 2n, 3n]);
    });

    it('pages from the cursor the previous page ended at', async () => {
      const program = aProgram();

      await threeEvents(program);

      const log = new MikroOrmCapacityEventLog(orm.em.fork());
      const first = await log.findByProgram(program.id, { limit: 2 });

      expect(first.entries).toHaveLength(2);
      expect(first.nextCursor).toBe(2n);

      const second = await log.findByProgram(program.id, {
        limit: 2,
        after: first.nextCursor!,
      });

      expect(second.entries.map((entry) => entry.event.invoiceId)).toEqual([
        'inv-0003',
      ]);
      expect(second.nextCursor).toBeNull();
    });

    it('reads nothing belonging to another program', async () => {
      const program = aProgram();
      const other = aProgram({ id: 'prog-hanseatic' });

      await threeEvents(program);
      await storeProgramWithHold(other, 'inv-0009');

      const page = await readLog(other.id);

      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]!.event.programId).toBe(other.id);
    });

    it('refuses a page of nothing, rather than reporting an empty log for a program that has three events', async () => {
      // `limit: 0` must not silently answer like a program with no history at
      // all — a caller looping on the cursor with limit 0 would otherwise page
      // through the whole log one row at a time without ever noticing the bug.
      const program = aProgram();

      await threeEvents(program);

      const log = new MikroOrmCapacityEventLog(orm.em.fork());

      await expect(log.findByProgram(program.id, { limit: 0 })).rejects.toThrow(
        /limit/i,
      );
    });

    it('refuses a negative page size for the same reason', async () => {
      const program = aProgram();

      await threeEvents(program);

      const log = new MikroOrmCapacityEventLog(orm.em.fork());

      await expect(
        log.findByProgram(program.id, { limit: -1 }),
      ).rejects.toThrow(/limit/i);
    });

    it('still reads the whole log when no page size is asked for', async () => {
      // The contrast: an absent limit, not a zero one, means "the whole log".
      const program = aProgram();

      await threeEvents(program);

      const page = await readLog(program.id);

      expect(page.entries).toHaveLength(3);
      expect(page.nextCursor).toBeNull();
    });
  });

  describe('the sum of deltas', () => {
    it('reports nothing for a program that has recorded no events, because a sum of nothing has no currency', async () => {
      const program = aProgram();
      const em = orm.em.fork();

      await em.transactional((tx) => {
        new MikroOrmProgramRepository(tx).add(program);
      });

      await expect(
        new MikroOrmCapacityEventLog(orm.em.fork()).sumDeltas(program.id),
      ).resolves.toBeNull();
    });

    it('adds the deltas up in the program currency, as a bigint', async () => {
      await insertProgramRow(orm.em);
      await insertCapacityEventRow(orm.em, {
        invoice_id: 'inv-0001',
        delta: '9007199254740993',
        resulting_reserved: '9007199254740993',
      });
      await insertCapacityEventRow(orm.em, {
        invoice_id: 'inv-0002',
        delta: '1',
        resulting_reserved: '9007199254740994',
      });

      const sum = await new MikroOrmCapacityEventLog(orm.em.fork()).sumDeltas(
        'prog-northwind',
      );

      // Parsed with BigInt, never Number, or this figure comes back one short.
      expectSameMoney(
        sum!,
        Money.fromMinorUnits(9_007_199_254_740_994n, 'USD'),
      );
    });

    it('refuses to answer when the log contradicts itself about the currency', async () => {
      await insertProgramRow(orm.em);
      await insertCapacityEventRow(orm.em, {
        invoice_id: 'inv-0001',
        currency: 'USD',
      });
      await insertCapacityEventRow(orm.em, {
        invoice_id: 'inv-0002',
        currency: 'EUR',
      });

      await expect(
        new MikroOrmCapacityEventLog(orm.em.fork()).sumDeltas('prog-northwind'),
      ).rejects.toThrow();
    });
  });
});

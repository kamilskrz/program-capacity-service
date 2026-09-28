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

/**
 * `capacity_events` — the log that answers "why did available capacity drop by
 * 1.8M at 10:32?" (docs/PLAN.md 2.8).
 *
 * Three properties, and each of them is a separate kind of claim:
 *
 * 1. **a row survives exactly as the domain produced it**, `metadata` included;
 * 2. **nothing can rewrite it** — enforced by a trigger, because the harness and
 *    the local stack connect as the database owner, whose privileges a `REVOKE`
 *    does not constrain;
 * 3. **it is written in the same transaction as the change it records**, which is
 *    the only one of the three that a unit test could not even pretend to check.
 */
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
      // A converted hold reserved under a snapshot: the aggregate writes the
      // original amount and the frozen rate, and the caller's own annotation
      // travels beside them (docs/PLAN.md 2.8).
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
      // An amount inside metadata is minor units as a string, so nothing about
      // it depends on a JSON number's range (docs/PLAN.md 2.3).
      expect(typeof loaded.metadata.originalAmount?.amount).toBe('string');
    });

    it('records no rate at all for a hold that was never converted, rather than a null one', async () => {
      const program = aProgram();

      await storeProgramWithHold(program, 'inv-0001');

      const page = await readLog(program.id);

      // The absence is the evidence: `fxRate: null` would say a rate was looked
      // for and missing, which is a different fact (docs/PLAN.md 2.3).
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
      // docs/PLAN.md 2.8: one column, one quantity. The two limits travel in
      // metadata instead.
      const program = aProgram({ creditLimit: usd(1_000_000_000n) });
      const em = orm.em.fork();

      // Sync callback: `add`, `changeCreditLimit` and `append` are all
      // synchronous — they queue the write into the unit of work, which
      // `em.transactional` flushes and commits itself. `transactional`'s
      // callback type is `T | Promise<T>`, so no `await` is needed or added
      // here; adding one would only move the flush earlier for no reason.
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
      // Deliberately not guarded (docs/PLAN.md 2.8, 2.10): a statement-level
      // truncate trigger would buy nothing and would cost the isolation strategy
      // the whole suite is built on.
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
      // The pair the port promises: no second connection, no outbox, no
      // afterCommit hook — one flush inside one `em.transactional()` writes all
      // of it or none of it (docs/PLAN.md 2.8).
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
      // One currency column carries both, so such an event describes nothing —
      // and it could only come from an aggregate whose counter and delta
      // disagree, which is worth an error rather than a row.
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
      // `append` throws synchronously (see its docblock), so this is a plain
      // `toThrow`, not `rejects.toThrow` — the latter needs a rejected
      // promise, which would mean wrapping a sync throw in a needless async
      // function just to satisfy the matcher.
      expect(() =>
        new MikroOrmCapacityEventLog(orm.em.fork()).append(contradictory),
      ).toThrow(CurrencyMismatchError);
    });

    it('refuses the null the domain returns for a no-op, rather than accepting it quietly', () => {
      // A replayed reservation, a repeated release and a correction to the
      // amount already held all produce no event; forwarding that null here is a
      // caller's bug, and a silent no-op would hide it (docs/PLAN.md 2.8).
      // Same reasoning as above: `append` throws synchronously, so this is a
      // plain `toThrow`.
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
      // E1. `limit: 0` currently produces `{ entries: [], nextCursor: null }`, which
      // is byte for byte the answer for a program that has never recorded anything.
      // That is the one answer this log may never give by accident: it is the audit
      // trail that explains why available capacity moved (docs/PLAN.md 2.8), and
      // "there is nothing to explain it" is a sentence somebody acts on.
      //
      // Refused rather than clamped to one. A page of zero is not a request anybody
      // can mean — no caller pages through a log an entry at a time and asks for
      // none — so it is a bug in the caller, and guessing which page it meant would
      // hide the bug while still answering something. The cursor contract makes the
      // guess particularly unsafe: a clamped page would return one entry and a
      // `nextCursor`, so a caller looping on the cursor with its own `limit` of zero
      // would page through the whole log one row at a time without ever noticing.
      const program = aProgram();

      await threeEvents(program);

      const log = new MikroOrmCapacityEventLog(orm.em.fork());

      await expect(log.findByProgram(program.id, { limit: 0 })).rejects.toThrow(
        /limit/i,
      );
    });

    it('refuses a negative page size for the same reason', async () => {
      // The other non-positive limit, and the one whose current behaviour depends on
      // what the driver makes of `limit -1`: a request nobody can mean must not have
      // an answer that depends on the database's opinion of it.
      const program = aProgram();

      await threeEvents(program);

      const log = new MikroOrmCapacityEventLog(orm.em.fork());

      await expect(
        log.findByProgram(program.id, { limit: -1 }),
      ).rejects.toThrow(/limit/i);
    });

    it('still reads the whole log when no page size is asked for', async () => {
      // The contrast, so that the refusal above cannot be implemented as "a limit is
      // mandatory": `CapacityEventPageRequest.limit` is optional and an absent one
      // means the whole log, which is what the invariant check and `sumDeltas`'
      // neighbours rely on.
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

      // Sync callback: `add` only queues the row; no await needed (see the
      // note on the same pattern earlier in this file).
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

      // Postgres sums a bigint into a numeric, which `pg` hands over as a
      // string; parsed with `BigInt` and never with `Number`, or this figure
      // would come back one short.
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

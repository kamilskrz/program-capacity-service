import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { type MikroORM } from '@mikro-orm/postgresql';

import {
  expectSameFxRate,
  expectSameMoney,
  expectSameReservation,
} from '../support/expect-domain';
import {
  BEYOND_SAFE_INTEGER,
  EUR_PER_USD,
  LATER,
  OCCURRED_AT,
  USD_PER_JPY,
  aProgram,
  anAuditContext,
  convertedThrough,
  eur,
  jpy,
  reserveOn,
  unconverted,
  usd,
} from '../support/factories';
import { InvalidCursorError } from '../../../src/capacity/application/errors';
import { initTestOrm, resetDatabase } from '../support/orm';
import {
  insertProgramRow,
  insertReservationRow,
  selectRow,
} from '../support/rows';
import {
  type Program,
  type ReservationChange,
} from '../../../src/capacity/domain/program';
import { type Reservation } from '../../../src/capacity/domain/reservation';
import { MikroOrmCapacityEventLog } from '../../../src/capacity/infrastructure/persistence/mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmReservationRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-reservation.repository';

// `reservations` through the repository. Two things it has that `programs`
// doesn't: the natural key `(program_id, invoice_id)` (the idempotency rule
// of docs/PLAN.md §2.5 as a primary key), and the frozen FX evidence of §2.3,
// six columns nullable as a group.
describe('a stored reservation', () => {
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

  /** Writes a program together with its holds and their audit entries. */
  async function store(
    program: Program,
    changes: readonly ReservationChange[],
  ): Promise<void> {
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      new MikroOrmProgramRepository(tx).add(program);

      const reservations = new MikroOrmReservationRepository(tx);
      const log = new MikroOrmCapacityEventLog(tx);
      // A release produces a second change for a hold already in the list;
      // added once, but both events are recorded.
      const added = new Set<Reservation>();

      for (const change of changes) {
        if (!added.has(change.reservation)) {
          reservations.add(change.reservation);
          added.add(change.reservation);
        }

        if (change.event !== null) {
          log.append(change.event);
        }
      }

      await tx.flush();
    });
  }

  async function load(
    programId: string,
    invoiceId: string,
  ): Promise<Reservation | null> {
    return new MikroOrmReservationRepository(orm.em.fork()).findForInvoice(
      programId,
      invoiceId,
    );
  }

  describe('round trip', () => {
    it('comes back as the hold that was taken, for an invoice already in the program currency', async () => {
      const program = aProgram();
      const change = reserveOn(
        program,
        'inv-0001',
        unconverted(usd(10_000_000n)),
      );

      await store(program, [change]);

      const loaded = await load(program.id, 'inv-0001');

      expect(loaded).not.toBeNull();
      expectSameReservation(loaded!, change.reservation);
      expect(loaded!.hasFxEvidence()).toBe(false);
      expect(loaded!.fxRate).toBeNull();
    });

    it('comes back with the rate that priced it, for an invoice in another currency', async () => {
      const program = aProgram({ id: 'prog-hanseatic', currency: 'EUR' });
      const change = reserveOn(
        program,
        'inv-0002',
        convertedThrough(usd(10_000_000n), EUR_PER_USD),
      );

      await store(program, [change]);

      const loaded = await load(program.id, 'inv-0002');

      expectSameReservation(loaded!, change.reservation);
      expect(loaded!.hasFxEvidence()).toBe(true);
      expectSameFxRate(loaded!.fxRate, EUR_PER_USD);
      expectSameMoney(loaded!.originalAmount, usd(10_000_000n));
      expectSameMoney(loaded!.reservedAmount, eur(9_235_000n));
    });

    it('comes back exactly when the two currencies subdivide differently', async () => {
      // JPY has 0 decimals, USD 2: the conversion's exponent delta isn't the
      // rate's scale, so confusing the two would be off by 100.
      const program = aProgram({ currency: 'USD' });
      const change = reserveOn(
        program,
        'inv-0003',
        convertedThrough(jpy(1_000_000n), USD_PER_JPY),
      );

      await store(program, [change]);

      const loaded = await load(program.id, 'inv-0003');

      expectSameReservation(loaded!, change.reservation);
      expectSameMoney(loaded!.originalAmount, jpy(1_000_000n));
      expectSameMoney(loaded!.reservedAmount, usd(670_000n));
    });

    it('reads an amount larger than a JS number can hold back exactly', async () => {
      const program = aProgram({
        creditLimit: usd(BEYOND_SAFE_INTEGER * 2n),
      });
      const change = reserveOn(
        program,
        'inv-0004',
        unconverted(usd(BEYOND_SAFE_INTEGER)),
      );

      await store(program, [change]);

      const loaded = await load(program.id, 'inv-0004');

      expectSameMoney(loaded!.reservedAmount, usd(BEYOND_SAFE_INTEGER));
      expect(loaded!.reservedAmount.minorUnits).toBe(BEYOND_SAFE_INTEGER);
    });

    it('comes back released, holding nothing, with the reason and the instant it was released at', async () => {
      const program = aProgram();
      const change = reserveOn(
        program,
        'inv-0005',
        unconverted(usd(10_000_000n)),
      );

      await store(program, [change]);

      const em = orm.em.fork();

      await em.transactional(async (tx) => {
        const reservations = new MikroOrmReservationRepository(tx);
        const locked = await new MikroOrmProgramRepository(
          tx,
        ).findForCapacityChange(program.id);
        const existing = await reservations.findForInvoice(
          program.id,
          'inv-0005',
        );
        const released = locked!.release(
          existing!,
          'REPAID',
          anAuditContext({ occurredAt: LATER }),
        );

        new MikroOrmCapacityEventLog(tx).append(released.event!);
      });

      const loaded = await load(program.id, 'inv-0005');

      expect(loaded!.status).toBe('RELEASED');
      expect(loaded!.releaseReason).toBe('REPAID');
      expect(loaded!.releasedAt?.toISOString()).toBe(LATER.toISOString());
      expectSameMoney(loaded!.releasedAmount, usd(10_000_000n));
      expectSameMoney(loaded!.outstandingAmount, usd(0n));
    });

    it('answers with nothing for an invoice the program has never held', async () => {
      await store(aProgram(), []);

      await expect(load('prog-northwind', 'inv-unknown')).resolves.toBeNull();
    });
  });

  describe('bigint, not the string the driver hands over', () => {
    it('reaches the domain as a bigint on every amount and on the stored rate', async () => {
      await insertProgramRow(orm.em);
      await insertReservationRow(orm.em, {
        original_amount: '10000000',
        original_currency: 'USD',
        reserved_amount: '9235000',
        held_currency: 'EUR',
        fx_base: 'USD',
        fx_quote: 'EUR',
        fx_scaled_value: '923500000000',
        fx_scale: 12,
        fx_source: 'seed',
        fx_as_of: OCCURRED_AT,
      });

      const loaded = await load('prog-northwind', 'inv-0001');

      expect(typeof loaded!.originalAmount.minorUnits).toBe('bigint');
      expect(typeof loaded!.reservedAmount.minorUnits).toBe('bigint');
      expect(typeof loaded!.releasedAmount.minorUnits).toBe('bigint');
      expect(typeof loaded!.fxRate?.scaledValue).toBe('bigint');
    });
  });

  describe('the natural key, which is the idempotency key', () => {
    it('refuses a second reservation for the same invoice in the same program', async () => {
      const program = aProgram();
      const first = reserveOn(
        program,
        'inv-0001',
        unconverted(usd(10_000_000n)),
      );

      await store(program, [first]);

      // The aggregate holds no reservations, so it can't see this itself; the
      // constraint is the backstop for two transactions that both found nothing.
      const duplicate = aProgram();
      const second = reserveOn(
        duplicate,
        'inv-0001',
        unconverted(usd(20_000_000n)),
      );
      const em = orm.em.fork();

      new MikroOrmReservationRepository(em).add(second.reservation);

      await expect(em.flush()).rejects.toThrow(
        UniqueConstraintViolationException,
      );
    });

    it('permits the same invoice identifier under a different program, because it is unique within one', async () => {
      const northwind = aProgram({ id: 'prog-northwind' });
      const hanseatic = aProgram({ id: 'prog-hanseatic' });

      await store(northwind, [
        reserveOn(northwind, 'inv-0001', unconverted(usd(10_000_000n))),
      ]);
      await store(hanseatic, [
        reserveOn(hanseatic, 'inv-0001', unconverted(usd(30_000_000n))),
      ]);

      const first = await load('prog-northwind', 'inv-0001');
      const second = await load('prog-hanseatic', 'inv-0001');

      expectSameMoney(first!.reservedAmount, usd(10_000_000n));
      expectSameMoney(second!.reservedAmount, usd(30_000_000n));
    });

    it('reports the clash at flush time rather than when the hold is created', async () => {
      await insertProgramRow(orm.em);
      await insertReservationRow(orm.em);

      const program = aProgram();
      const change = reserveOn(
        program,
        'inv-0001',
        unconverted(usd(10_000_000n)),
      );
      const em = orm.em.fork();

      expect(() =>
        new MikroOrmReservationRepository(em).add(change.reservation),
      ).not.toThrow();
      await expect(em.flush()).rejects.toThrow(
        UniqueConstraintViolationException,
      );
    });
  });

  describe('the FX evidence, as the columns hold it', () => {
    it('writes all six columns for a converted hold', async () => {
      const program = aProgram({ id: 'prog-hanseatic', currency: 'EUR' });
      const change = reserveOn(
        program,
        'inv-0002',
        convertedThrough(usd(10_000_000n), EUR_PER_USD),
      );

      await store(program, [change]);

      const row = await selectRow<{
        fx_base: string;
        fx_quote: string;
        fx_scaled_value: string;
        fx_scale: number;
        fx_source: string;
        // Raw connection hands timestamptz back as a string, not a Date.
        fx_as_of: string;
        original_currency: string;
        held_currency: string;
      }>(
        orm.em,
        `select "fx_base", "fx_quote", "fx_scaled_value", "fx_scale", "fx_source", "fx_as_of", "original_currency", "held_currency"
           from "reservations" where "program_id" = ? and "invoice_id" = ?`,
        [program.id, 'inv-0002'],
      );

      expect(row).toMatchObject({
        fx_base: 'USD',
        fx_quote: 'EUR',
        fx_scaled_value: '923500000000',
        fx_scale: 12,
        fx_source: 'seed',
        original_currency: 'USD',
        held_currency: 'EUR',
      });
      expect(new Date(row!.fx_as_of).toISOString()).toBe(
        OCCURRED_AT.toISOString(),
      );
    });

    it('leaves all six columns null for a hold that was never converted', async () => {
      const program = aProgram();
      const change = reserveOn(
        program,
        'inv-0001',
        unconverted(usd(10_000_000n)),
      );

      await store(program, [change]);

      const row = await selectRow<{ filled: string }>(
        orm.em,
        `select num_nonnulls(fx_base, fx_quote, fx_scaled_value, fx_scale, fx_source, fx_as_of) as filled
           from "reservations" where "program_id" = ? and "invoice_id" = ?`,
        [program.id, 'inv-0001'],
      );

      // Not "the rate is null": an identity rate would record a quote nobody made.
      expect(Number(row?.filled)).toBe(0);
    });

    it('refuses a half-filled rate, which is neither a converted hold nor an unconverted one', async () => {
      await insertProgramRow(orm.em);

      await expect(
        insertReservationRow(orm.em, {
          fx_base: 'USD',
          fx_quote: 'EUR',
          fx_scaled_value: '923500000000',
          // `fx_scale`, `fx_source` and `fx_as_of` left null.
        }),
      ).rejects.toThrow(/reservations_fx_evidence_complete/);
    });

    it('refuses a stored rate of zero, because a zero price is not a quote', async () => {
      await insertProgramRow(orm.em);

      await expect(
        insertReservationRow(orm.em, {
          fx_base: 'USD',
          fx_quote: 'EUR',
          fx_scaled_value: '0',
          fx_scale: 12,
          fx_source: 'seed',
          fx_as_of: OCCURRED_AT,
        }),
      ).rejects.toThrow(/reservations_fx_scaled_value_positive/);
    });
  });

  describe('the lifecycle the columns can hold', () => {
    it('refuses a hold that consumes nothing', async () => {
      await insertProgramRow(orm.em);

      await expect(
        insertReservationRow(orm.em, { reserved_amount: '0' }),
      ).rejects.toThrow(/reservations_reserved_amount_positive/);
    });

    it('refuses a half-released hold, which is the partial release this service does not implement', async () => {
      await insertProgramRow(orm.em);

      await expect(
        insertReservationRow(orm.em, {
          status: 'ACTIVE',
          reserved_amount: '10000000',
          released_amount: '4000000',
        }),
      ).rejects.toThrow(/reservations_lifecycle/);
    });

    it('refuses an active hold that records when it was released', async () => {
      await insertProgramRow(orm.em);

      await expect(
        insertReservationRow(orm.em, {
          status: 'ACTIVE',
          released_at: LATER,
          release_reason: 'REPAID',
        }),
      ).rejects.toThrow(/reservations_lifecycle/);
    });

    it('refuses a released hold that does not say when or why', async () => {
      await insertProgramRow(orm.em);

      await expect(
        insertReservationRow(orm.em, {
          status: 'RELEASED',
          released_amount: '10000000',
        }),
      ).rejects.toThrow(/reservations_lifecycle/);
    });

    it('refuses a hold released before it was taken, so the in-flight comparison can never read backwards', async () => {
      await insertProgramRow(orm.em);

      await expect(
        insertReservationRow(orm.em, {
          status: 'RELEASED',
          released_amount: '10000000',
          reserved_at: LATER,
          released_at: OCCURRED_AT,
          release_reason: 'REPAID',
        }),
      ).rejects.toThrow(/reservations_released_after_reserved/);
    });

    it('accepts a hold released at the very instant it was taken', async () => {
      await insertProgramRow(orm.em);

      await expect(
        insertReservationRow(orm.em, {
          status: 'RELEASED',
          released_amount: '10000000',
          reserved_at: OCCURRED_AT,
          released_at: OCCURRED_AT,
          release_reason: 'CANCELLED',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('what reconciliation reads', () => {
    /**
     * A program with three holds: two still active, one released — the shape
     * `findForReconciliation` was specified against.
     */
    async function threeHolds(): Promise<Program> {
      const program = aProgram();
      const first = reserveOn(
        program,
        'inv-0001',
        unconverted(usd(1_000_000n)),
      );
      const second = reserveOn(
        program,
        'inv-0002',
        unconverted(usd(2_000_000n)),
      );
      const third = reserveOn(
        program,
        'inv-0003',
        unconverted(usd(3_000_000n)),
      );
      const released = program.release(
        third.reservation,
        'REPAID',
        anAuditContext({ occurredAt: LATER }),
      );

      await store(program, [first, second, third, released]);

      return program;
    }

    it('reads every active hold when the snapshot reports nothing outstanding', async () => {
      const program = await threeHolds();

      const found = await new MikroOrmReservationRepository(
        orm.em.fork(),
      ).findForReconciliation(program.id, []);

      expect(found.map((reservation) => reservation.invoiceId).sort()).toEqual([
        'inv-0001',
        'inv-0002',
      ]);
    });

    it('reads a released hold when the snapshot names it, because treasury reporting one is a discrepancy to flag', async () => {
      const program = await threeHolds();

      const found = await new MikroOrmReservationRepository(
        orm.em.fork(),
      ).findForReconciliation(program.id, ['inv-0003']);

      expect(found.map((reservation) => reservation.invoiceId).sort()).toEqual([
        'inv-0001',
        'inv-0002',
        'inv-0003',
      ]);
    });

    it('reads an invoice named twice over only once, because the domain refuses a duplicated invoice id', async () => {
      const program = await threeHolds();

      const found = await new MikroOrmReservationRepository(
        orm.em.fork(),
      ).findForReconciliation(program.id, ['inv-0001', 'inv-0003']);

      expect(found).toHaveLength(3);
    });

    it('reads nothing belonging to another program', async () => {
      const program = await threeHolds();
      const other = aProgram({ id: 'prog-hanseatic' });

      await store(other, [
        reserveOn(other, 'inv-0001', unconverted(usd(9_000_000n))),
      ]);

      const found = await new MikroOrmReservationRepository(
        orm.em.fork(),
      ).findForReconciliation(program.id, ['inv-0001']);

      expect(
        found.every((reservation) => reservation.programId === program.id),
      ).toBe(true);
      expect(found).toHaveLength(2);
    });

    it('reads nothing for an invoice identifier the snapshot names and this program has never held', async () => {
      const program = await threeHolds();

      const found = await new MikroOrmReservationRepository(
        orm.em.fork(),
      ).findForReconciliation(program.id, ['inv-never-seen']);

      expect(found).toHaveLength(2);
    });
  });

  describe('listByProgram', () => {
    /** Stores one reservation at a given instant. */
    async function reserveAt(
      program: Program,
      invoiceId: string,
      occurredAt: Date,
    ): Promise<void> {
      await store(program, [
        reserveOn(
          program,
          invoiceId,
          unconverted(usd(1_000_000n)),
          anAuditContext({ occurredAt }),
        ),
      ]);
    }

    it('orders by reservedAt, and by invoiceId when two holds share an instant', async () => {
      const program = aProgram();
      const sharedInstant = new Date('2026-02-01T00:00:00.000Z');

      await reserveAt(program, 'inv-0003', OCCURRED_AT);
      await reserveAt(program, 'inv-0002', sharedInstant);
      await reserveAt(program, 'inv-0001', sharedInstant);

      const page = await new MikroOrmReservationRepository(
        orm.em.fork(),
      ).listByProgram(program.id, { limit: 10 });

      expect(page.reservations.map((r) => r.invoiceId)).toEqual([
        'inv-0003',
        'inv-0001',
        'inv-0002',
      ]);
      expect(page.nextCursor).toBeNull();
    });

    it('pages across a cursor round trip with no gaps or duplicates', async () => {
      const program = aProgram();
      const invoiceIds = [
        'inv-0001',
        'inv-0002',
        'inv-0003',
        'inv-0004',
        'inv-0005',
      ];

      for (const [index, invoiceId] of invoiceIds.entries()) {
        await reserveAt(
          program,
          invoiceId,
          new Date(OCCURRED_AT.getTime() + index * 1000),
        );
      }

      const repo = new MikroOrmReservationRepository(orm.em.fork());
      const seen: string[] = [];
      let cursor: string | null = null;
      let first = true;

      while (first || cursor !== null) {
        first = false;

        const page = await repo.listByProgram(program.id, {
          limit: 2,
          after: cursor ?? undefined,
        });

        seen.push(...page.reservations.map((r) => r.invoiceId));
        cursor = page.nextCursor;
      }

      expect(seen).toEqual(invoiceIds);
    });

    it('filters by status', async () => {
      const program = aProgram();
      const first = reserveOn(
        program,
        'inv-0001',
        unconverted(usd(1_000_000n)),
      );
      const second = reserveOn(
        program,
        'inv-0002',
        unconverted(usd(1_000_000n)),
        anAuditContext({ occurredAt: LATER }),
      );
      const released = program.release(
        second.reservation,
        'REPAID',
        anAuditContext({ occurredAt: LATER }),
      );

      await store(program, [first, second, released]);

      const repo = new MikroOrmReservationRepository(orm.em.fork());
      const active = await repo.listByProgram(program.id, {
        limit: 10,
        status: 'ACTIVE',
      });
      const releasedPage = await repo.listByProgram(program.id, {
        limit: 10,
        status: 'RELEASED',
      });

      expect(active.reservations.map((r) => r.invoiceId)).toEqual(['inv-0001']);
      expect(releasedPage.reservations.map((r) => r.invoiceId)).toEqual([
        'inv-0002',
      ]);
    });

    it('reports no next page when the page exactly exhausts the program', async () => {
      const program = aProgram();

      await reserveAt(program, 'inv-0001', OCCURRED_AT);
      await reserveAt(program, 'inv-0002', LATER);

      const page = await new MikroOrmReservationRepository(
        orm.em.fork(),
      ).listByProgram(program.id, { limit: 2 });

      expect(page.reservations).toHaveLength(2);
      expect(page.nextCursor).toBeNull();
    });

    it('refuses a non-positive limit', async () => {
      const program = aProgram();

      await reserveAt(program, 'inv-0001', OCCURRED_AT);

      const repo = new MikroOrmReservationRepository(orm.em.fork());

      await expect(
        repo.listByProgram(program.id, { limit: 0 }),
      ).rejects.toThrow(/limit/i);
      await expect(
        repo.listByProgram(program.id, { limit: -1 }),
      ).rejects.toThrow(/limit/i);
    });

    it('refuses a cursor that does not decode to a usable position, as InvalidCursorError', async () => {
      const program = aProgram();

      await reserveAt(program, 'inv-0001', OCCURRED_AT);

      const repo = new MikroOrmReservationRepository(orm.em.fork());
      const noSeparator = Buffer.from('garbage', 'utf8').toString('base64');
      const unparseableDate = Buffer.from(
        'not-a-date|inv-0001',
        'utf8',
      ).toString('base64');

      await expect(
        repo.listByProgram(program.id, { limit: 10, after: noSeparator }),
      ).rejects.toThrow(InvalidCursorError);
      await expect(
        repo.listByProgram(program.id, { limit: 10, after: unparseableDate }),
      ).rejects.toThrow(InvalidCursorError);
    });
  });
});

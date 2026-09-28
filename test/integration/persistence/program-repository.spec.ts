import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { type MikroORM } from '@mikro-orm/postgresql';

import { expectSameMoney, expectSameProgram } from '../support/expect-domain';
import {
  BEYOND_SAFE_INTEGER,
  aProgram,
  anAuditContext,
  jpy,
  kwd,
  reserveOn,
  unconverted,
  usd,
} from '../support/factories';
import { initTestOrm, resetDatabase } from '../support/orm';
import { insertProgramRow, selectRow } from '../support/rows';
import { Money } from '../../../src/capacity/domain/money';
import {
  type Program,
  type ReservationChange,
} from '../../../src/capacity/domain/program';
import { MikroOrmCapacityEventLog } from '../../../src/capacity/infrastructure/persistence/mikro-orm-capacity-event.log';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmReservationRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-reservation.repository';

/**
 * `programs` through the repository: what goes in comes back, and what the domain
 * would never have written is refused.
 *
 * Every test uses its own `em.fork()`, which is what docs/PLAN.md 2.6 requires of
 * production code as well — the identity map would otherwise hand a second read the
 * object the first one built, and a round-trip test that never touched the database
 * on the way back would pass while the mapping was broken.
 */
describe('a stored program', () => {
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

  /**
   * Inserts a program, and optionally the holds and audit entries that account for
   * its counter, in one transaction — which is the only way this service ever
   * writes a capacity change (docs/PLAN.md 2.4).
   */
  async function store(
    program: Program,
    holds: readonly ReservationChange[] = [],
  ): Promise<void> {
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      new MikroOrmProgramRepository(tx).add(program);

      const reservations = new MikroOrmReservationRepository(tx);
      const log = new MikroOrmCapacityEventLog(tx);

      for (const change of holds) {
        reservations.add(change.reservation);

        if (change.event !== null) {
          log.append(change.event);
        }
      }

      await tx.flush();
    });
  }

  /** Reads the program back through a context that has never seen it before. */
  async function load(programId: string): Promise<Program | null> {
    return new MikroOrmProgramRepository(orm.em.fork()).findById(programId);
  }

  describe('round trip', () => {
    it('comes back as the program that was stored, to the last minor unit', async () => {
      const program = aProgram({ creditLimit: usd(1_000_000_000n) });

      await store(program);

      const loaded = await load(program.id);

      expect(loaded).not.toBeNull();
      expectSameProgram(loaded!, program);
    });

    it('reads a limit larger than a JS number can hold back exactly', async () => {
      const program = aProgram({
        id: 'prog-sovereign',
        creditLimit: usd(BEYOND_SAFE_INTEGER),
      });

      await store(program);

      const loaded = await load(program.id);

      expectSameMoney(loaded!.creditLimit, usd(BEYOND_SAFE_INTEGER));
    });

    it('reads a JPY limit back without inventing the decimals the currency does not have', async () => {
      const program = aProgram({
        id: 'prog-jpy-sakura',
        currency: 'JPY',
        creditLimit: jpy(1_500_000_000n),
      });

      await store(program);

      const loaded = await load(program.id);

      expectSameMoney(loaded!.creditLimit, jpy(1_500_000_000n));
      expect(loaded!.creditLimit.toDecimalString()).toBe('1500000000');
    });

    it('reads a KWD limit back with all three of its decimal places', async () => {
      const program = aProgram({
        id: 'prog-kwd-gulf',
        currency: 'KWD',
        creditLimit: kwd(1_000_123n),
      });

      await store(program);

      const loaded = await load(program.id);

      expectSameMoney(loaded!.creditLimit, kwd(1_000_123n));
      expect(loaded!.creditLimit.toDecimalString()).toBe('1000.123');
    });

    it('writes the amount into the column as its minor units and nothing else', async () => {
      const program = aProgram({
        currency: 'KWD',
        creditLimit: kwd(1_000_123n),
      });

      await store(program);

      const row = await selectRow<{ credit_limit: string }>(
        orm.em,
        `select "credit_limit" from "programs" where "id" = ?`,
        [program.id],
      );

      // The column is what docs/PLAN.md 2.3 calls the internal representation:
      // minor units verbatim, never the decimal string the public API states.
      expect(row?.credit_limit).toBe('1000123');
    });

    it('answers with nothing for a program that was never created', async () => {
      await expect(load('prog-does-not-exist')).resolves.toBeNull();
    });
  });

  describe('bigint, not the string the driver hands over', () => {
    it('is stored in a column pg reports as a string', async () => {
      await insertProgramRow(orm.em, { credit_limit: '100' });

      const row = await selectRow<{ credit_limit: unknown }>(
        orm.em,
        `select "credit_limit" from "programs" where "id" = 'prog-northwind'`,
      );

      // The premise of the next two tests, asserted rather than assumed: this is
      // what docs/PLAN.md 2.6 means by "BIGINT arrives as a string", and why
      // `"100" + "50"` would quietly be `"10050"`.
      expect(typeof row?.credit_limit).toBe('string');
    });

    it('reaches the domain as a bigint, so two amounts add up instead of concatenating', async () => {
      await insertProgramRow(orm.em, {
        credit_limit: '100',
        reserved_amount: '50',
      });

      const loaded = await load('prog-northwind');

      expect(typeof loaded!.creditLimit.minorUnits).toBe('bigint');
      expect(typeof loaded!.reserved.minorUnits).toBe('bigint');
      expect(loaded!.creditLimit.add(loaded!.reserved).minorUnits).toBe(150n);
    });

    it('survives a round trip at the top of the bigint range, which no double could', async () => {
      await insertProgramRow(orm.em, {
        credit_limit: '9223372036854775807',
        reserved_amount: '9007199254740993',
      });

      const loaded = await load('prog-northwind');

      expect(loaded!.creditLimit.minorUnits).toBe(9_223_372_036_854_775_807n);
      expect(loaded!.reserved.minorUnits).toBe(BEYOND_SAFE_INTEGER);
    });
  });

  describe('the counter and the constraint on it', () => {
    it('refuses a negative reserved total at the database, because a sum of holds cannot be negative', async () => {
      await expect(
        insertProgramRow(orm.em, { reserved_amount: '-1' }),
      ).rejects.toThrow(/programs_reserved_amount_non_negative/);
    });

    it('refuses a negative credit limit at the database', async () => {
      await expect(
        insertProgramRow(orm.em, { credit_limit: '-1' }),
      ).rejects.toThrow(/programs_credit_limit_non_negative/);
    });

    it('stores a program that is over-utilised, which reconciliation is allowed to produce', async () => {
      // docs/PLAN.md 2.1: a reduced limit may take availability below zero, and
      // the program then has to store, load, report and release. The hold is
      // persisted with it, so the row set is one the service could actually
      // produce rather than a counter with nothing behind it.
      const program = aProgram({ creditLimit: usd(1_000_000_000n) });
      const hold = reserveOn(
        program,
        'inv-0001',
        unconverted(usd(900_000_000n)),
      );

      program.changeCreditLimit(usd(500_000_000n), anAuditContext());

      await store(program, [hold]);

      const loaded = await load(program.id);

      expectSameProgram(loaded!, program);
      expectSameMoney(loaded!.available, usd(-400_000_000n));
      expect(loaded!.overUtilized).toBe(true);
    });

    it('loads a row whose availability is already negative, without a constraint standing in the way', async () => {
      // Written straight to the table because the state is what a limit change
      // leaves behind, and this test is about the row being *loadable*: there is
      // deliberately no `CHECK (credit_limit >= reserved_amount)` in any
      // spelling (docs/PLAN.md 2.4).
      await insertProgramRow(orm.em, {
        credit_limit: '100',
        reserved_amount: '900',
      });

      const loaded = await load('prog-northwind');

      expectSameMoney(loaded!.available, usd(-800n));
      expect(loaded!.overUtilized).toBe(true);
    });
  });

  describe('creating one', () => {
    it('refuses a second program under an identifier that is already taken', async () => {
      await store(aProgram({ id: 'prog-northwind' }));

      await expect(
        store(aProgram({ id: 'prog-northwind', ownerOrgId: 'org-other' })),
      ).rejects.toThrow(UniqueConstraintViolationException);
    });

    it('reports the clash at flush time rather than when the aggregate is created', async () => {
      // docs/PLAN.md 2.6: a unique violation surfaces at `flush()`, which is what
      // the HTTP layer maps to 409. `add` itself schedules and promises nothing.
      await store(aProgram({ id: 'prog-northwind' }));

      const em = orm.em.fork();

      expect(() =>
        new MikroOrmProgramRepository(em).add(
          aProgram({ id: 'prog-northwind' }),
        ),
      ).not.toThrow();
      await expect(em.flush()).rejects.toThrow(
        UniqueConstraintViolationException,
      );
    });
  });

  describe('reading a program for a capacity change', () => {
    it('refuses to hand one over outside a transaction, where a row lock would be released at once', async () => {
      const em = orm.em.fork();
      const locking = async (): Promise<Program | null> =>
        new MikroOrmProgramRepository(em).findForCapacityChange(
          'prog-northwind',
        );

      await expect(locking()).rejects.toThrow(/transaction/i);
    });

    it('hands over the program inside a transaction', async () => {
      const program = aProgram();

      await store(program);

      const em = orm.em.fork();
      const locked = await em.transactional((tx) =>
        new MikroOrmProgramRepository(tx).findForCapacityChange(program.id),
      );

      expectSameProgram(locked!, program);
    });

    it('locks nothing and reports nothing for a program that does not exist', async () => {
      const em = orm.em.fork();

      await expect(
        em.transactional((tx) =>
          new MikroOrmProgramRepository(tx).findForCapacityChange('prog-ghost'),
        ),
      ).resolves.toBeNull();
    });
  });

  describe('the reconciliation watermark', () => {
    it('reports a program that has never been reconciled as nothing, not as sequence zero', async () => {
      await store(aProgram());

      const watermark = await new MikroOrmProgramRepository(
        orm.em.fork(),
      ).findWatermark('prog-northwind');

      expect(watermark).toEqual({
        appliedSequence: null,
        reconciledAt: null,
      });
    });

    it('reads back the sequence and asOf the last snapshot left', async () => {
      const reconciledAt = new Date('2026-05-01T12:00:00.000Z');

      await insertProgramRow(orm.em, {
        last_snapshot_sequence: '7',
        last_reconciled_at: reconciledAt,
      });

      const watermark = await new MikroOrmProgramRepository(
        orm.em.fork(),
      ).findWatermark('prog-northwind');

      expect(watermark?.appliedSequence).toBe(7n);
      expect(watermark?.reconciledAt?.toISOString()).toBe(
        reconciledAt.toISOString(),
      );
    });

    it('answers a watermark question for a program whose amounts are corrupt, because staleness is decidable without them', async () => {
      // The partial select the repository documents: the watermark is what tells
      // cycle 8 whether a snapshot is stale, and answering that for a program
      // that cannot be hydrated is more useful than failing the message.
      await insertProgramRow(orm.em, {
        currency: 'XXX',
        last_snapshot_sequence: '3',
        last_reconciled_at: new Date('2026-05-01T12:00:00.000Z'),
      });

      const watermark = await new MikroOrmProgramRepository(
        orm.em.fork(),
      ).findWatermark('prog-northwind');

      expect(watermark?.appliedSequence).toBe(3n);
    });

    it('reports nothing for a program that does not exist', async () => {
      await expect(
        new MikroOrmProgramRepository(orm.em.fork()).findWatermark(
          'prog-ghost',
        ),
      ).resolves.toBeNull();
    });

    it('moves forward with the snapshot that was applied', async () => {
      const program = aProgram();

      await store(program);

      const asOf = new Date('2026-06-01T08:00:00.000Z');
      const em = orm.em.fork();

      await em.transactional(async (tx) => {
        const repository = new MikroOrmProgramRepository(tx);

        await repository.findForCapacityChange(program.id);
        repository.advanceWatermark(program.id, {
          appliedSequence: 12n,
          reconciledAt: asOf,
        });
      });

      const watermark = await new MikroOrmProgramRepository(
        orm.em.fork(),
      ).findWatermark(program.id);

      expect(watermark?.appliedSequence).toBe(12n);
      expect(watermark?.reconciledAt?.toISOString()).toBe(asOf.toISOString());
    });

    it('refuses to move backwards, because an older snapshot arriving late is stale rather than news', async () => {
      const program = aProgram();

      await store(program);

      const em = orm.em.fork();

      await em.transactional(async (tx) => {
        const repository = new MikroOrmProgramRepository(tx);

        await repository.findForCapacityChange(program.id);
        repository.advanceWatermark(program.id, {
          appliedSequence: 12n,
          reconciledAt: new Date('2026-06-01T08:00:00.000Z'),
        });
      });

      const later = orm.em.fork();

      await expect(
        later.transactional(async (tx) => {
          const repository = new MikroOrmProgramRepository(tx);

          await repository.findForCapacityChange(program.id);
          repository.advanceWatermark(program.id, {
            appliedSequence: 11n,
            reconciledAt: new Date('2026-05-01T08:00:00.000Z'),
          });
        }),
      ).rejects.toThrow();
    });

    it('refuses to stage a move for a program this context has not read', async () => {
      // The precondition the adapter documents and the port does not: the move is
      // staged on the tracked aggregate so that it joins the transaction's single
      // flush, which means the program has to have been read for a capacity change
      // in this very transaction. A caller that skipped the read would otherwise
      // believe it had recorded a snapshot as applied while nothing was written —
      // and the next snapshot would be judged against a watermark that never moved,
      // so the same work would be redone for ever with no error to explain it.
      //
      // Pinned here because the port's documentation is silent about it, and the
      // implementer's choice is either to document it or to remove the precondition.
      // Either way the behaviour must not change by accident.
      await store(aProgram());

      const em = orm.em.fork();

      await expect(
        em.transactional((tx) => {
          new MikroOrmProgramRepository(tx).advanceWatermark('prog-northwind', {
            appliedSequence: 3n,
            reconciledAt: new Date('2026-06-01T08:00:00.000Z'),
          });
        }),
      ).rejects.toThrow(/not loaded in this context/);
    });

    it('refuses a sequence with no instant, because a program cannot be reconciled at no time', async () => {
      // The other half of the same precondition, and the one that is not enforced.
      // `last_reconciled_at` is what `GET /capacity` reports (docs/PLAN.md 2.7), so
      // a row carrying sequence 9 and a null instant answers "reconciled, at no
      // time" — a state nothing can produce honestly and nothing downstream can
      // render. The pair means one thing: the `asOf` of the snapshot that
      // `appliedSequence` names, which every snapshot carries (docs/PLAN.md 2.2).
      //
      // The adapter already refuses the mirror image — a null sequence with the
      // reason "'never reconciled' is the absence of a watermark, not a value to
      // move to" — and the same sentence applies to the instant.
      const program = aProgram();

      await store(program);

      const em = orm.em.fork();

      await expect(
        em.transactional(async (tx) => {
          const repository = new MikroOrmProgramRepository(tx);

          await repository.findForCapacityChange(program.id);
          repository.advanceWatermark(program.id, {
            appliedSequence: 9n,
            reconciledAt: null,
          });
        }),
      ).rejects.toThrow();

      const watermark = await new MikroOrmProgramRepository(
        orm.em.fork(),
      ).findWatermark(program.id);

      // And nothing was stored, so the refusal is a refusal rather than a warning.
      expect(watermark?.appliedSequence).toBeNull();
      expect(watermark?.reconciledAt).toBeNull();
    });

    it('reads back a sequence past 2^53 exactly, so a snapshot cannot be stale for ever', async () => {
      // `last_snapshot_sequence` is a `BIGINT` so that a producer's 64-bit counter
      // fits it, and the mapping bridges it to the domain's `number` with
      // `BigIntType('number')` — which stops being exact at 2^53. The consequence is
      // not a rounding nicety: cycle 8 decides staleness by comparing an incoming
      // `sequence` against this figure, so a snapshot at 9,007,199,254,740,993 read
      // back as ...992 is judged **newer than itself** on the first comparison and
      // then, once applied, every later snapshot at that sequence is judged stale.
      // The program stops reconciling and nothing says why.
      //
      // The assertion is on the decimal spelling rather than on a numeric literal,
      // because the exact value cannot be written as a JS number at all — which is
      // the defect, stated as an assertion. Resolved by widening `appliedSequence`
      // to `bigint` and mapping the column with `BigIntType('bigint')`: the
      // alternative was for the adapter to refuse a figure it cannot state exactly,
      // which would have cost `findWatermark` the property the tests above pin —
      // that it keeps answering for a program something else cannot read.
      await insertProgramRow(orm.em, {
        last_snapshot_sequence: '9007199254740993',
        last_reconciled_at: new Date('2026-05-01T12:00:00.000Z'),
      });

      const watermark = await new MikroOrmProgramRepository(
        orm.em.fork(),
      ).findWatermark('prog-northwind');

      expect(String(watermark?.appliedSequence)).toBe('9007199254740993');
    });

    it('is written in the same transaction as the changes it accounts for', async () => {
      // docs/PLAN.md 2.1: a program that reports sequence 7 as applied has also
      // stored every change sequence 7 asked for. A rolled-back transaction
      // therefore leaves the watermark where it was.
      const program = aProgram();

      await store(program);

      const em = orm.em.fork();

      await expect(
        em.transactional(async (tx) => {
          const repository = new MikroOrmProgramRepository(tx);

          await repository.findForCapacityChange(program.id);
          repository.advanceWatermark(program.id, {
            appliedSequence: 4n,
            reconciledAt: new Date('2026-06-01T08:00:00.000Z'),
          });

          throw new Error('the snapshot could not be applied');
        }),
      ).rejects.toThrow('the snapshot could not be applied');

      const watermark = await new MikroOrmProgramRepository(
        orm.em.fork(),
      ).findWatermark(program.id);

      expect(watermark?.appliedSequence).toBeNull();
    });
  });

  describe('a tracked program', () => {
    it('writes a limit change through the unit of work, with no save call to forget', async () => {
      // The port has no `save` on purpose: the aggregate mutates in place and the
      // flush at the end of the transaction writes what changed.
      const program = aProgram({ creditLimit: usd(1_000_000_000n) });

      await store(program);

      const em = orm.em.fork();

      await em.transactional(async (tx) => {
        const locked = await new MikroOrmProgramRepository(
          tx,
        ).findForCapacityChange(program.id);
        const change = locked!.changeCreditLimit(
          usd(2_000_000_000n),
          anAuditContext(),
        );

        new MikroOrmCapacityEventLog(tx).append(change.event!);
      });

      const loaded = await load(program.id);

      expectSameMoney(
        loaded!.creditLimit,
        Money.fromMinorUnits(2_000_000_000n, 'USD'),
      );
    });
  });
});

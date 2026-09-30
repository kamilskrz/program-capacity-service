import { type EntityManager } from '@mikro-orm/postgresql';

import { CapacityQueryService } from './capacity-query.service';
import { unconverted } from './testing/factories';
import { Money } from '../domain/money';
import { Program } from '../domain/program';
import { Reservation } from '../domain/reservation';
import { type StoredProgram } from '../infrastructure/persistence/program.mapping';

// A fake at the `EntityManager` seam the concrete Mikro repositories read
// through, the same one-layer-down pattern `program-ownership.guard.spec.ts`
// uses (docs/PLAN.md 2.6, 2.7). `findOne`/`find` return whatever a test
// seeds, ignoring the query — the repositories' own filtering/ordering/cursor
// logic is real and already covered by their own specs; this file only pins
// what `CapacityQueryService` does with what they hand back.
function createEntityManager(overrides: {
  findOne?: jest.Mock;
  find?: jest.Mock;
}): EntityManager {
  return {
    isInTransaction: () => false,
    findOne: overrides.findOne ?? jest.fn().mockResolvedValue(null),
    find: overrides.find ?? jest.fn().mockResolvedValue([]),
  } as unknown as EntityManager;
}

/** A program row as MikroORM would hand it back: watermark columns bolted onto the aggregate. */
function withWatermark(
  program: Program,
  watermark: { appliedSequence: bigint | null; reconciledAt: Date | null },
): StoredProgram {
  return Object.assign(program as unknown as StoredProgram, {
    lastSnapshotSequence: watermark.appliedSequence,
    lastReconciledAt: watermark.reconciledAt,
  });
}

describe('CapacityQueryService', () => {
  describe('getCapacity', () => {
    it('returns null for an unknown program', async () => {
      const service = new CapacityQueryService(
        createEntityManager({ findOne: jest.fn().mockResolvedValue(null) }),
      );

      await expect(service.getCapacity('prog-unknown')).resolves.toBeNull();
    });

    it('returns limit/reserved/available/currency/overUtilized/lastReconciledAt for a known, over-utilised program', async () => {
      const program = Program.rehydrate({
        id: 'prog-northwind',
        ownerOrgId: 'org-northwind',
        currency: 'USD',
        creditLimit: Money.fromDecimalString('100.00', 'USD'),
        reserved: Money.fromDecimalString('150.00', 'USD'),
      });
      const row = withWatermark(program, {
        appliedSequence: 42n,
        reconciledAt: new Date('2026-01-10T00:00:00.000Z'),
      });
      const service = new CapacityQueryService(
        createEntityManager({ findOne: jest.fn().mockResolvedValue(row) }),
      );

      const snapshot = await service.getCapacity('prog-northwind');

      expect(snapshot).toEqual({
        limit: '100.00',
        reserved: '150.00',
        available: '-50.00',
        currency: 'USD',
        overUtilized: true,
        lastReconciledAt: new Date('2026-01-10T00:00:00.000Z'),
      });
    });

    it('reports lastReconciledAt as null for a program never reconciled', async () => {
      const program = Program.create({
        id: 'prog-northwind',
        ownerOrgId: 'org-northwind',
        currency: 'USD',
        creditLimit: Money.fromDecimalString('100.00', 'USD'),
      });
      const row = withWatermark(program, {
        appliedSequence: null,
        reconciledAt: null,
      });
      const service = new CapacityQueryService(
        createEntityManager({ findOne: jest.fn().mockResolvedValue(row) }),
      );

      const snapshot = await service.getCapacity('prog-northwind');

      expect(snapshot?.lastReconciledAt).toBeNull();
      expect(snapshot?.overUtilized).toBe(false);
    });
  });

  describe('listReservations', () => {
    it('passes limit/status through to the repository and shapes the page', async () => {
      const earlier = Reservation.open({
        programId: 'prog-northwind',
        invoiceId: 'inv-a',
        amount: unconverted(Money.fromDecimalString('100.00', 'USD')),
        reservedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const later = Reservation.open({
        programId: 'prog-northwind',
        invoiceId: 'inv-b',
        amount: unconverted(Money.fromDecimalString('200.00', 'USD')),
        reservedAt: new Date('2026-01-02T00:00:00.000Z'),
      });
      const find = jest.fn().mockResolvedValue([earlier, later]);
      const service = new CapacityQueryService(createEntityManager({ find }));

      const page = await service.listReservations('prog-northwind', {
        limit: 1,
        status: 'ACTIVE',
      });

      expect(page.reservations).toHaveLength(1);
      expect(page.reservations[0]?.invoiceId).toBe('inv-a');
      expect(page.nextCursor).not.toBeNull();

      const [, where, options] = find.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
        Record<string, unknown>,
      ];

      expect(JSON.stringify(where)).toContain('ACTIVE');
      expect(options['limit']).toBe(2);
    });

    it('returns nextCursor null when the page holds everything there is', async () => {
      const only = Reservation.open({
        programId: 'prog-northwind',
        invoiceId: 'inv-a',
        amount: unconverted(Money.fromDecimalString('100.00', 'USD')),
        reservedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const service = new CapacityQueryService(
        createEntityManager({ find: jest.fn().mockResolvedValue([only]) }),
      );

      const page = await service.listReservations('prog-northwind', {
        limit: 10,
      });

      expect(page.reservations).toHaveLength(1);
      expect(page.nextCursor).toBeNull();
    });
  });

  describe('listEvents', () => {
    function anEventRow(id: bigint) {
      return {
        id,
        type: 'RESERVED' as const,
        programId: 'prog-northwind',
        invoiceId: 'inv-a',
        // Raw as the database hands it back: a bigint, not yet a `Money`
        // (`capacity_events` has no aggregate/subscriber to do that for it).
        delta: 10_000n,
        resultingReserved: 10_000n,
        currency: 'USD',
        actor: 'user-42',
        source: 'API' as const,
        correlationId: 'corr-1',
        occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        recordedAt: new Date('2026-01-01T00:00:00.100Z'),
        metadata: {},
      };
    }

    it('passes limit/after through to the log and shapes the page', async () => {
      const find = jest
        .fn()
        .mockResolvedValue([anEventRow(100n), anEventRow(101n)]);
      const service = new CapacityQueryService(createEntityManager({ find }));

      const page = await service.listEvents('prog-northwind', {
        limit: 1,
        after: 50n,
      });

      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]?.id).toBe(100n);
      expect(page.entries[0]?.event.delta.toDecimalString()).toBe('100.00');
      expect(page.nextCursor).toBe(100n);

      const [, where, options] = find.mock.calls[0] as [
        unknown,
        { id?: { $gt?: bigint } },
        Record<string, unknown>,
      ];

      // `where` carries a raw bigint (`id.$gt`), which JSON.stringify cannot
      // serialize at all — asserted on the value directly rather than through
      // a string, which would throw regardless of what the cursor was.
      expect(where.id?.$gt).toBe(50n);
      expect(options['limit']).toBe(2);
    });

    it('round-trips a cursor past Number.MAX_SAFE_INTEGER without losing precision', async () => {
      const bigId = 9_007_199_254_740_993n;
      const find = jest
        .fn()
        .mockResolvedValue([anEventRow(bigId), anEventRow(bigId + 1n)]);
      const service = new CapacityQueryService(createEntityManager({ find }));

      const page = await service.listEvents('prog-northwind', { limit: 1 });

      expect(page.nextCursor).toBe(bigId);
      expect(page.nextCursor?.toString()).toBe('9007199254740993');
    });
  });
});

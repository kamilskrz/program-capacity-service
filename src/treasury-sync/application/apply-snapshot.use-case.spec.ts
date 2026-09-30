import { ApplySnapshotUseCase } from './apply-snapshot.use-case';
import { SnapshotRejectedError, UnknownProgramError } from './errors';
import { anInvoiceMessage, aSnapshotMessage } from './testing/factories';
import { InMemoryTreasuryTransactionRunner } from './testing/in-memory-treasury-repositories';
import {
  aProgram,
  aReservation,
  anAuditContext,
  unconverted,
} from '../../capacity/application/testing/factories';
import { Money } from '../../capacity/domain/money';

// Pins the ten-step algorithm of docs/PLAN.md 2.2.
describe('ApplySnapshotUseCase', () => {
  function setUp() {
    const runner = new InMemoryTreasuryTransactionRunner();
    const useCase = new ApplySnapshotUseCase(runner);

    return { runner, useCase };
  }

  // Step 1.
  it('fails with the transport-facing error for an unknown program, persisting nothing', async () => {
    const { runner, useCase } = setUp();
    const message = aSnapshotMessage(aProgram({ id: 'prog-ghost' }));

    await expect(useCase.execute(message)).rejects.toThrow(UnknownProgramError);
    expect(runner.discrepancies.all()).toHaveLength(0);
    expect(runner.capacity.events.appended).toHaveLength(0);
  });

  // Steps 2/3: the watermark and the open discrepancies are read before
  // `reconcileProgram` decides anything — a stale sequence can only be
  // recognised as stale if the watermark was already in hand.
  it('reads the watermark before deciding the plan, so a sequence at or behind it is recognised as stale', async () => {
    const { runner, useCase } = setUp();
    const program = aProgram();

    runner.capacity.programs.seed(program);
    runner.capacity.programs.seedWatermark(program.id, {
      appliedSequence: 5n,
      reconciledAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    const message = aSnapshotMessage(program, { sequence: 5 });

    await expect(useCase.execute(message)).rejects.toThrow(
      SnapshotRejectedError,
    );
  });

  // Steps 4/5: a REJECT outcome throws the rejection, and nothing is
  // persisted — no events, no discrepancy diffing.
  it('throws SnapshotRejectedError for a stale sequence and persists nothing', async () => {
    const { runner, useCase } = setUp();
    const program = aProgram();

    runner.capacity.programs.seed(program);
    runner.capacity.programs.seedWatermark(program.id, {
      appliedSequence: 10n,
      reconciledAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    const message = aSnapshotMessage(program, { sequence: 3 });

    await expect(useCase.execute(message)).rejects.toThrow(
      SnapshotRejectedError,
    );
    expect(runner.capacity.events.appended).toHaveLength(0);
    expect(runner.discrepancies.all()).toHaveLength(0);
  });

  // Step 6: an APPLY outcome touching every step kind at least once.
  it('applies a release, a correction, a creation and a limit change, each through the matching Program method, attributed to treasury:kafka', async () => {
    const { runner, useCase } = setUp();
    const program = aProgram({
      creditLimit: Money.fromMinorUnits(5_000_000_000n, 'USD'),
    });
    const toRelease = aReservation(
      program,
      'inv-release',
      unconverted(Money.fromMinorUnits(1_000_000n, 'USD')),
    );
    const toCorrect = aReservation(
      program,
      'inv-correct',
      unconverted(Money.fromMinorUnits(2_000_000n, 'USD')),
    );

    runner.capacity.programs.seed(program);
    runner.capacity.reservations.seed(toRelease);
    runner.capacity.reservations.seed(toCorrect);

    const message = aSnapshotMessage(program, {
      creditLimit: '60000.00',
      invoices: [
        anInvoiceMessage({ invoiceId: 'inv-release', status: 'REPAID' }),
        anInvoiceMessage({ invoiceId: 'inv-correct', amount: '25000.00' }),
        anInvoiceMessage({ invoiceId: 'inv-new', amount: '5000.00' }),
      ],
    });

    const result = await useCase.execute(message);

    expect(result.verdict).toBe('APPLY');

    const events = runner.capacity.events.appended;

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.source === 'TREASURY_SNAPSHOT')).toBe(
      true,
    );
    expect(events.every((event) => event.actor === 'treasury:kafka')).toBe(
      true,
    );
    expect(events.some((event) => event.type === 'RELEASED')).toBe(true);
    expect(
      events.some((event) => event.type === 'RECONCILIATION_ADJUSTMENT'),
    ).toBe(true);
    expect(events.some((event) => event.type === 'RESERVED')).toBe(true);
    expect(events.some((event) => event.type === 'LIMIT_CHANGED')).toBe(true);
  });

  // Step 7: the three discrepancy-diffing cases in one snapshot.
  it('upserts a new discrepancy with cleared:false, leaves a still-open one silent, and resolves a vanished one with cleared:true', async () => {
    const { runner, useCase } = setUp();
    const program = aProgram();
    const old = anAuditContext({
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const stillHeld = aReservation(
      program,
      'inv-still-held',
      unconverted(Money.fromMinorUnits(1_000_000n, 'USD')),
      old,
    );
    const newlyForgotten = aReservation(
      program,
      'inv-newly-forgotten',
      unconverted(Money.fromMinorUnits(2_000_000n, 'USD')),
      old,
    );

    runner.capacity.programs.seed(program);
    runner.capacity.reservations.seed(stillHeld);
    runner.capacity.reservations.seed(newlyForgotten);

    // Already open before this snapshot, same key as `stillHeld` — must stay
    // open with no fresh event.
    runner.discrepancies.seed({
      programId: program.id,
      invoiceId: 'inv-still-held',
      reason: 'HELD_BUT_NOT_REPORTED',
      detail: 'previously flagged',
      held: Money.fromMinorUnits(1_000_000n, 'USD'),
      localStatus: 'ACTIVE',
      reported: null,
      reportedStatus: null,
      firstSeen: new Date('2026-02-01T00:00:00.000Z'),
      lastSeen: new Date('2026-02-01T00:00:00.000Z'),
      resolvedAt: null,
    });
    // Open before, but nothing in this snapshot still explains it — resolved.
    runner.discrepancies.seed({
      programId: program.id,
      invoiceId: 'inv-vanished',
      reason: 'HELD_BUT_NOT_REPORTED',
      detail: 'no longer forgotten',
      held: Money.fromMinorUnits(3_000_000n, 'USD'),
      localStatus: 'ACTIVE',
      reported: null,
      reportedStatus: null,
      firstSeen: new Date('2026-02-01T00:00:00.000Z'),
      lastSeen: new Date('2026-02-01T00:00:00.000Z'),
      resolvedAt: null,
    });

    // Silent about every held invoice, well past the clock-skew cutoff.
    const message = aSnapshotMessage(program, {
      asOf: '2026-09-01T00:00:00.000Z',
      invoices: [],
    });

    await useCase.execute(message);

    const open = runner.discrepancies
      .all()
      .filter((row) => row.resolvedAt === null);
    const flagged = runner.capacity.events.appended.filter(
      (event) => event.type === 'DISCREPANCY_FLAGGED',
    );

    expect(open.map((row) => row.invoiceId).sort()).toEqual([
      'inv-newly-forgotten',
      'inv-still-held',
    ]);
    expect(
      flagged.some(
        (event) =>
          event.metadata.cleared === false &&
          event.invoiceId === 'inv-newly-forgotten',
      ),
    ).toBe(true);
    expect(
      flagged.some(
        (event) =>
          event.metadata.cleared === true && event.invoiceId === 'inv-vanished',
      ),
    ).toBe(true);
    expect(flagged.some((event) => event.invoiceId === 'inv-still-held')).toBe(
      false,
    );
  });

  // Step 8: RECONCILIATION_APPLIED is always appended, even with no steps.
  it('appends a RECONCILIATION_APPLIED event even when the plan has no steps', async () => {
    const { runner, useCase } = setUp();
    const program = aProgram();

    runner.capacity.programs.seed(program);

    const message = aSnapshotMessage(program, { invoices: [] });

    await useCase.execute(message);

    const applied = runner.capacity.events.appended.find(
      (event) => event.type === 'RECONCILIATION_APPLIED',
    );

    expect(applied).toBeDefined();
    expect(applied?.invoiceId).toBeNull();
    expect(applied?.delta.isZero()).toBe(true);
    expect(applied?.metadata.snapshotSequence).toBe(message.sequence);
  });

  // Step 9: the watermark advances, sequence widened to bigint.
  it('advances the watermark to the message sequence and the snapshot asOf', async () => {
    const { runner, useCase } = setUp();
    const program = aProgram();

    runner.capacity.programs.seed(program);

    const message = aSnapshotMessage(program, { sequence: 7, invoices: [] });

    await useCase.execute(message);

    const watermark = await runner.capacity.programs.findWatermark(program.id);

    expect(watermark?.appliedSequence).toBe(7n);
    expect(watermark?.reconciledAt?.toISOString()).toBe(message.asOf);
  });

  // Step 10: one transaction — a failure partway through leaves nothing
  // observable, proven through the reservation repository's stage-then-flush
  // fake, the one place a partial write would otherwise be visible.
  it('leaves nothing persisted if adding a new hold fails partway through', async () => {
    const { runner, useCase } = setUp();
    const program = aProgram();

    runner.capacity.programs.seed(program);
    runner.capacity.reservations.forceUniqueViolationOnNextAdd();

    const message = aSnapshotMessage(program, {
      invoices: [anInvoiceMessage({ invoiceId: 'inv-new', amount: '5000.00' })],
    });

    await expect(useCase.execute(message)).rejects.toThrow();
    expect(runner.capacity.events.appended).toHaveLength(0);
  });
});

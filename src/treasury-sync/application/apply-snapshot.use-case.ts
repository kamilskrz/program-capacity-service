import { Inject, Injectable } from '@nestjs/common';

import { SnapshotRejectedError, UnknownProgramError } from './errors';
import {
  TREASURY_TRANSACTION_RUNNER,
  type TreasuryTransactionRunner,
} from './ports/treasury-transaction-runner';
import {
  type CapacityChangeContext,
  type CapacityEvent,
  type CapacityEventMetadata,
  type CapacityEventType,
} from '../../capacity/domain/capacity-event';
import { Money } from '../../capacity/domain/money';
import { type Program } from '../../capacity/domain/program';
import { toTreasurySnapshot } from '../infrastructure/messages/treasury-message-mapper';
import { type ProgramSnapshotMessage } from '../infrastructure/messages/program-snapshot.message';
import {
  reconcileProgram,
  type Discrepancy,
  type ReconciliationOutcome,
} from '../domain/reconcile-program';

/** `${invoiceId}\0${reason}` — matches a discrepancy row across the open set and this plan's set. */
function discrepancyKey(invoiceId: string, reason: string): string {
  return `${invoiceId}\u0000${reason}`;
}

/**
 * `RECONCILIATION_APPLIED`/`DISCREPANCY_FLAGGED` are not produced by any
 * `Program` method (capacity-event.ts's docblock), so this use case builds
 * them by hand — always with a zero delta, since neither is a capacity
 * change.
 */
function buildEvent(
  program: Program,
  context: CapacityChangeContext,
  fields: {
    readonly type: CapacityEventType;
    readonly invoiceId: string | null;
    readonly metadata: CapacityEventMetadata;
  },
): CapacityEvent {
  return {
    type: fields.type,
    programId: program.id,
    invoiceId: fields.invoiceId,
    delta: Money.zero(program.currency),
    resultingReserved: program.reserved,
    actor: context.actor,
    source: context.source,
    correlationId: context.correlationId,
    occurredAt: new Date(context.occurredAt.getTime()),
    metadata: fields.metadata,
  };
}

/**
 * Applies one `ProgramSnapshot` message: the ten-step algorithm of
 * docs/PLAN.md 2.2 (lock, read the watermark and open discrepancies, decide
 * through `reconcileProgram`, apply or reject, diff discrepancies, always
 * record `RECONCILIATION_APPLIED`, advance the watermark, commit).
 */
@Injectable()
export class ApplySnapshotUseCase {
  constructor(
    @Inject(TREASURY_TRANSACTION_RUNNER)
    private readonly runner: TreasuryTransactionRunner,
  ) {}

  execute(message: ProgramSnapshotMessage): Promise<ReconciliationOutcome> {
    return this.runner.run(async (repos) => {
      const program = await repos.programs.findForCapacityChange(
        message.programId,
      );

      if (program === null) {
        throw new UnknownProgramError(message.programId);
      }

      const watermark = await repos.programs.findWatermark(message.programId);
      const reportedInvoiceIds = message.invoices.map(
        (invoice) => invoice.invoiceId,
      );
      const reservations = await repos.reservations.findForReconciliation(
        message.programId,
        reportedInvoiceIds,
      );
      const openDiscrepancies = await repos.discrepancies.findOpenByProgram(
        message.programId,
      );

      const snapshot = toTreasurySnapshot(message);
      const appliedSequence =
        watermark?.appliedSequence === null ||
        watermark?.appliedSequence === undefined
          ? null
          : Number(watermark.appliedSequence);

      const outcome = reconcileProgram({
        program,
        reservations,
        snapshot,
        appliedSequence,
      });

      if (outcome.verdict === 'REJECT') {
        throw new SnapshotRejectedError(outcome);
      }

      const plan = outcome;
      const context: CapacityChangeContext = {
        actor: 'treasury:kafka',
        source: 'TREASURY_SNAPSHOT',
        correlationId: null,
        occurredAt: plan.reconciledAt,
      };

      for (const step of plan.steps) {
        switch (step.action) {
          case 'RELEASE': {
            const change = program.release(
              step.reservation,
              step.reason,
              context,
            );

            if (change.event !== null) {
              repos.events.append(change.event);
            }

            break;
          }
          case 'CORRECT': {
            const change = program.correctReservation(
              step.reservation,
              step.correctedAmount,
              context,
            );

            if (change.event !== null) {
              repos.events.append(change.event);
            }

            break;
          }
          case 'CREATE': {
            const change = program.recordTreasuryHold(
              { invoiceId: step.invoiceId, amount: step.amount },
              null,
              context,
            );

            repos.reservations.add(change.reservation);

            if (change.event !== null) {
              repos.events.append(change.event);
            }

            break;
          }
          case 'CHANGE_LIMIT': {
            const change = program.changeCreditLimit(step.creditLimit, context);

            if (change.event !== null) {
              repos.events.append(change.event);
            }

            break;
          }
        }
      }

      const openKeys = new Set(
        openDiscrepancies.map((row) =>
          discrepancyKey(row.invoiceId, row.reason),
        ),
      );
      const planKeys = new Set(
        plan.discrepancies.map((row) =>
          discrepancyKey(row.invoiceId, row.reason),
        ),
      );

      for (const discrepancy of plan.discrepancies) {
        await repos.discrepancies.upsert({
          ...discrepancy,
          programId: message.programId,
          currency: program.currency,
          seenAt: plan.reconciledAt,
        });

        const key = discrepancyKey(discrepancy.invoiceId, discrepancy.reason);

        if (!openKeys.has(key)) {
          repos.events.append(
            buildEvent(program, context, {
              type: 'DISCREPANCY_FLAGGED',
              invoiceId: discrepancy.invoiceId,
              metadata: {
                discrepancyReason: discrepancy.reason,
                cleared: false,
              },
            }),
          );
        }
      }

      for (const open of openDiscrepancies) {
        const key = discrepancyKey(open.invoiceId, open.reason);

        if (!planKeys.has(key)) {
          await repos.discrepancies.resolve(
            message.programId,
            open.invoiceId,
            open.reason,
            plan.reconciledAt,
          );

          const discrepancy: Discrepancy = open;

          repos.events.append(
            buildEvent(program, context, {
              type: 'DISCREPANCY_FLAGGED',
              invoiceId: discrepancy.invoiceId,
              metadata: {
                discrepancyReason: discrepancy.reason,
                cleared: true,
              },
            }),
          );
        }
      }

      repos.events.append(
        buildEvent(program, context, {
          type: 'RECONCILIATION_APPLIED',
          invoiceId: null,
          metadata: { snapshotSequence: message.sequence },
        }),
      );

      repos.programs.advanceWatermark(message.programId, {
        appliedSequence: BigInt(plan.appliedSequence),
        reconciledAt: plan.reconciledAt,
      });

      return outcome;
    });
  }
}

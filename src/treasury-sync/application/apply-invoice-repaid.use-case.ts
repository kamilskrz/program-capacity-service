import { Inject, Injectable } from '@nestjs/common';

import { UnknownProgramError } from './errors';
import { CLOCK, type Clock } from '../../capacity/application/ports/clock';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../capacity/application/ports/transaction-runner';
import { type CapacityChangeContext } from '../../capacity/domain/capacity-event';
import { type ReservationChange } from '../../capacity/domain/program';
import { type InvoiceRepaidMessage } from '../infrastructure/messages/invoice-repaid.message';

/**
 * `RELEASED`: a reservation was found and released (a repeat delivery is a
 * no-op inside `Program.release`, not an error here). `UNKNOWN_INVOICE`: not
 * an error (docs/PLAN.md 2.2) — the domain has no "release nothing" case, so
 * a repayment reported for an invoice this service holds no reservation for
 * is logged and the message is treated as handled; only the next snapshot's
 * reconciliation can actually resolve it.
 */
export type ApplyInvoiceRepaidResult =
  | { readonly status: 'RELEASED'; readonly change: ReservationChange }
  | { readonly status: 'UNKNOWN_INVOICE' };

/**
 * Applies one `InvoiceRepaid` message (docs/PLAN.md 2.2): lock the program,
 * look up the one reservation, call `Program.release`, persist, commit.
 */
@Injectable()
export class ApplyInvoiceRepaidUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  execute(message: InvoiceRepaidMessage): Promise<ApplyInvoiceRepaidResult> {
    return this.runner.run(async (repos) => {
      const program = await repos.programs.findForCapacityChange(
        message.programId,
      );

      if (program === null) {
        throw new UnknownProgramError(message.programId);
      }

      const reservation = await repos.reservations.findForInvoice(
        message.programId,
        message.invoiceId,
      );

      if (reservation === null) {
        return { status: 'UNKNOWN_INVOICE' };
      }

      const context: CapacityChangeContext = {
        actor: 'treasury:kafka',
        source: 'TREASURY_EVENT',
        correlationId: null,
        occurredAt: this.clock.now(),
      };

      const change = program.release(reservation, 'REPAID', context);

      if (change.event !== null) {
        repos.events.append(change.event);
      }

      return { status: 'RELEASED', change };
    });
  }
}

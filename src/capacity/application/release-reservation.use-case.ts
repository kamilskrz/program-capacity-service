import { Inject, Injectable } from '@nestjs/common';

import { ProgramNotFoundError, ReservationNotFoundError } from './errors';
import { CLOCK, type Clock } from './ports/clock';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from './ports/transaction-runner';
import { type Reservation, type ReleaseReason } from '../domain/reservation';

/** What a release request states (docs/PLAN.md 2.4). */
export interface ReleaseReservationCommand {
  readonly programId: string;
  readonly invoiceId: string;
  readonly reason: ReleaseReason;
  readonly actor: string;
  readonly correlationId: string | null;
}

/** Returned whether or not this call is the one that actually released it (docs/PLAN.md 2.5). */
export interface ReleaseReservationResult {
  readonly reservation: Reservation;
}

/**
 * Orchestrates one release request: acquire the program lock, load the
 * reservation, call `Program.release`, persist what it returns (docs/PLAN.md
 * 2.4). A repeated release is a no-op in the domain, not an error here.
 */
@Injectable()
export class ReleaseReservationUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    command: ReleaseReservationCommand,
  ): Promise<ReleaseReservationResult> {
    return this.runner.run(async (repos) => {
      const program = await repos.programs.findForCapacityChange(
        command.programId,
      );

      if (program === null) {
        throw new ProgramNotFoundError(command.programId);
      }

      const reservation = await repos.reservations.findForInvoice(
        command.programId,
        command.invoiceId,
      );

      if (reservation === null) {
        throw new ReservationNotFoundError(
          command.programId,
          command.invoiceId,
        );
      }

      const context = {
        actor: command.actor,
        source: 'API' as const,
        correlationId: command.correlationId,
        occurredAt: this.clock.now(),
      };

      const change = program.release(reservation, command.reason, context);

      if (change.event !== null) {
        repos.events.append(change.event);
      }

      return { reservation: change.reservation };
    });
  }
}

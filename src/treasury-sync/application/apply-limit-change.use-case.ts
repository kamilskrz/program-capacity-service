import { Inject, Injectable } from '@nestjs/common';

import { UnknownProgramError } from './errors';
import { CLOCK, type Clock } from '../../capacity/application/ports/clock';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../capacity/application/ports/transaction-runner';
import { type CapacityChangeContext } from '../../capacity/domain/capacity-event';
import { Money } from '../../capacity/domain/money';
import { type LimitChange } from '../../capacity/domain/program';
import { type ProgramLimitChangedMessage } from '../infrastructure/messages/program-limit-changed.message';

/**
 * Applies one `ProgramLimitChanged` message (docs/PLAN.md 2.2): lock the
 * program, call `Program.changeCreditLimit`, persist, commit. No
 * reconciliation and no `TreasuryTransactionRunner` — `changeCreditLimit` is
 * already idempotent under redelivery, so this needs no sequence tracking of
 * its own and touches no discrepancy.
 */
@Injectable()
export class ApplyLimitChangeUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  execute(message: ProgramLimitChangedMessage): Promise<LimitChange> {
    return this.runner.run(async (repos) => {
      const program = await repos.programs.findForCapacityChange(
        message.programId,
      );

      if (program === null) {
        throw new UnknownProgramError(message.programId);
      }

      const newLimit = Money.fromDecimalString(
        message.newLimit,
        program.currency,
      );
      const context: CapacityChangeContext = {
        actor: 'treasury:kafka',
        source: 'TREASURY_EVENT',
        correlationId: null,
        occurredAt: this.clock.now(),
      };

      const change = program.changeCreditLimit(newLimit, context);

      if (change.event !== null) {
        repos.events.append(change.event);
      }

      return change;
    });
  }
}

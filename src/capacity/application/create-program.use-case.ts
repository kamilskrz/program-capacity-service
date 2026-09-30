import { Inject, Injectable } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';

import { DuplicateProgramError } from './errors';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from './ports/transaction-runner';
import { type CurrencyCode } from '../domain/currency';
import { Money } from '../domain/money';
import { Program } from '../domain/program';

/** What a create-program request states, before parsing (docs/PLAN.md 2.7). Strings, like every other command. */
export interface CreateProgramCommand {
  readonly id: string;
  readonly ownerOrgId: string;
  readonly currency: string;
  /** Decimal string; `Money.fromDecimalString`/`Program.create` validate it. */
  readonly creditLimit: string;
}

/**
 * `Program.create` plus `repos.programs.add`, through the same
 * `TransactionRunner` the other two use cases share — no clock, no FX, a new
 * program needs neither (docs/PLAN.md 2.7). A taken `id` surfaces at flush as
 * `UniqueConstraintViolationException`; caught around the whole `run(...)`
 * call, same placement as `ReserveInvoiceUseCase`'s backstop, and rethrown as
 * `DuplicateProgramError`.
 */
@Injectable()
export class CreateProgramUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly runner: TransactionRunner,
  ) {}

  async execute(command: CreateProgramCommand): Promise<Program> {
    try {
      return await this.runner.run((repos) => {
        const currency = command.currency as CurrencyCode;
        const program = Program.create({
          id: command.id,
          ownerOrgId: command.ownerOrgId,
          currency,
          creditLimit: Money.fromDecimalString(command.creditLimit, currency),
        });

        repos.programs.add(program);

        return Promise.resolve(program);
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new DuplicateProgramError(command.id);
      }

      throw error;
    }
  }
}

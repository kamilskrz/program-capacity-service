import { Inject, Injectable } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';

import { ProgramNotFoundError } from './errors';
import { CLOCK, type Clock } from './ports/clock';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from './ports/transaction-runner';
import { DuplicateInvoiceError } from '../domain/capacity-errors';
import { type CurrencyCode } from '../domain/currency';
import { Money } from '../domain/money';
import { type Reservation } from '../domain/reservation';
import { convert, type Conversion } from '../../fx/convert';

/** What a reserve request states, before parsing (docs/PLAN.md 2.4). */
export interface ReserveInvoiceCommand {
  readonly programId: string;
  readonly invoiceId: string;
  /** Decimal string, the invoice's own currency. */
  readonly amount: string;
  /** Unvalidated; `Money.fromDecimalString` is what checks it. */
  readonly currency: string;
  readonly actor: string;
  readonly correlationId: string | null;
}

/** `CREATED` is a new hold; `REPLAYED` is an identical retry (docs/PLAN.md 2.5). */
export type ReserveInvoiceResult =
  | { readonly status: 'CREATED'; readonly reservation: Reservation }
  | { readonly status: 'REPLAYED'; readonly reservation: Reservation };

/**
 * Orchestrates one reserve request: acquire the program lock, fetch what
 * `Program.reserve` needs, call it, persist what it returns (docs/PLAN.md 2.4).
 * The decision itself lives in the domain — this class does not decide anything.
 */
@Injectable()
export class ReserveInvoiceUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: ReserveInvoiceCommand): Promise<ReserveInvoiceResult> {
    try {
      return await this.runner.run(async (repos) => {
        const program = await repos.programs.findForCapacityChange(
          command.programId,
        );

        if (program === null) {
          throw new ProgramNotFoundError(command.programId);
        }

        const existing = await repos.reservations.findForInvoice(
          command.programId,
          command.invoiceId,
        );

        const original = Money.fromDecimalString(
          command.amount,
          command.currency as CurrencyCode,
        );

        // A replay is judged on `original` alone (Program.resolveDuplicate never
        // reads `.converted`/`.rate`), so it must not need today's FX quotes —
        // a rate that priced the original reservation can stop being quoted later.
        const conversion: Conversion =
          existing === null
            ? await convert(original, program.currency, repos.rates)
            : {
                original,
                converted: existing.reservedAmount,
                rate: existing.fxRate,
              };

        const context = {
          actor: command.actor,
          source: 'API' as const,
          correlationId: command.correlationId,
          occurredAt: this.clock.now(),
        };

        const change = program.reserve(
          { invoiceId: command.invoiceId, amount: conversion },
          existing,
          context,
        );

        if (existing === null) {
          repos.reservations.add(change.reservation);
        }

        if (change.event !== null) {
          repos.events.append(change.event);
        }

        return {
          status: existing === null ? 'CREATED' : 'REPLAYED',
          reservation: change.reservation,
        } as const;
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new DuplicateInvoiceError(
          command.programId,
          command.invoiceId,
          'a concurrent request created it first',
        );
      }

      throw error;
    }
  }
}

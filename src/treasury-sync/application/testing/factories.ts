import { Money } from '../../../capacity/domain/money';
import { type Program } from '../../../capacity/domain/program';
import {
  type FxRateMessage,
  type ProgramSnapshotMessage,
  type TreasuryInvoiceMessage,
} from '../../infrastructure/messages/program-snapshot.message';
import { type InvoiceRepaidMessage } from '../../infrastructure/messages/invoice-repaid.message';
import { type ProgramLimitChangedMessage } from '../../infrastructure/messages/program-limit-changed.message';

// Builders for the wire DTOs `ApplySnapshotUseCase` and its siblings actually
// receive, so a use-case test states a Kafka message rather than a domain
// object it never sees directly.

export const SNAPSHOT_AS_OF = '2026-09-15T12:00:00.000Z';

export interface InvoiceMessageOptions {
  readonly invoiceId?: string;
  readonly status?: 'OUTSTANDING' | 'REPAID';
  readonly amount?: string;
  readonly originalAmount?: string;
  readonly originalCurrency?: string;
  readonly rate?: FxRateMessage;
}

/** An outstanding invoice already in the program's own currency: no conversion, no rate. */
export function anInvoiceMessage(
  options: InvoiceMessageOptions = {},
): TreasuryInvoiceMessage {
  const amount = options.amount ?? '10000.00';

  return {
    invoiceId: options.invoiceId ?? 'inv-0001',
    status: options.status ?? 'OUTSTANDING',
    amount,
    originalAmount: options.originalAmount ?? amount,
    originalCurrency: options.originalCurrency ?? 'USD',
    rate: options.rate,
  };
}

export interface SnapshotMessageOptions {
  readonly programId?: string;
  readonly sequence?: number;
  readonly asOf?: string;
  readonly creditLimit?: string;
  readonly invoices?: readonly TreasuryInvoiceMessage[];
}

/**
 * A snapshot message whose checksums are computed from `invoices`, so a test
 * never has to keep `outstandingTotal`/`invoiceCount`/`repaidTotal`/
 * `repaidCount` in sync by hand — the one thing worth automating, since
 * `reconcileProgram` rejects the whole snapshot the moment they drift.
 */
export function aSnapshotMessage(
  program: Program,
  options: SnapshotMessageOptions = {},
): ProgramSnapshotMessage {
  const currency = program.currency;
  const invoices = options.invoices ?? [];
  const outstanding = invoices.filter(
    (entry) => entry.status === 'OUTSTANDING',
  );
  const repaid = invoices.filter((entry) => entry.status === 'REPAID');

  const sum = (entries: readonly TreasuryInvoiceMessage[]): string =>
    entries
      .reduce(
        (total, entry) =>
          total.add(Money.fromDecimalString(entry.amount, currency)),
        Money.zero(currency),
      )
      .toDecimalString();

  return {
    type: 'ProgramSnapshot',
    programId: options.programId ?? program.id,
    currency,
    sequence: options.sequence ?? 1,
    asOf: options.asOf ?? SNAPSHOT_AS_OF,
    creditLimit: options.creditLimit ?? program.creditLimit.toDecimalString(),
    invoices: [...invoices],
    outstandingTotal: sum(outstanding),
    invoiceCount: outstanding.length,
    repaidTotal: sum(repaid),
    repaidCount: repaid.length,
  };
}

export function aLimitChangedMessage(
  program: Program,
  newLimit: string,
): ProgramLimitChangedMessage {
  return { type: 'ProgramLimitChanged', programId: program.id, newLimit };
}

export function anInvoiceRepaidMessage(
  program: Program,
  invoiceId: string,
): InvoiceRepaidMessage {
  return { type: 'InvoiceRepaid', programId: program.id, invoiceId };
}

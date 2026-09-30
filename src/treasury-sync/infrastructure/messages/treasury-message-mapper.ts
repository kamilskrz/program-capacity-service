/**
 * The anti-corruption layer of docs/PLAN.md 2.2: pure functions, no NestJS, no
 * I/O. Every `Money`/`FxRate`/`CurrencyCode` is built through its own
 * validated factory, so a malformed message fails exactly the way a malformed
 * HTTP body does — through the domain's own errors (`InvalidAmountError`,
 * `UnknownCurrencyError`, `InvalidFxRateError`), never a raw parse exception.
 * Every currency is cast `as CurrencyCode` at the boundary: the cast itself
 * proves nothing, the factory it feeds validates regardless (the same
 * pattern `ReserveInvoiceUseCase` uses for `command.currency`).
 */

import {
  type FxRateMessage,
  type ProgramSnapshotMessage,
  type TreasuryInvoiceMessage,
} from './program-snapshot.message';
import { type CurrencyCode } from '../../../capacity/domain/currency';
import { Money } from '../../../capacity/domain/money';
import { FxRate } from '../../../fx/fx-rate';
import {
  type TreasuryInvoice,
  type TreasurySnapshot,
} from '../../domain/reconcile-program';

/**
 * @throws {UnknownCurrencyError} if `base`/`quote` are not supported.
 * @throws {InvalidFxRateError} for any other reason `FxRate.fromSnapshot` refuses the value.
 */
export function toFxRate(dto: FxRateMessage): FxRate {
  return FxRate.fromSnapshot(dto);
}

/**
 * `currency` is the snapshot's own currency (`ProgramSnapshotMessage.currency`),
 * which prices `amount`; `originalCurrency` travels on the entry itself and
 * prices `originalAmount`. Not `toTreasuryInvoice(dto)` alone: nothing on
 * `TreasuryInvoiceMessage` states the currency `amount` is in, since it is
 * the same one for every entry in a snapshot — carrying it here rather than
 * duplicating it onto every entry.
 *
 * @throws {UnknownCurrencyError} if either currency is not supported.
 * @throws {InvalidAmountError} if either amount is malformed or over-precise.
 * @throws {InvalidFxRateError} if `rate` is present but invalid.
 */
export function toTreasuryInvoice(
  dto: TreasuryInvoiceMessage,
  currency: CurrencyCode,
): TreasuryInvoice {
  return {
    invoiceId: dto.invoiceId,
    status: dto.status,
    amount: Money.fromDecimalString(dto.amount, currency),
    originalAmount: Money.fromDecimalString(
      dto.originalAmount,
      dto.originalCurrency as CurrencyCode,
    ),
    rate: dto.rate === undefined ? null : toFxRate(dto.rate),
  };
}

/**
 * @throws {UnknownCurrencyError} if `currency`, or any invoice's `originalCurrency`, is not supported.
 * @throws {InvalidAmountError} if any amount is malformed or over-precise.
 * @throws {InvalidFxRateError} if any invoice's `rate` is present but invalid.
 */
export function toTreasurySnapshot(
  dto: ProgramSnapshotMessage,
): TreasurySnapshot {
  const currency = dto.currency as CurrencyCode;

  return {
    programId: dto.programId,
    sequence: dto.sequence,
    // Not validated here: an unreadable `asOf` is `UNREADABLE_AS_OF`, a
    // snapshot rejection `reconcileProgram` itself decides (docs/PLAN.md
    // 2.1), not a parse exception this layer should pre-empt.
    asOf: new Date(dto.asOf),
    creditLimit: Money.fromDecimalString(dto.creditLimit, currency),
    invoices: dto.invoices.map((invoice) =>
      toTreasuryInvoice(invoice, currency),
    ),
    outstandingTotal: Money.fromDecimalString(dto.outstandingTotal, currency),
    invoiceCount: dto.invoiceCount,
    repaidTotal: Money.fromDecimalString(dto.repaidTotal, currency),
    repaidCount: dto.repaidCount,
  };
}

import { EntitySchema } from '@mikro-orm/core';

import {
  moneyAmount,
  moneyFromColumns,
} from '../../../capacity/infrastructure/persistence/money-amount.type';
import { type CurrencyCode } from '../../../capacity/domain/currency';
import { type Money } from '../../../capacity/domain/money';
import { type ReservationStatus } from '../../../capacity/domain/reservation';
import {
  type Discrepancy,
  type DiscrepancyReason,
  type TreasuryInvoiceStatus,
} from '../../domain/reconcile-program';

/** Every value of `treasury_discrepancies.reason` (`DiscrepancyReason`). */
export const DISCREPANCY_REASONS: readonly DiscrepancyReason[] = [
  'HELD_BUT_NOT_REPORTED',
  'REPORTED_AGAINST_RELEASED_HOLD',
  'MISSING_FX_EVIDENCE',
  'INCONSISTENT_FX_EVIDENCE',
  'UNUSABLE_AMOUNT',
];

/**
 * One open disagreement between this service and treasury about one
 * invoice. Upserted, never appended (docs/PLAN.md 2.8): the primary key is
 * `(program_id, invoice_id, reason)`, so `reason` is part of the key
 * because a discrepancy that changes reason is a different problem.
 */
export interface DiscrepancyRow {
  programId: string;
  invoiceId: string;
  reason: DiscrepancyReason;
  /** The sentence the domain wrote about this disagreement. */
  detail: string;
  /**
   * What this service holds, or `null` when it holds nothing. The write
   * shape is `Money`; a read hands back the `bigint` `MoneyAmountType`
   * produces, since the currency lives in its own column. Only
   * {@link discrepancyFromRow} may read this column back into a `Money`.
   */
  heldAmount: Money | bigint | null;
  /** What treasury reports, or `null` when it reports nothing. The same shapes. */
  reportedAmount: Money | bigint | null;
  /** The currency both amounts are stated in — the program's, since reconciliation rejects a foreign-currency snapshot whole. */
  currency: CurrencyCode;
  localStatus: ReservationStatus | null;
  reportedStatus: TreasuryInvoiceStatus | null;
  /** When this exact disagreement was first recorded. */
  firstSeen: Date;
  /** The `asOf` of the most recent snapshot that still saw it. */
  lastSeen: Date;
  /** When it stopped being seen, or `null` while it is open. */
  resolvedAt: Date | null;
}

/** `treasury_discrepancies`. */
export const discrepancySchema = new EntitySchema<DiscrepancyRow>({
  name: 'Discrepancy',
  tableName: 'treasury_discrepancies',
  properties: {
    programId: {
      kind: 'm:1',
      entity: () => 'Program',
      mapToPk: true,
      primary: true,
      fieldName: 'program_id',
      updateRule: 'cascade',
      deleteRule: 'restrict',
    },
    invoiceId: {
      type: 'string',
      length: 128,
      primary: true,
      fieldName: 'invoice_id',
    },
    reason: {
      enum: true,
      items: [...DISCREPANCY_REASONS],
      primary: true,
      fieldName: 'reason',
    },
    detail: { type: 'text', fieldName: 'detail' },
    heldAmount: {
      type: moneyAmount,
      nullable: true,
      fieldName: 'held_amount',
    },
    reportedAmount: {
      type: moneyAmount,
      nullable: true,
      fieldName: 'reported_amount',
    },
    currency: { type: 'string', length: 3, fieldName: 'currency' },
    localStatus: {
      enum: true,
      items: ['ACTIVE', 'RELEASED'],
      nullable: true,
      fieldName: 'local_status',
    },
    reportedStatus: {
      enum: true,
      items: ['OUTSTANDING', 'REPAID'],
      nullable: true,
      fieldName: 'reported_status',
    },
    firstSeen: { type: 'datetime', fieldName: 'first_seen' },
    lastSeen: { type: 'datetime', fieldName: 'last_seen' },
    resolvedAt: { type: 'datetime', nullable: true, fieldName: 'resolved_at' },
  },
  indexes: [
    {
      name: 'treasury_discrepancies_program_id_resolved_at_index',
      properties: ['programId', 'resolvedAt'],
    },
  ],
  checks: [
    {
      name: 'treasury_discrepancies_has_an_amount',
      expression: 'held_amount is not null or reported_amount is not null',
    },
    {
      name: 'treasury_discrepancies_last_seen_after_first_seen',
      expression: 'last_seen >= first_seen',
    },
  ],
});

/**
 * A stored discrepancy: the domain's {@link Discrepancy} plus the facts
 * only the table knows — which program, and the window it has been open.
 */
export interface StoredDiscrepancy extends Discrepancy {
  readonly programId: string;
  /** When this exact disagreement was first recorded. */
  readonly firstSeen: Date;
  /** The `asOf` of the most recent snapshot that still saw it. */
  readonly lastSeen: Date;
  /** When it stopped being seen, or `null` while it is open. */
  readonly resolvedAt: Date | null;
}

/**
 * Pairs a read row's two amount columns with the one `currency` column
 * they are both stated in — the only way to read
 * {@link DiscrepancyRow.heldAmount} and {@link DiscrepancyRow.reportedAmount}.
 *
 * A `null` column stays `null` and never becomes a zero amount:
 * `HELD_BUT_NOT_REPORTED` means treasury reported *nothing*, and
 * docs/PLAN.md 2.1's rule that absent data never releases capacity turns on
 * telling that from treasury reporting zero.
 *
 * @throws {TypeError} if an amount column did not arrive as the `bigint`
 * `MoneyAmountType` produces.
 * @throws {UnknownCurrencyError} if `currency` holds a code this build does
 * not support.
 */
export function discrepancyFromRow(row: DiscrepancyRow): StoredDiscrepancy {
  return {
    programId: row.programId,
    invoiceId: row.invoiceId,
    reason: row.reason,
    detail: row.detail,
    held: amountFromColumns(row.heldAmount, row.currency),
    reported: amountFromColumns(row.reportedAmount, row.currency),
    localStatus: row.localStatus,
    reportedStatus: row.reportedStatus,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    resolvedAt: row.resolvedAt,
  };
}

/** `moneyFromColumns`, but `null` survives as `null`. */
function amountFromColumns(
  amount: Money | bigint | null,
  currency: CurrencyCode,
): Money | null {
  return amount === null ? null : moneyFromColumns(amount, currency);
}

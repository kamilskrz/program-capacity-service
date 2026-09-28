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
 * One open disagreement between this service and treasury about one invoice.
 *
 * ## Upserted, never appended (docs/PLAN.md 2.8)
 *
 * The primary key is `(program_id, invoice_id, reason)`, which is the whole design:
 * reconciliation re-derives every unresolved discrepancy from scratch on each
 * snapshot, so an append-only table would write one row a minute per unresolved
 * invoice and leave `treasury_reconciliation_discrepancies_total` measuring
 * snapshot cadence instead of the number of problems — while the alerting reads it
 * as the latter. `first_seen` is written once, `last_seen` on every snapshot that
 * still sees it, and the count of problems is `count(*)` over unresolved rows.
 *
 * `reason` is part of the key because the same invoice can be wrong in two ways at
 * once, and because a discrepancy that changes reason is a different problem: an
 * invoice that went from `MISSING_FX_EVIDENCE` to `UNUSABLE_AMOUNT` has not had its
 * first problem resolved.
 *
 * ## Cycle 8 writes it; cycle 4 only creates it
 *
 * There is deliberately no repository here. Reconciliation is cycle 8's work, and a
 * port written now would be written against a use case nobody has read yet. What
 * cannot wait is the table: the schema is the expensive thing to change later, and
 * the upsert key is the part of it that a later cycle could not fix without a data
 * migration. The integration suite therefore exercises the key — an upsert of the
 * same triple twice must leave one row with a moved `last_seen` — and nothing else.
 *
 * ## `resolved_at`
 *
 * Nullable, and the reason it exists rather than the row being deleted when a
 * discrepancy clears: docs/PLAN.md 2.8 emits a `DISCREPANCY_FLAGGED` event "when one
 * appears or clears", so something has to be able to tell a discrepancy that
 * cleared from one that never existed — a deleted row cannot. Cycle 8 decides how it
 * is set; the column's presence is what keeps that decision available.
 */
export interface DiscrepancyRow {
  programId: string;
  invoiceId: string;
  reason: DiscrepancyReason;
  /** The sentence the domain wrote about this disagreement. */
  detail: string;
  /**
   * What this service holds, or `null` when it holds nothing.
   *
   * `Money | bigint | null`, which is the one thing about this row type that has to
   * be read carefully — it is exactly `MoneyAmountType`'s own domain type, and both
   * arms are real. A **write** hands over a `Money`; a **read** hands back the
   * `bigint` that `MoneyAmountType` produced, because the currency lives in its own
   * column and a MikroORM `Type` spans exactly one column (see
   * `money-amount.type.ts`).
   *
   * Declaring it `Money | null` was the fault: the row type said a read returns a
   * `Money`, nothing converted one, and `row.heldAmount.toString()` therefore
   * type-checked and returned `"9007199254740993"` where `Money.toString()` gives
   * `"90071992547409.93 USD"` — of a discrepancy amount, which is the figure a human
   * reads when deciding whether this service or treasury is wrong.
   *
   * **{@link discrepancyFromRow} is the only way to read these two columns.** The
   * union cannot enforce that on its own (`bigint` has a `toString` too), and the
   * narrower `bigint | null` — which would enforce it — is not available while the
   * write side goes through the same property: `em.create(discrepancySchema, …)`
   * hands over a `Money`, which is how the table is written and how its tests write
   * it. `CapacityEventRow` and `FxRateRow` have the same shape for the same reason;
   * this row is the one where nothing converted it back.
   */
  heldAmount: Money | bigint | null;
  /** What treasury reports, or `null` when it reports nothing. The same shapes. */
  reportedAmount: Money | bigint | null;
  /**
   * The currency both amounts are stated in — the program's. Treasury's figures
   * reach reconciliation already in the program's currency (a `FOREIGN_CURRENCY`
   * snapshot is rejected whole), so one column is enough and two could disagree.
   */
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
      // As on the other tables: a `mapToPk` relation, so the foreign key is the
      // mapping's and not the migration's. See `capacity-event.mapping.ts`.
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
      // The metric's query: how many problems are open for this program.
      name: 'treasury_discrepancies_program_id_resolved_at_index',
      properties: ['programId', 'resolvedAt'],
    },
  ],
  checks: [
    {
      // Every reason states at least one of the two amounts — a disagreement with
      // no figure on either side is not one.
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
 * A stored discrepancy: the domain's {@link Discrepancy} plus the three facts only
 * the table knows — which program it belongs to, and the window it has been open.
 *
 * `reconcileProgram` produces a `Discrepancy` without a program identifier because it
 * is reconciling one program and every discrepancy it returns belongs to it. A row has
 * to say, because the table holds every program's.
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
 * Pairs a read row's two amount columns with the one `currency` column they are both
 * stated in — the only way to read {@link DiscrepancyRow.heldAmount} and
 * {@link DiscrepancyRow.reportedAmount}.
 *
 * The counterpart of `capacityEventFromRow` and `fxRateFromRow`, and it exists for the
 * same reason: a MikroORM `Type` spans exactly one column, so `MoneyAmountType` can
 * hand back the minor units but not the currency, and something has to rejoin them.
 * This table was the one place in the persistence layer where nothing did, which made
 * `row.heldAmount.toString()` type-check and return `"9007199254740993"` — bare minor
 * units, of the figure a person reads when deciding whether this service or treasury
 * is wrong — where `Money.toString()` gives `"90071992547409.93 USD"`.
 *
 * A `null` column stays `null` and never becomes a zero amount. The distinction is
 * load-bearing rather than tidy: `HELD_BUT_NOT_REPORTED` means treasury reported
 * *nothing*, and docs/PLAN.md 2.1's governing rule — absent data never releases
 * capacity — turns on telling that from treasury reporting zero.
 *
 * @throws {TypeError} if an amount column did not arrive as the `bigint`
 * `MoneyAmountType` produces, which is what a `Money` still sitting on a
 * freshly-written entity would be. Reading one back takes a read, not the write's own
 * `EntityManager` — the same boundary the sibling functions draw.
 * @throws {UnknownCurrencyError} if `currency` holds a code this build does not
 * support.
 */
export function discrepancyFromRow(row: DiscrepancyRow): StoredDiscrepancy {
  return {
    programId: row.programId,
    invoiceId: row.invoiceId,
    reason: row.reason,
    detail: row.detail,
    // Both amounts against the row's single currency column: two columns could
    // disagree, and treasury's figures reach reconciliation already in the
    // program's currency (docs/PLAN.md 2.3).
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

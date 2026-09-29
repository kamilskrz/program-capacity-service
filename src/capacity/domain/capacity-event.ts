/**
 * The audit fact every capacity change produces (docs/PLAN.md 2.8). The
 * aggregate produces the event (type, delta, resulting total, invoice); the
 * caller supplies the provenance it cannot know (who, transport, when) via
 * {@link CapacityChangeContext}, required by every capacity-changing operation.
 */

import { type Money, type MoneyJson } from './money';
import { type ReleaseReason } from './reservation';
import { type FxRateSnapshot } from '../../fx/fx-rate';

/**
 * The `type` column of `capacity_events` (docs/PLAN.md 2.8). `RESERVED`,
 * `RELEASED`, `LIMIT_CHANGED` and `RECONCILIATION_ADJUSTMENT` are emitted by
 * `Program`; `RECONCILIATION_APPLIED` and `DISCREPANCY_FLAGGED` belong to
 * `treasury-sync` and are not capacity changes.
 */
export type CapacityEventType =
  | 'RESERVED'
  | 'RELEASED'
  | 'LIMIT_CHANGED'
  | 'RECONCILIATION_APPLIED'
  | 'RECONCILIATION_ADJUSTMENT'
  | 'DISCREPANCY_FLAGGED';

/** Which channel the change came through — `actor` is *who*, this is *how*. */
export type CapacityEventSource =
  'API' | 'TREASURY_SNAPSHOT' | 'TREASURY_EVENT';

/** The `metadata` jsonb column. Which fields apply depends on the event type. */
export interface CapacityEventMetadata {
  /** `RELEASED`: why the capacity was freed. */
  readonly reason?: ReleaseReason;
  /** `RESERVED`: the rate used, absent iff no conversion was needed (docs/PLAN.md 2.3). */
  readonly fxRate?: FxRateSnapshot;
  /** `RESERVED`: the invoice amount as the client stated it, before any FX. */
  readonly originalAmount?: MoneyJson;
  /** `RECONCILIATION_ADJUSTMENT`: what the reservation held before. */
  readonly previousReservedAmount?: MoneyJson;
  /** `RECONCILIATION_ADJUSTMENT`: what it holds after. */
  readonly correctedAmount?: MoneyJson;
  /** `LIMIT_CHANGED`: the limit before. */
  readonly previousCreditLimit?: MoneyJson;
  /** `LIMIT_CHANGED`: the limit after. */
  readonly creditLimit?: MoneyJson;
  /** Caller-supplied: the driving treasury snapshot's `sequence` (docs/PLAN.md 2.2). */
  readonly snapshotSequence?: number;
  /** Caller-supplied free text, for anything the columns do not cover. */
  readonly note?: string;
}

/**
 * Provenance the domain cannot know, required by every capacity-changing
 * operation. A blank `actor` or invalid `occurredAt` is refused
 * (`MissingAuditContextError`) — an unattributable change cannot be made.
 */
export interface CapacityChangeContext {
  /** JWT subject, or `treasury:kafka` for the consumer (docs/PLAN.md 2.8). */
  readonly actor: string;
  readonly source: CapacityEventSource;
  /** `x-request-id` or Kafka equivalent, `null` if the producer sent none. */
  readonly correlationId: string | null;
  /** Also becomes the reservation's `reservedAt`/`releasedAt` — one reading. */
  readonly occurredAt: Date;
  /** Merged into the event's metadata; the aggregate's own fields win on conflict. */
  readonly metadata?: CapacityEventMetadata;
}

/**
 * One append-only row of `capacity_events` (docs/PLAN.md 2.4, 2.8). Not event
 * sourcing: state is stored directly, and `SUM(delta) == reserved_amount` is
 * an asserted invariant, which is why {@link delta} and
 * {@link resultingReserved} are both recorded rather than derived at read time.
 */
export interface CapacityEvent {
  readonly type: CapacityEventType;
  readonly programId: string;
  /** `null` for `LIMIT_CHANGED`, which concerns no single invoice. */
  readonly invoiceId: string | null;
  /**
   * Change to the program's **reserved total**: positive for a reservation,
   * negative for a release. Zero for `LIMIT_CHANGED` — the limit's before/after
   * go to {@link CapacityEventMetadata} instead, so `delta` keeps one meaning.
   */
  readonly delta: Money;
  /** The program's reserved total after the change. */
  readonly resultingReserved: Money;
  readonly actor: string;
  readonly source: CapacityEventSource;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
  readonly metadata: CapacityEventMetadata;
}

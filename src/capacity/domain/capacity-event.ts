/**
 * The audit fact every capacity change produces (docs/PLAN.md 2.8).
 *
 * **Decision: the aggregate produces the entry, the caller supplies the
 * provenance.**
 *
 * The alternative — the application service assembling the entry after calling
 * the domain — was rejected. It makes the log a convention rather than a
 * guarantee: a new call site, a new consumer, or one early `return` on an error
 * path and capacity has moved with nothing to explain it, which is discovered
 * months later by whoever is trying to work out why a limit is 1.8M short. Here
 * an operation *returns* its event, so the only way to get the new state is to
 * be handed the fact that describes it, and cycle 5 writes both inside one
 * `em.transactional()`.
 *
 * But an aggregate can only produce what it honestly knows. It knows the type
 * of the change, the delta, the resulting reserved total and the invoice
 * involved — it computed all four. It does not know who the caller is, which
 * transport carried the request, what the HTTP correlation id was, or what time
 * it is: a domain that reads the clock is a domain that cannot be tested
 * against a fixed instant. Those four travel in {@link CapacityChangeContext},
 * which every capacity-changing operation demands as an argument. Splitting the
 * entry this way is what makes both halves impossible to forget: the facts
 * because the domain writes them, the provenance because the domain will not
 * act without it (see `MissingAuditContextError`).
 */

import { type Money, type MoneyJson } from './money';
import { type ReleaseReason } from './reservation';
import { type FxRateSnapshot } from '../../fx/fx-rate';

/**
 * The `type` column of `capacity_events` (docs/PLAN.md 2.8).
 *
 * The full set is declared here because one table holds all of them and the
 * persistence mapping needs the closed union, even though cycle 2 only produces
 * four: `RESERVED`, `RELEASED`, `LIMIT_CHANGED` and
 * `RECONCILIATION_ADJUSTMENT`. `RECONCILIATION_APPLIED` (a whole snapshot was
 * processed) and `DISCREPANCY_FLAGGED` (an invoice we hold that treasury does
 * not report) belong to `treasury-sync` in cycle 3; they are not capacity
 * changes and no `Program` operation emits them.
 */
export type CapacityEventType =
  | 'RESERVED'
  | 'RELEASED'
  | 'LIMIT_CHANGED'
  | 'RECONCILIATION_APPLIED'
  | 'RECONCILIATION_ADJUSTMENT'
  | 'DISCREPANCY_FLAGGED';

/**
 * Which channel the change came through.
 *
 * Separate from `actor` because they answer different questions: `actor` is
 * *who* (a JWT subject, or `treasury:kafka`), `source` is *how*. The same
 * treasury identity reaches the service through both a periodic snapshot and a
 * single `InvoiceRepaid`, and an investigation into a missing release needs to
 * tell those apart.
 */
export type CapacityEventSource =
  'API' | 'TREASURY_SNAPSHOT' | 'TREASURY_EVENT';

/**
 * The `metadata` jsonb column: everything worth recording that is not a column
 * of its own.
 *
 * Every field is a JSON primitive or a shape that serialises to one — `Money`
 * appears as {@link MoneyJson} (minor units as a string, per docs/PLAN.md 2.3)
 * and an FX rate as its stored snapshot. Nothing here needs a transformer to
 * become a database row, and nothing here loses precision on the way.
 *
 * All fields are optional because which ones apply depends on the event type;
 * the operations document and the tests pin down what each type carries.
 */
export interface CapacityEventMetadata {
  /** `RELEASED`: why the capacity was freed. */
  readonly reason?: ReleaseReason;
  /**
   * `RESERVED`: the rate that produced the held amount, absent when the invoice
   * was already in the program currency and no conversion happened
   * (docs/PLAN.md 2.3). Its absence is itself the evidence that none was
   * needed.
   */
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
  /**
   * Caller-supplied: the `sequence` of the treasury snapshot that drove the
   * change (docs/PLAN.md 2.2). The aggregate has no way to know it.
   */
  readonly snapshotSequence?: number;
  /** Caller-supplied free text, for anything the columns do not cover. */
  readonly note?: string;
}

/**
 * The provenance of a capacity change, supplied by the caller because the
 * domain cannot know any of it.
 *
 * Required by every capacity-changing operation. Passing it is not a courtesy:
 * an operation given a blank `actor` or an invalid `occurredAt` refuses to
 * change anything (`MissingAuditContextError`), so an unattributable change
 * cannot be made at all.
 */
export interface CapacityChangeContext {
  /**
   * The JWT subject, or `treasury:kafka` for anything driven by the consumer
   * (docs/PLAN.md 2.8). Must not be blank.
   */
  readonly actor: string;
  readonly source: CapacityEventSource;
  /**
   * `x-request-id` for HTTP, the equivalent Kafka header otherwise, or `null`
   * when the producer sent none — modelled as nullable rather than defaulted to
   * a generated value, because a correlation id nobody else has seen correlates
   * nothing and would only look like evidence.
   */
  readonly correlationId: string | null;
  /**
   * When the change happened, as the caller observed it. The domain never reads
   * the clock, so this is also the reservation's `reservedAt` / `releasedAt`:
   * one reading, and the entity and its audit entry cannot disagree about when.
   */
  readonly occurredAt: Date;
  /**
   * Extra provenance only the caller has, merged into the event's metadata. The
   * aggregate's own fields win on a conflict — the caller annotates the record,
   * it does not restate the facts.
   */
  readonly metadata?: CapacityEventMetadata;
}

/**
 * One append-only row of `capacity_events`, produced by the operation that
 * caused it and written in the same transaction (docs/PLAN.md 2.4, 2.8).
 *
 * This is not event sourcing: state is stored directly so that `GET /capacity`
 * stays a primary-key read. The log exists to explain and to verify that state
 * — `SUM(delta) == reserved_amount` is asserted as an invariant in cycle 5's
 * integration tests — which is why {@link delta} and {@link resultingReserved}
 * are both recorded rather than one being derived at read time.
 */
export interface CapacityEvent {
  readonly type: CapacityEventType;
  readonly programId: string;
  /** `null` for `LIMIT_CHANGED`, which concerns no single invoice. */
  readonly invoiceId: string | null;
  /**
   * The change this event made to the program's **reserved total**: positive
   * for a reservation or an upward correction, negative for a release or a
   * downward one.
   *
   * Zero for `LIMIT_CHANGED`, which moves the limit and not the total. The plan
   * leaves `delta` unqualified for that type; recording the limit's movement
   * here instead would make the column mean two different quantities and break
   * the `SUM(delta) == reserved_amount` check, so the limit's before and after
   * go to {@link CapacityEventMetadata} and `delta` keeps one meaning
   * throughout the log.
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

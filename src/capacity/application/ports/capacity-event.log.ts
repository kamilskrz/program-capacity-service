import { type CapacityEvent } from '../../domain/capacity-event';
import { type Money } from '../../domain/money';

/** The append-only audit log of docs/PLAN.md 2.8. */
export interface CapacityEventLog {
  /**
   * Schedules one event for insertion when the caller's transaction
   * flushes, so it commits atomically with the change it records.
   * @throws {TypeError} if handed a `null` event — the domain returns
   * `null` for a no-op, and forwarding it here would hide a caller bug as a
   * silent no-op.
   * @throws {CurrencyMismatchError} if the event's `delta` and
   * `resultingReserved` are stated in different currencies.
   */
  append(event: CapacityEvent): void;

  /**
   * One page of a program's log, oldest first, for `GET /programs/:id/events`.
   * Paged by the `bigserial` id, not `occurred_at`, since events written in
   * one transaction share a timestamp to the microsecond.
   * @throws {RangeError} if `limit` is given and not positive. An absent
   * limit means the whole log.
   */
  findByProgram(
    programId: string,
    options?: CapacityEventPageRequest,
  ): Promise<CapacityEventPage>;

  /**
   * The signed sum of every `delta` recorded for a program, in the
   * program's currency — the invariant docs/PLAN.md 2.4 checks.
   * @returns `null` when the program has no events: a sum with no currency
   * to report it in.
   */
  sumDeltas(programId: string): Promise<Money | null>;
}

/** A page request for {@link CapacityEventLog.findByProgram}. */
export interface CapacityEventPageRequest {
  /** Absent means the whole log; present and non-positive is refused. */
  readonly limit?: number;
  /** The `id` the previous page ended at; `undefined` starts at the beginning. */
  readonly after?: bigint;
}

/** One page of the audit log, with the cursor to continue from. */
export interface CapacityEventPage {
  /** The events, oldest first, paired with row ids since the domain event carries none. */
  readonly entries: readonly CapacityEventEntry[];
  readonly nextCursor: bigint | null;
}

/** One stored event: the domain fact plus the row's identity. */
export interface CapacityEventEntry {
  readonly id: bigint;
  readonly event: CapacityEvent;
  /** When the row was written, by the database's clock. */
  readonly recordedAt: Date;
}

/** Injection token for {@link CapacityEventLog}. */
export const CAPACITY_EVENT_LOG = Symbol('CapacityEventLog');

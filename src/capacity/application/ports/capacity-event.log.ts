import { type CapacityEvent } from '../../domain/capacity-event';
import { type Money } from '../../domain/money';

/**
 * The append-only audit log of docs/PLAN.md 2.8.
 *
 * # Decision: what the repository does with the event the domain returns
 *
 * Every capacity-changing operation on `Program` returns a `CapacityEvent`, so a
 * call site cannot change capacity without being handed the fact that explains it.
 * This port is where that fact lands, and three properties are deliberate:
 *
 * **It is written in the same transaction as the change.** Not by a flag or a
 * convention: {@link append} hands the row to the same unit of work that carries the
 * modified program and reservation, so one `em.flush()` inside one
 * `em.transactional()` writes all of them or none. There is no second connection, no
 * outbox and no `afterCommit` hook — a log that could be written after the commit
 * would be a log that is missing exactly the rows a crash makes interesting. The
 * integration suite asserts the pair: a rolled-back transaction leaves neither the
 * counter moved nor an event behind.
 *
 * **It is synchronous.** `append` returns `void`, not a promise, because nothing has
 * happened yet. An `async append` would invite `await log.append(event)` between two
 * halves of a change and suggest that the row exists once it resolves, which is
 * false until the flush. The same reasoning as `ProgramRepository.add`.
 *
 * **It is a separate port from the repositories, and not a separate transaction.**
 * The table is its own and cycle 7 reads it through its own endpoint, so it earns an
 * interface; what it must not earn is its own transaction. A use case receives both
 * ports bound to the same `EntityManager`, which is what makes the atomicity above
 * structural rather than remembered.
 *
 * A no-op produces no event at all — a replayed reservation, a repeated release, a
 * correction to the amount already held (docs/PLAN.md 2.8: the log records changes,
 * not the absence of one). That decision lives in the domain, which returns `null`;
 * this port is never handed one, and refuses `null` rather than quietly accepting it,
 * so "the domain said nothing changed" cannot be confused with "somebody forgot".
 */
export interface CapacityEventLog {
  /**
   * Schedules one event for insertion when the caller's transaction flushes.
   *
   * @throws {TypeError} if handed a `null` event. The domain returns `null` for a
   * no-op and the caller is expected to branch on it; forwarding it here is a bug,
   * and a silent no-op would hide it.
   * @throws {CurrencyMismatchError} if the event's `delta` and `resultingReserved`
   * are stated in different currencies — one currency column carries both, and an
   * event that disagrees with itself describes nothing.
   */
  append(event: CapacityEvent): void;

  /**
   * One page of a program's log, oldest first, for `GET /programs/:id/events`.
   *
   * Ordered and paged by the `bigserial` primary key rather than by `occurred_at`:
   * two events written in one transaction share the timestamp to the microsecond, so
   * a timestamp cursor cannot page deterministically, while the sequence is total and
   * gapless enough to be one.
   *
   * @throws {RangeError} if a `limit` is given and is not positive. An empty page is
   * byte for byte the answer for a program that has recorded nothing, and this log is
   * what explains why capacity moved (docs/PLAN.md 2.8), so the one thing it may not
   * do is say "nothing" by accident. An **absent** limit means the whole log.
   */
  findByProgram(
    programId: string,
    options?: CapacityEventPageRequest,
  ): Promise<CapacityEventPage>;

  /**
   * The signed sum of every `delta` recorded for a program.
   *
   * Exists for the invariant docs/PLAN.md 2.4 says is asserted in an integration
   * test: `reserved_amount == SUM(active reservations) == SUM(deltas)`. It is on the
   * port rather than left to raw SQL in a test because cycle 5's concurrency test is
   * not the only caller that will want it — a diagnostic endpoint or a reconciliation
   * pre-flight reads the same figure — and because the sum has to be taken in the
   * program's currency, which only this layer can pair with the column.
   *
   * @returns `null` when the program has no events at all: a sum of nothing has no
   * currency, and answering zero in a guessed currency would be the one thing
   * `Money` refuses to do.
   */
  sumDeltas(programId: string): Promise<Money | null>;
}

/** A page request for {@link CapacityEventLog.findByProgram}. */
export interface CapacityEventPageRequest {
  /**
   * How many entries the page may carry. Absent means the whole log, which is what
   * the invariant checks read; present and non-positive is refused rather than
   * clamped (see {@link CapacityEventLog.findByProgram}).
   */
  readonly limit?: number;
  /** The `id` the previous page ended at; `undefined` starts at the beginning. */
  readonly after?: bigint;
}

/** One page of the audit log, with the cursor to continue from. */
export interface CapacityEventPage {
  /**
   * The events, oldest first.
   *
   * Paired with their row ids, because the domain event does not carry one — it is
   * the fact, not the row — while a caller paging through needs the cursor.
   */
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

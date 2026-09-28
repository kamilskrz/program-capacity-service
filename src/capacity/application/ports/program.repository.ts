import { type Program } from '../../domain/program';

/**
 * How far reconciliation has got with one program: the highest treasury
 * `sequence` applied, and the `asOf` it carried.
 *
 * Two columns on `programs` rather than fields on the aggregate, because the
 * aggregate decides nothing with them — `reconcileProgram` takes
 * `appliedSequence` as an argument for exactly that reason — and cycle 4 may not
 * change committed domain code. `GET /capacity` reports `lastReconciledAt`
 * (docs/PLAN.md 2.7) and cycle 8 compares `appliedSequence` against an incoming
 * snapshot's; nothing else reads either.
 */
export interface ReconciliationWatermark {
  /**
   * `null` when the program has never been reconciled.
   *
   * A `bigint`, although the domain models a snapshot's `sequence` as a `number`
   * (`TreasurySnapshot.sequence` — what `JSON.parse` can carry). The column is 64-bit
   * because a producer's counter is, and reading it back exactly means a figure this
   * service did not write — another writer, a data migration — is reported as it stands
   * rather than rounded into a different number that would then be compared.
   *
   * **The conversion goes the other way from what you might expect, and it is safe.**
   * `reconcileProgram` takes `appliedSequence` as a `number` and refuses any snapshot
   * whose sequence is not a safe integer (`UNUSABLE_SEQUENCE`) before it compares
   * anything, so a caller narrows this value with `Number(...)` on the way in — sound
   * precisely because that gate has already bounded the other operand — and widens with
   * `BigInt(...)` on the way back to {@link ProgramRepository.advanceWatermark}. The
   * trap to avoid is `===` between a `bigint` and a `number`, which is always false;
   * relational comparison between them is exact, but converting at the boundary means
   * neither arises.
   */
  readonly appliedSequence: bigint | null;
  /** The `asOf` of the snapshot that {@link appliedSequence} names. */
  readonly reconciledAt: Date | null;
}

/**
 * The application layer's view of stored programs.
 *
 * # Decision: two reads, named for their purpose, with no lock in the signature
 *
 * Cycle 5 needs a program that cannot change under it while it decides
 * (docs/PLAN.md 2.4: lock → read → decide in the domain → write → commit), and
 * cycle 6 needs the same row for a `GET`. Those are two different questions, so
 * they are two methods — {@link findForCapacityChange} and {@link findById} — and
 * neither mentions a lock.
 *
 * The rejected alternative was one method with an option: `findById(id, { lock:
 * LockMode.PESSIMISTIC_WRITE })`. It fails twice. It puts a MikroORM enum in the
 * signature of an interface the application layer owns, so a port that exists to
 * keep the domain free of the ORM would import from it. And it makes the
 * safety-critical choice a parameter that a call site can get wrong silently: a
 * missing lock does not fail, it just occasionally oversells a credit limit under
 * load, which is the one defect this service exists to prevent. A separate name
 * cannot be passed the wrong value, and "what can change capacity?" is answerable
 * by grepping its callers.
 *
 * What the port promises is therefore a *property* — that no other capacity change
 * to this program can interleave until the caller's transaction ends — and
 * `SELECT … FOR UPDATE` is how the MikroORM adapter keeps that promise. An
 * in-memory fake could keep it with a mutex, and the tests of a use case would not
 * change.
 *
 * ## No `save`
 *
 * A loaded `Program` is tracked by the unit of work: the aggregate mutates in place
 * (see its class documentation, which explains why it does not return copies) and
 * `em.flush()` at the end of the transaction writes what changed. A `save(program)`
 * would suggest that forgetting it loses the write, which is exactly the wrong
 * mental model for a tracked entity, and would be a no-op that reviewers would
 * eventually start calling defensively. {@link add} exists only for a program that
 * does not exist yet.
 */
export interface ProgramRepository {
  /**
   * The program as it currently stands, for reading.
   *
   * Takes no lock and makes no promise about what happens next: it answers `GET
   * /programs/:id/capacity`, which is a strongly consistent single-row read
   * (docs/PLAN.md 2.8) and must not queue behind a reservation in flight.
   *
   * @returns `null` if no such program exists. Whether that becomes a `404` — and
   * whether "not yours" becomes one too (docs/PLAN.md 2.7) — is the HTTP layer's
   * decision, not this port's.
   * @throws {InvalidProgramError} if the stored row is not one the domain would
   * have written; see `DomainHydrator` for why that is a load-time failure.
   */
  findById(programId: string): Promise<Program | null>;

  /**
   * The program, serialized against every other capacity change to it.
   *
   * From the moment this resolves until the caller's transaction ends, no other
   * transaction can read this program for a capacity change — so the reserved total
   * the caller decides against is the one it will write against. Every source of
   * change goes through here: REST, treasury snapshots and `InvoiceRepaid`
   * (docs/PLAN.md 2.4), which is what makes one mechanism enough.
   *
   * **Must be called inside a transaction.** A row lock outside one is released
   * immediately and the promise above becomes a lie; the adapter refuses rather
   * than silently degrading.
   *
   * Different programs never block each other: the lock is on one row.
   *
   * @returns `null` if no such program exists — nothing is locked in that case, and
   * a snapshot for an unknown program is docs/PLAN.md 2.9's DLQ case rather than an
   * invitation to create one.
   * @throws {Error} if there is no active transaction.
   * @throws {InvalidProgramError} if the stored row is corrupt.
   */
  findForCapacityChange(programId: string): Promise<Program | null>;

  /**
   * Schedules a newly created program to be inserted when the caller's transaction
   * flushes.
   *
   * Synchronous, because nothing has happened yet: the insert is the flush's, so a
   * caller cannot believe the program exists before its transaction commits.
   *
   * @throws {UniqueConstraintViolationException} at flush time if the identifier is
   * taken — surfacing there and not here is docs/PLAN.md 2.6's note about unique
   * violations, and maps to `409`.
   */
  add(program: Program): void;

  /**
   * How far reconciliation has got with this program.
   *
   * Separate from {@link findById} because it is not the aggregate's state and no
   * capacity decision reads it; a use case that needs both asks for both, in the
   * same transaction, and nothing about the program has to be loaded to answer a
   * watermark question.
   *
   * **Strongly consistent, like {@link findById}.** What it answers is what is
   * committed, whether or not this context has read the program before: a caller
   * that judged a snapshot stale against an older watermark than the one the
   * capacity change is written against would reconcile work already applied and
   * then be refused by {@link advanceWatermark}, for ever.
   *
   * @returns `null` if no such program exists.
   */
  findWatermark(programId: string): Promise<ReconciliationWatermark | null>;

  /**
   * Records that a snapshot has been applied, for the flush to write.
   *
   * Cycle 8 calls this inside the same transaction as the capacity changes the
   * snapshot produced, so a program that reports `sequence` 7 as applied has also
   * stored every change sequence 7 asked for. Splitting the two would recreate the
   * problem the watermark exists to solve.
   *
   * Moving the watermark backwards is refused: at-least-once delivery means an
   * older snapshot can arrive after a newer one, and `STALE_SEQUENCE` is the verdict
   * for it (docs/PLAN.md 2.1) — a caller reaching here with an older sequence has
   * ignored that verdict.
   *
   * **The program must already have been read for a capacity change in this same
   * transaction.** The move is staged on the tracked aggregate so that it joins the
   * transaction's single flush rather than being a second statement that could
   * succeed on its own, and an implementation has nothing to stage it on otherwise.
   * Cycle 8 holds the program under lock by the time it gets here, so the
   * precondition costs it nothing; it is documented because a caller that skipped
   * the read would otherwise believe it had recorded a snapshot as applied while
   * nothing was written, and the next snapshot would be judged against a watermark
   * that never moved — the same work redone for ever with no error to explain it.
   *
   * **Both halves of the watermark are required.** `appliedSequence` is the sequence
   * applied and `reconciledAt` is the `asOf` of the snapshot that names it, which
   * every snapshot carries (docs/PLAN.md 2.2); neither is a value the other can be
   * moved without. `null` on either side is the absence of a watermark rather than a
   * value to move to — `reconciledAt` because `GET /capacity` reports it
   * (docs/PLAN.md 2.7) and "reconciled at no time" is not a state anything can
   * render, `appliedSequence` because "never reconciled" is what no watermark means.
   *
   * @throws {Error} if `watermark.appliedSequence` is not greater than the stored
   * one, if either half of the watermark is `null`, or if the program has not been
   * read in this context.
   */
  advanceWatermark(programId: string, watermark: ReconciliationWatermark): void;
}

/**
 * Injection token for {@link ProgramRepository}.
 *
 * An interface leaves no runtime value for Nest to key on, and a symbol next to the
 * port keeps the contract in one file — the same convention `FX_RATE_PROVIDER`
 * already follows, and it keeps the application layer free of NestJS imports
 * (docs/PLAN.md 2.6).
 */
export const PROGRAM_REPOSITORY = Symbol('ProgramRepository');

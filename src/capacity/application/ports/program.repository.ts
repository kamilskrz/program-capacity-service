import { type Program } from '../../domain/program';

/** How far reconciliation has got with a program: the highest treasury `sequence` applied, and its `asOf`. */
export interface ReconciliationWatermark {
  /**
   * `null` if never reconciled. A `bigint` (docs/PLAN.md 2.1): narrow with
   * `Number(...)` only after `reconcileProgram`'s safe-integer check, and
   * widen with `BigInt(...)` on the way back — never `===` a `bigint`
   * against a `number`.
   */
  readonly appliedSequence: bigint | null;
  /** The `asOf` of the snapshot {@link appliedSequence} names. */
  readonly reconciledAt: Date | null;
}

/** Stored programs, as the application layer sees them. */
export interface ProgramRepository {
  /**
   * Current state, for reading; takes no lock. Strongly consistent
   * (docs/PLAN.md 2.8), not served from the identity map.
   * @returns `null` if no such program exists.
   * @throws {InvalidProgramError} if the stored row is corrupt.
   */
  findById(programId: string): Promise<Program | null>;

  /**
   * The program, serialized against every other capacity change, via
   * `SELECT … FOR UPDATE`.
   *
   * **Must be called inside a transaction** — a lock taken outside one
   * releases as the statement ends, so every caller would believe it held
   * the program when it did not; this is the service's one serialization
   * point.
   * @returns `null`, locking nothing, if no such program exists.
   * @throws {Error} if there is no active transaction.
   * @throws {InvalidProgramError} if the stored row is corrupt.
   */
  findForCapacityChange(programId: string): Promise<Program | null>;

  /**
   * Schedules a newly created program for insert at flush.
   * @throws {UniqueConstraintViolationException} at flush time, not here,
   * if the identifier is taken.
   */
  add(program: Program): void;

  /**
   * How far reconciliation has got with this program. Strongly consistent,
   * like {@link findById}.
   * @returns `null` if no such program exists.
   */
  findWatermark(programId: string): Promise<ReconciliationWatermark | null>;

  /**
   * Records a snapshot as applied, for the flush to write. Must be called
   * after the program was read for a capacity change in this same
   * transaction, since the move is staged on that tracked aggregate.
   * @throws {Error} if the sequence does not advance, either half of the
   * watermark is `null`, or the program has not been read in this context.
   */
  advanceWatermark(programId: string, watermark: ReconciliationWatermark): void;
}

/** Injection token for {@link ProgramRepository}. */
export const PROGRAM_REPOSITORY = Symbol('ProgramRepository');

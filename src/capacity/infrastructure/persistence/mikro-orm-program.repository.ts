import { LockMode, type EntityManager } from '@mikro-orm/postgresql';

import {
  asProgram,
  asStoredProgram,
  programSchema,
  type StoredProgram,
} from './program.mapping';
import {
  type ProgramRepository,
  type ReconciliationWatermark,
} from '../../application/ports/program.repository';
import { type Program } from '../../domain/program';

/** No amount, so the hydrator has nothing to assemble or refuse. */
const WATERMARK_FIELDS = ['lastSnapshotSequence', 'lastReconciledAt'] as const;

/**
 * `ProgramRepository` over MikroORM. Bound to one `EntityManager` at
 * construction — the forked, transactional one for a capacity change
 * (docs/PLAN.md 2.6) — rather than injected as a singleton, so it can never
 * read or write outside the transaction its caller believes it is in.
 */
export class MikroOrmProgramRepository implements ProgramRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Flushes staged work before a `refresh` read discards it. Only inside a
   * transaction — outside one, flushing would commit a capacity change on
   * its own, which `flushMode: COMMIT` exists to prevent (docs/PLAN.md 2.6).
   */
  private async flushPendingWork(): Promise<void> {
    if (this.em.isInTransaction()) {
      await this.em.flush();
    }
  }

  /**
   * `refresh: true`, since an unqualified primary-key `findOne` answers from
   * the identity map without a query — the cache docs/PLAN.md 2.8 forbids.
   * @throws {InvalidProgramError} if the row is corrupt (see `DomainHydrator`).
   */
  async findById(programId: string): Promise<Program | null> {
    await this.flushPendingWork();

    const stored = await this.em.findOne(
      programSchema,
      { id: programId },
      { refresh: true },
    );

    return stored === null ? null : asProgram(stored);
  }

  /**
   * `SELECT … FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`), inside the
   * caller's transaction.
   *
   * Refuses to run without one: a lock taken in autocommit is released as
   * the statement ends, so every caller would believe it held a program it
   * did not — the service's one serialization point.
   * @throws {Error} if called outside a transaction.
   * @throws {InvalidProgramError} if the row is corrupt.
   */
  async findForCapacityChange(programId: string): Promise<Program | null> {
    if (!this.em.isInTransaction()) {
      throw new Error(
        `findForCapacityChange(${programId}) requires an open transaction: a SELECT … FOR UPDATE issued in autocommit releases its lock as the statement ends, so the reserved total decided against would not be the one written against. Wrap the capacity change in em.transactional().`,
      );
    }

    const stored = await this.em.findOne(
      programSchema,
      { id: programId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    return stored === null ? null : asProgram(stored);
  }

  /** The aggregate is the entity: no copy, so its later mutations are the ones the unit of work sees. */
  add(program: Program): void {
    this.em.persist(asStoredProgram(program));
  }

  /**
   * The two watermark columns, no amount, so a corrupt amount column does
   * not stop reconciliation from reading how far it has got. `refresh: true`
   * for the same reason as {@link findById}.
   */
  async findWatermark(
    programId: string,
  ): Promise<ReconciliationWatermark | null> {
    await this.flushPendingWork();

    const stored = await this.em.findOne(
      programSchema,
      { id: programId },
      { fields: [...WATERMARK_FIELDS], refresh: true },
    );

    if (stored === null) {
      return null;
    }

    return {
      appliedSequence: stored.lastSnapshotSequence,
      reconciledAt: stored.lastReconciledAt,
    };
  }

  /**
   * Stages the watermark move on the tracked program, so it joins the
   * caller's single flush instead of being a statement of its own. The
   * program must already be loaded in this `EntityManager`.
   * @throws {Error} if the program is not loaded in this context, or if the
   * new sequence does not move forward.
   */
  advanceWatermark(
    programId: string,
    watermark: ReconciliationWatermark,
  ): void {
    const { appliedSequence, reconciledAt } = watermark;

    if (appliedSequence === null) {
      throw new Error(
        `refusing to advance the reconciliation watermark of ${programId} to nothing: "never reconciled" is the absence of a watermark, not a value to move to`,
      );
    }

    if (reconciledAt === null) {
      throw new Error(
        `refusing to advance the reconciliation watermark of ${programId} to sequence ${appliedSequence} at no time: the instant is the asOf of the snapshot that sequence names, which every snapshot carries, and "reconciled at no time" is the absence of a watermark rather than a value to move to`,
      );
    }

    const stored = this.em
      .getUnitOfWork()
      .getById<StoredProgram>('Program', programId);

    if (stored === undefined || stored === null) {
      throw new Error(
        `program ${programId} is not loaded in this context: advanceWatermark stages the move on the tracked aggregate, so the program has to have been read for a capacity change in this very transaction`,
      );
    }

    const current = stored.lastSnapshotSequence;

    if (current !== null && appliedSequence <= current) {
      throw new Error(
        `refusing to move the reconciliation watermark of ${programId} from ${current} to ${appliedSequence}: an older snapshot arriving late is stale rather than news (docs/PLAN.md 2.1)`,
      );
    }

    stored.lastSnapshotSequence = appliedSequence;
    stored.lastReconciledAt = reconciledAt;
  }
}

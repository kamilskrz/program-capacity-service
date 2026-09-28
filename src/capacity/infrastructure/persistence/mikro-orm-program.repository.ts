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

/**
 * The two columns {@link MikroOrmProgramRepository.findWatermark} selects: no
 * amount, so the hydrator has nothing to assemble and nothing to refuse.
 */
const WATERMARK_FIELDS = ['lastSnapshotSequence', 'lastReconciledAt'] as const;

/**
 * `ProgramRepository` over MikroORM.
 *
 * ## Bound to an `EntityManager`, not to the container
 *
 * The constructor takes the `EntityManager` this repository works through, which for
 * a capacity change is the forked, transactional one `em.transactional()` hands its
 * callback (docs/PLAN.md 2.6: the consumer runs outside the request context, the
 * identity map means every capacity-changing operation starts from a fresh fork).
 * A repository that captured the global `EntityManager` once, at injection time,
 * would read and write outside the transaction its caller believes it is in —
 * silently, and only under load.
 *
 * It is therefore a plain class rather than an `@Injectable()` singleton; cycle 5
 * constructs one per transaction, or a provider factory does it for them.
 *
 * ## The lock lives here and nowhere else
 *
 * `findForCapacityChange` is `SELECT … FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`).
 * The port promises serialization as a property and says nothing about how; this is
 * the only file that knows, which is what keeps the choice replaceable and the
 * application layer free of MikroORM (see the port for the alternative that was
 * rejected — a lock option in the signature).
 */
export class MikroOrmProgramRepository implements ProgramRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Writes whatever the caller has staged, before a read that refreshes.
   *
   * `refresh` re-hydrates the tracked entity from the row and would otherwise discard
   * an unwritten change. Only inside a transaction, where the statements join the one
   * the caller already opened; outside one a flush would commit a capacity change on
   * its own, which is what `flushMode: COMMIT` exists to prevent (docs/PLAN.md 2.6).
   */
  private async flushPendingWork(): Promise<void> {
    if (this.em.isInTransaction()) {
      await this.em.flush();
    }
  }

  /**
   * A primary-key read, no lock, and one that always reaches the database.
   *
   * Without `refresh` a primary-key `findOne` answers from the identity map without
   * issuing a query, which is the cache docs/PLAN.md 2.8 forbids for a capacity read;
   * {@link flushPendingWork} is what keeps the refresh from discarding the caller's
   * own unwritten change.
   *
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
   * `em.findOne(programSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE })`,
   * inside the caller's transaction.
   *
   * Refuses to run without one: MikroORM would issue the `FOR UPDATE` in an
   * autocommit statement, the lock would be released as the statement ended, and
   * every caller would believe it held a program it did not. `em.isInTransaction()`
   * is the check, and the error names the use case's mistake rather than leaving it
   * to a concurrency test months later.
   *
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
      // The lock, and the only place in the service that knows about it: the
      // port promises serialization as a property and says nothing about how
      // (docs/PLAN.md 2.4). A program that does not exist locks nothing.
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    return stored === null ? null : asProgram(stored);
  }

  /**
   * `em.persist(asStoredProgram(program))`.
   *
   * The aggregate is the entity, so nothing is copied: the instance the caller built
   * with `Program.create` is the one the unit of work will insert, and the one whose
   * later mutations the same unit of work will see.
   */
  add(program: Program): void {
    // No copy: the instance `Program.create` built is the entity the unit of
    // work inserts, and the one whose later mutations it will see.
    this.em.persist(asStoredProgram(program));
  }

  /**
   * The two watermark columns, read without building the aggregate.
   *
   * A partial select rather than a full load, because a corrupt amount column must
   * not stop cycle 8 from reading how far it has got: the watermark is what tells it
   * whether a snapshot is stale, and answering "stale" for a program that cannot be
   * hydrated is more useful than failing the message. The read still runs the
   * hydrator; what makes it safe on a row `findById` would refuse is that a
   * projection carrying no amount has nothing to assemble (see `DomainHydrator`).
   *
   * `refresh: true` for the same reason as {@link findById}: a primary-key `findOne`
   * otherwise answers from the identity map without issuing a query, and a stale
   * sequence read beside a refreshed locked read is a reconciliation that can never
   * terminate.
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
   * Stages the watermark move on the tracked program, for the caller's flush.
   *
   * Implemented as a change to the loaded entity rather than a `nativeUpdate`, so it
   * joins the transaction's single flush together with the counter and the audit rows
   * instead of being a second statement that could succeed on its own. The program
   * must already be loaded in this `EntityManager` — cycle 8 has it under lock by the
   * time it gets here, and requiring that is what keeps the watermark and the changes
   * it accounts for in one transaction.
   *
   * @throws {Error} if the program is not loaded in this context, or if the new
   * sequence does not move forward.
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

    // The mirror image of the same rule. The pair means one thing — the `asOf` of
    // the snapshot that `appliedSequence` names, which every snapshot carries
    // (docs/PLAN.md 2.2) — so a sequence with no instant would store "reconciled,
    // at no time", which nothing can produce honestly and `GET /capacity` has
    // nothing to render for (docs/PLAN.md 2.7).
    if (reconciledAt === null) {
      throw new Error(
        `refusing to advance the reconciliation watermark of ${programId} to sequence ${appliedSequence} at no time: the instant is the asOf of the snapshot that sequence names, which every snapshot carries, and "reconciled at no time" is the absence of a watermark rather than a value to move to`,
      );
    }

    // The tracked aggregate, not a `nativeUpdate`: the move then joins the
    // transaction's single flush together with the counter and the audit rows
    // instead of being a second statement that could succeed on its own.
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

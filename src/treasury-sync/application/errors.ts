/**
 * Errors raised by `treasury-sync`'s use cases. Neither is a `DomainError`:
 * nothing here reaches an HTTP boundary, so nothing maps either to a status
 * code — the consumer (block 6) catches them and routes the message to the
 * DLQ (docs/PLAN.md 2.2).
 */

import { type SnapshotRejection } from '../domain/reconcile-program';

/**
 * `reconcileProgram` refused the snapshot outright (docs/PLAN.md 2.2 step 5).
 * Carries the `SnapshotRejection` verbatim, so the consumer can write its
 * `reason`/`origin`/`detail` into the DLQ envelope without re-deriving them.
 */
export class SnapshotRejectedError extends Error {
  constructor(readonly rejection: SnapshotRejection) {
    super(
      `Snapshot for program ${rejection.appliedSequence === null ? 'never reconciled' : `applied through ${rejection.appliedSequence}`}, sequence ${rejection.sequence}, rejected: ${rejection.reason} (${rejection.detail})`,
    );
    this.name = new.target.name;
  }
}

/**
 * A message names a program this service has never heard of (docs/PLAN.md
 * 2.9): a closed set of identifiers, so this is a routing defect or a
 * producer typo, not a client mistake — distinct from `capacity/application`'s
 * `ProgramNotFoundError`, which is HTTP-facing (`404`, "not yours or doesn't
 * exist") and reachable by a caller supplying a bad path parameter. This one
 * is transport-facing: caught by the consumer and sent straight to the DLQ,
 * never mapped to a status code.
 */
export class UnknownProgramError extends Error {
  constructor(readonly programId: string) {
    super(`No such program: ${programId}`);
    this.name = new.target.name;
  }
}

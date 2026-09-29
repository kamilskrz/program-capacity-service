/** Errors raised by the application layer's use cases, not the domain. */

import { DomainError } from '../domain/errors';

/** No program with this id; `404` (docs/PLAN.md 2.4). */
export class ProgramNotFoundError extends DomainError {
  readonly code = 'PROGRAM_NOT_FOUND';

  constructor(readonly programId: string) {
    super(`No such program: ${programId}`);
  }
}

/** No reservation for this invoice in this program; `404` (docs/PLAN.md 2.4). */
export class ReservationNotFoundError extends DomainError {
  readonly code = 'RESERVATION_NOT_FOUND';

  constructor(
    readonly programId: string,
    readonly invoiceId: string,
  ) {
    super(`No reservation for invoice ${invoiceId} in program ${programId}`);
  }
}

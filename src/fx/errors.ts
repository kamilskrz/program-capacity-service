import { DomainError } from '../capacity/domain/errors';

/** No rate for the pair; maps to `422` (docs/PLAN.md 2.3). */
export class FxRateNotFoundError extends DomainError {
  readonly code = 'FX_RATE_NOT_FOUND';

  constructor(
    readonly base: string,
    readonly quote: string,
  ) {
    super(`No FX rate available for ${base}/${quote}`);
  }
}

/** Bad data in the rate source (unlike {@link FxRateNotFoundError}, a gap) — a server-side fault. */
export class InvalidFxRateError extends DomainError {
  readonly code = 'INVALID_FX_RATE';

  constructor(readonly reason: string) {
    super(`Invalid FX rate: ${reason}`);
  }
}

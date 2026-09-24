import { DomainError } from '../capacity/domain/errors';

/**
 * FX errors, kept next to the FX code rather than in the capacity domain: they
 * are raised by conversion, and a reader of `src/fx` should not have to look
 * elsewhere to find what it can throw. They extend the same
 * {@link DomainError} base, so one exception filter still maps everything.
 */

/**
 * No rate is available for a currency pair.
 *
 * This is the error behind the `422` in docs/PLAN.md 2.3 and 2.7. It exists as
 * a distinct class because the alternative — inventing a rate, or falling back
 * to a stale one — would put an unknown amount of exposure against a credit
 * limit. A reservation that cannot be priced is not accepted.
 */
export class FxRateNotFoundError extends DomainError {
  readonly code = 'FX_RATE_NOT_FOUND';

  constructor(
    readonly base: string,
    readonly quote: string,
  ) {
    super(`No FX rate available for ${base}/${quote}`);
  }
}

/**
 * A rate that cannot be trusted or represented: zero, negative, malformed,
 * finer than the guaranteed precision, missing its provenance, or quoting a
 * currency against itself.
 *
 * Unlike {@link FxRateNotFoundError} this signals bad data in the rate source
 * rather than a gap in it, so it is a server-side fault, not a client error.
 */
export class InvalidFxRateError extends DomainError {
  readonly code = 'INVALID_FX_RATE';

  constructor(readonly reason: string) {
    super(`Invalid FX rate: ${reason}`);
  }
}

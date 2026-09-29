/**
 * `code → HTTP status` for the `DomainError`s that are a client mistake
 * (docs/PLAN.md 2.7). Everything else is corruption or a programmer error
 * and defaults to `500` in the filter, not here.
 */
export const ERROR_STATUS_MAP: Readonly<Record<string, number>> = {
  INSUFFICIENT_CAPACITY: 409,
  DUPLICATE_INVOICE: 409,
  RESERVATION_STATE_CONFLICT: 409,
  PROGRAM_NOT_FOUND: 404,
  RESERVATION_NOT_FOUND: 404,
  FX_RATE_NOT_FOUND: 422,
  UNKNOWN_CURRENCY: 400,
  INVALID_AMOUNT: 400,
  INVALID_CREDIT_LIMIT: 400,
  INVALID_CURSOR: 400,
};

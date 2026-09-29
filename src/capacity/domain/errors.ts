/** Typed domain errors; the domain never throws with an HTTP status (docs/PLAN.md 2.6). */

/** `code` is part of the public API surface; abstract so it can't be forgotten. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    // Otherwise subclass instances report `Error` in logs and test failures.
    this.name = new.target.name;
  }
}

export class UnknownCurrencyError extends DomainError {
  readonly code = 'UNKNOWN_CURRENCY';

  constructor(readonly value: string) {
    super(`Unsupported currency code: ${JSON.stringify(value)}`);
  }
}

export class InvalidAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT';

  constructor(
    readonly value: string,
    readonly reason: string,
  ) {
    super(`Invalid amount ${JSON.stringify(value)}: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly operation: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Cannot ${operation}: expected currency ${expected} but received ${actual}`,
    );
  }
}

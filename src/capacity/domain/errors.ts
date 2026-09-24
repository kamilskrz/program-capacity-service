/**
 * Domain errors.
 *
 * The domain is plain TypeScript (docs/PLAN.md 2.6) and must not know about
 * HTTP, so it never throws with a status code. It throws a typed class with a
 * stable machine-readable {@link DomainError.code}; the exception filter added
 * in a later cycle maps that code to an RFC 7807 response (docs/PLAN.md 2.7).
 * Mapping on the class or its code — rather than on a message — is what keeps
 * error wording free to change without breaking clients.
 *
 * Error construction is real code rather than a stub: an error carries no
 * behaviour to implement, and the rest of the contract has to be able to name
 * these classes.
 */

/**
 * Base class for every error the domain raises deliberately.
 *
 * `code` is part of the public API surface of the service. It is declared
 * abstract so that a new domain error cannot be added without choosing one.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    // Subclass instances otherwise report `Error`, which makes log lines and
    // Jest failures considerably harder to read.
    this.name = new.target.name;
  }
}

/**
 * A currency code that is not in the supported ISO 4217 set.
 *
 * This is a rejection, never a fallback: guessing a currency would silently
 * measure exposure in the wrong unit.
 */
export class UnknownCurrencyError extends DomainError {
  readonly code = 'UNKNOWN_CURRENCY';

  constructor(readonly value: string) {
    super(`Unsupported currency code: ${JSON.stringify(value)}`);
  }
}

/**
 * A monetary amount that cannot be represented exactly: a malformed decimal
 * string, or more fraction digits than the currency has (`"100.001"` in USD).
 *
 * Rounding the input away would mean the service quietly reserved a different
 * amount than the client asked for, so the amount is refused instead.
 */
export class InvalidAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT';

  constructor(
    readonly value: string,
    readonly reason: string,
  ) {
    super(`Invalid amount ${JSON.stringify(value)}: ${reason}`);
  }
}

/**
 * An operation that combines or orders two amounts in different currencies.
 *
 * Adding USD to EUR has no meaning; the caller has to convert first (see
 * `src/fx/convert.ts`), which is an explicit, recorded step.
 */
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

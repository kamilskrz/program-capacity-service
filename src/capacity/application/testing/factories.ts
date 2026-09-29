import { type Clock } from '../ports/clock';
import { type CapacityChangeContext } from '../../domain/capacity-event';
import { type CurrencyCode } from '../../domain/currency';
import { Money } from '../../domain/money';
import { Program } from '../../domain/program';
import { type Reservation } from '../../domain/reservation';
import { type Conversion } from '../../../fx/convert';

// Minimal builders for the use case unit tests — `program.spec.ts` and
// `reservation.spec.ts` keep their own equivalents module-private, so these
// are not a duplicate of an exported factory.

export const OCCURRED_AT = new Date('2026-01-15T10:32:00.000Z');

/** A `Clock` fixed to one instant, so a use case's `occurredAt` is assertable. */
export class FixedClock implements Clock {
  constructor(private readonly instant: Date = OCCURRED_AT) {}

  now(): Date {
    return this.instant;
  }
}

export interface TestProgramOptions {
  readonly id?: string;
  readonly ownerOrgId?: string;
  readonly currency?: CurrencyCode;
  readonly creditLimit?: Money;
}

/** A program with nothing reserved against it. */
export function aProgram(options: TestProgramOptions = {}): Program {
  const currency = options.currency ?? 'USD';

  return Program.create({
    id: options.id ?? 'prog-northwind',
    ownerOrgId: options.ownerOrgId ?? 'org-northwind',
    currency,
    creditLimit:
      options.creditLimit ?? Money.fromMinorUnits(1_000_000_000n, currency),
  });
}

/** An invoice already in the program's currency: no conversion, no rate. */
export function unconverted(amount: Money): Conversion {
  return { original: amount, converted: amount, rate: null };
}

export function anAuditContext(
  overrides: Partial<CapacityChangeContext> = {},
): CapacityChangeContext {
  return {
    actor: 'user-42',
    source: 'API',
    correlationId: 'corr-0001',
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

/** Opens a hold directly through the domain, for seeding a test's fakes. */
export function aReservation(
  program: Program,
  invoiceId: string,
  amount: Conversion,
  context: CapacityChangeContext = anAuditContext(),
): Reservation {
  return program.reserve({ invoiceId, amount }, null, context).reservation;
}

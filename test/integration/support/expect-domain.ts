import { type CapacityEvent } from '../../../src/capacity/domain/capacity-event';
import { type Money } from '../../../src/capacity/domain/money';
import { type Program } from '../../../src/capacity/domain/program';
import { type Reservation } from '../../../src/capacity/domain/reservation';
import { type FxRate } from '../../../src/fx/fx-rate';

// "The same object came back" — stated once, so every round-trip test says it
// the same way. Compared through public surface rather than `toEqual`: the
// aggregates have no `equals` of their own, and structural equality would miss
// a `minorUnits` that came back as a string instead of a `bigint`.

// The `toString()` comparison comes first so a failure reads as an amount, not
// `false !== true`.
export function expectSameMoney(actual: Money, expected: Money): void {
  expect(actual.toString()).toBe(expected.toString());
  expect(actual.equals(expected)).toBe(true);
  expect(typeof actual.minorUnits).toBe('bigint');
}

// Compared as epoch milliseconds: `timestamptz` keeps microseconds and `Date`
// cannot, so equality is asserted at the precision both sides actually carry.
export function expectSameInstant(actual: Date, expected: Date): void {
  expect(actual.toISOString()).toBe(expected.toISOString());
}

/** The six facts an {@link FxRate} is, compared as the snapshot it serialises to. */
export function expectSameFxRate(
  actual: FxRate | null,
  expected: FxRate | null,
): void {
  if (expected === null) {
    expect(actual).toBeNull();

    return;
  }

  expect(actual).not.toBeNull();
  expect(actual!.toJSON()).toEqual(expected.toJSON());
  // `toJSON` stringifies the amount, so a `bigint` that came back wrong would
  // still pass `toEqual` above; checked separately on purpose.
  expect(typeof actual!.scaledValue).toBe('bigint');
}

/** A loaded program is the program that was stored, `available` included. */
export function expectSameProgram(actual: Program, expected: Program): void {
  expect(actual.id).toBe(expected.id);
  expect(actual.ownerOrgId).toBe(expected.ownerOrgId);
  expect(actual.currency).toBe(expected.currency);
  expectSameMoney(actual.creditLimit, expected.creditLimit);
  expectSameMoney(actual.reserved, expected.reserved);
  expectSameMoney(actual.available, expected.available);
  expect(actual.overUtilized).toBe(expected.overUtilized);
}

/** A loaded reservation is the reservation that was stored. */
export function expectSameReservation(
  actual: Reservation,
  expected: Reservation,
): void {
  expect(actual.programId).toBe(expected.programId);
  expect(actual.invoiceId).toBe(expected.invoiceId);
  expect(actual.status).toBe(expected.status);
  expectSameMoney(actual.originalAmount, expected.originalAmount);
  expectSameMoney(actual.reservedAmount, expected.reservedAmount);
  expectSameMoney(actual.releasedAmount, expected.releasedAmount);
  expectSameMoney(actual.outstandingAmount, expected.outstandingAmount);
  expectSameFxRate(actual.fxRate, expected.fxRate);
  expectSameInstant(actual.reservedAt, expected.reservedAt);
  expect(actual.releasedAt?.toISOString() ?? null).toBe(
    expected.releasedAt?.toISOString() ?? null,
  );
  expect(actual.releaseReason).toBe(expected.releaseReason);
}

// `metadata` uses `toEqual` deliberately: the domain drops a field it knows
// doesn't apply rather than storing `null`, so absent and `undefined` must not
// become the same jsonb document.
export function expectSameEvent(
  actual: CapacityEvent,
  expected: CapacityEvent,
): void {
  expect(actual.type).toBe(expected.type);
  expect(actual.programId).toBe(expected.programId);
  expect(actual.invoiceId).toBe(expected.invoiceId);
  expectSameMoney(actual.delta, expected.delta);
  expectSameMoney(actual.resultingReserved, expected.resultingReserved);
  expect(actual.actor).toBe(expected.actor);
  expect(actual.source).toBe(expected.source);
  expect(actual.correlationId).toBe(expected.correlationId);
  expectSameInstant(actual.occurredAt, expected.occurredAt);
  expect(actual.metadata).toEqual(expected.metadata);
}

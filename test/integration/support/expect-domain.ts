import { type CapacityEvent } from '../../../src/capacity/domain/capacity-event';
import { type Money } from '../../../src/capacity/domain/money';
import { type Program } from '../../../src/capacity/domain/program';
import { type Reservation } from '../../../src/capacity/domain/reservation';
import { type FxRate } from '../../../src/fx/fx-rate';

/**
 * "The same object came back" — stated once, so every round-trip test says it the
 * same way.
 *
 * # Why these are functions and not `toEqual`
 *
 * `expect(loaded).toEqual(stored)` would compare two `Program` instances
 * structurally and pass on things this cycle exists to catch. A `Money` whose
 * `minorUnits` came back as the string `"100"` instead of the `bigint` `100n` is
 * not `toEqual` a `Money` holding `100n` — so that much it would catch — but a
 * `Date` compared field by field, a `#private` `asOf` that structural equality
 * cannot see at all, and MikroORM's own bookkeeping properties on a tracked entity
 * all make `toEqual` either too strict or blind in ways that are hard to predict
 * from reading the test.
 *
 * So each aggregate is compared through its own public surface, and every amount
 * goes through {@link expectSameMoney}, which asserts the **type** as well as the
 * value. `Money.equals` is the domain's own answer to "is this the same amount",
 * and `typeof minorUnits` is the assertion docs/PLAN.md 2.6 asks for: `pg` returns
 * a `BIGINT` as a string, `"100" + "50"` is `"10050"`, and a value that is right
 * while its type is wrong is a defect that surfaces as an exposure figure a tenth
 * or a thousandth of the truth.
 *
 * The aggregates have no `equals` of their own and this cycle may not add one to
 * committed domain code, which is the other reason these live here.
 */

/**
 * Two amounts are the same amount, **and** the loaded one is a `bigint`.
 *
 * The `toString()` comparison comes first so that a failure reads as
 * `"9235000.00 EUR" !== "9235.00 EUR"` rather than as `false !== true`.
 */
export function expectSameMoney(actual: Money, expected: Money): void {
  expect(actual.toString()).toBe(expected.toString());
  expect(actual.equals(expected)).toBe(true);
  expect(typeof actual.minorUnits).toBe('bigint');
}

/**
 * Two instants are the same instant, to the millisecond a `Date` can state.
 *
 * Compared as epoch milliseconds rather than as objects: `timestamptz` keeps
 * microseconds and a `Date` cannot, so equality has to be asserted at the
 * precision both sides actually carry — and every instant this suite stores is
 * whole milliseconds for exactly that reason.
 */
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
  // `toJSON` states the value as a string, so the type of the stored integer
  // would survive being wrong there; the column is a `BIGINT` like the amounts.
  expect(typeof actual!.scaledValue).toBe('bigint');
}

/**
 * A loaded program is the program that was stored — including the two figures it
 * derives, because `available` and `overUtilized` are what `GET /capacity`
 * answers with and an over-utilised program has to survive the round trip
 * (docs/PLAN.md 2.1, 2.4).
 */
export function expectSameProgram(actual: Program, expected: Program): void {
  expect(actual.id).toBe(expected.id);
  expect(actual.ownerOrgId).toBe(expected.ownerOrgId);
  expect(actual.currency).toBe(expected.currency);
  expectSameMoney(actual.creditLimit, expected.creditLimit);
  expectSameMoney(actual.reserved, expected.reserved);
  expectSameMoney(actual.available, expected.available);
  expect(actual.overUtilized).toBe(expected.overUtilized);
}

/**
 * A loaded reservation is the reservation that was stored, lifecycle and frozen
 * FX evidence included.
 */
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

/**
 * A loaded audit entry is the fact the domain produced, `metadata` included.
 *
 * `metadata` is compared with `toEqual`, which is strict about absent versus
 * `undefined` keys — deliberately: the domain drops a field it knows does not
 * apply rather than storing `null` for it (docs/PLAN.md 2.3, and
 * `withoutAbsentFields` in `program.ts`), so "no rate was ever needed" and "a rate
 * was looked for and missing" must not become the same jsonb document.
 */
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

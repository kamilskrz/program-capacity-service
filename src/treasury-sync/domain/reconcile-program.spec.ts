import {
  DEFAULT_CLOCK_SKEW_MARGIN_MS,
  InvalidReconciliationInputError,
  MAX_CLOCK_SKEW_MARGIN_MS,
  reconcileProgram,
  type Discrepancy,
  type ReconciliationInput,
  type ReconciliationOutcome,
  type ReconciliationPlan,
  type RejectionOrigin,
  type SnapshotRejection,
  type SnapshotRejectionReason,
  type TreasuryInvoice,
  type TreasuryInvoiceStatus,
  type TreasurySnapshot,
} from './reconcile-program';
import { type CurrencyCode } from '../../capacity/domain/currency';
import { CurrencyMismatchError } from '../../capacity/domain/errors';
import { Money } from '../../capacity/domain/money';
import { Program, type ProgramState } from '../../capacity/domain/program';
import {
  Reservation,
  type ReservationState,
} from '../../capacity/domain/reservation';
import { applyRate } from '../../fx/convert';
import { FxRate } from '../../fx/fx-rate';

const usd = (minorUnits: bigint): Money =>
  Money.fromMinorUnits(minorUnits, 'USD');
const eur = (minorUnits: bigint): Money =>
  Money.fromMinorUnits(minorUnits, 'EUR');

/** 10,000,000.00 USD — the program limit of docs/PLAN.md 1, in minor units. */
const LIMIT = 1_000_000_000n;

/** 2,500,000.00 USD: the amount the default hold carries. */
const HOLD = 250_000_000n;

/**
 * Two above `Number.MAX_SAFE_INTEGER`, as in cycle 2's tests. A program has no
 * business being near it — which is the point: neither the checksum sum nor the
 * projected total may acquire a cliff that `Money` does not have.
 */
const BEYOND_SAFE_INTEGER = 9_007_199_254_740_993n;

/** Treasury's instant. Every comparison in the in-flight rule is against this. */
const AS_OF = new Date('2026-02-01T12:00:00.000Z');

/** `AS_OF` less the default margin: the cutoff the boundary cases sit on. */
const CUTOFF = new Date(AS_OF.getTime() - DEFAULT_CLOCK_SKEW_MARGIN_MS);

/** Comfortably before the cutoff: a hold treasury has had every chance to see. */
const LONG_BEFORE = new Date('2026-01-15T10:32:00.000Z');

const at = (instant: Date, offsetMs: number): Date =>
  new Date(instant.getTime() + offsetMs);

/**
 * 1 EUR = 1.0987 USD. Chosen so that 100.00 EUR converts to exactly 109.87 USD
 * with nothing to round, which keeps the FX cases about the evidence rather than
 * about arithmetic — and so that 0.01 EUR converts to 0.02 USD, which is where a
 * producer rounding to nearest parts company with docs/PLAN.md 2.3.
 */
const USD_PER_EUR = FxRate.fromDecimalString({
  base: 'EUR',
  quote: 'USD',
  value: '1.0987',
  source: 'treasury',
  asOf: LONG_BEFORE,
});

const programOf = (overrides: Partial<ProgramState> = {}): Program =>
  Program.rehydrate({
    id: 'program-1',
    ownerOrgId: 'org-1',
    currency: 'USD',
    creditLimit: usd(LIMIT),
    reserved: usd(0n),
    ...overrides,
  });

/** A stored, active hold in `program-1`, by default for 2,500,000.00 USD. */
const activeHold = (overrides: Partial<ReservationState> = {}): Reservation => {
  const reservedAmount = overrides.reservedAmount ?? usd(HOLD);

  return Reservation.rehydrate({
    programId: 'program-1',
    invoiceId: 'invoice-1',
    status: 'ACTIVE',
    originalAmount: usd(HOLD),
    reservedAmount,
    // Follows the currency of the hold rather than pinning USD: a released
    // amount in another currency is a corrupt row, so a fixture that pinned it
    // would fail inside itself whenever a test overrode the held currency,
    // hiding whatever that test was actually about.
    releasedAmount: Money.zero(reservedAmount.currency),
    fxRate: null,
    reservedAt: LONG_BEFORE,
    releasedAt: null,
    releaseReason: null,
    ...overrides,
  });
};

/** The same hold, already released — the state this service considers closed. */
const releasedHold = (
  overrides: Partial<ReservationState> = {},
): Reservation => {
  const reservedAmount = overrides.reservedAmount ?? usd(HOLD);

  return activeHold({
    status: 'RELEASED',
    reservedAmount,
    // A released hold has given back everything it held, in the same currency.
    releasedAmount: reservedAmount,
    releasedAt: at(LONG_BEFORE, 3_600_000),
    releaseReason: 'REPAID',
    ...overrides,
  });
};

/**
 * A row as MikroORM hands one back: hydrated **without** calling the constructor
 * (docs/PLAN.md 2.6), so the factory guards cycle 2 relies on never ran.
 *
 * This is the only way to build the corrupt rows the cases below need —
 * `Reservation.rehydrate` and `Program.rehydrate` both refuse every one of them —
 * and it is not a contrivance: it is the path a stored row actually takes into the
 * domain, which is exactly why `reservation.ts` re-checks what it depends on
 * instead of trusting that construction validated it.
 */
const hydratedAround = <T extends object>(
  entity: T,
  storedFields: Record<string, unknown>,
): T => Object.assign(entity, storedFields);

/** What a `timestamp` column holds when nothing readable was written to it. */
const UNREADABLE_INSTANT = new Date('not an instant');

/** An active hold whose stored `reservedAt` cannot be read. */
const holdTakenAtAnUnreadableInstant = (
  overrides: Partial<ReservationState> = {},
): Reservation =>
  hydratedAround(activeHold(overrides), { _reservedAt: UNREADABLE_INSTANT });

/** A released hold whose stored `releasedAt` cannot be read. */
const holdReleasedAtAnUnreadableInstant = (
  overrides: Partial<ReservationState> = {},
): Reservation =>
  hydratedAround(releasedHold(overrides), { _releasedAt: UNREADABLE_INSTANT });

/** A released hold that does not record when it was released at all. */
const holdReleasedAtNoInstant = (
  overrides: Partial<ReservationState> = {},
): Reservation =>
  hydratedAround(releasedHold(overrides), { _releasedAt: null });

/** A program whose stored counter is in a currency the program does not use. */
const programCountingIn = (reserved: Money): Program =>
  hydratedAround(programOf(), { _reserved: reserved });

const outstanding = (
  invoiceId: string,
  amount: Money,
  overrides: Partial<TreasuryInvoice> = {},
): TreasuryInvoice => ({
  invoiceId,
  status: 'OUTSTANDING',
  amount,
  originalAmount: amount,
  rate: null,
  ...overrides,
});

const repaid = (
  invoiceId: string,
  amount: Money,
  overrides: Partial<TreasuryInvoice> = {},
): TreasuryInvoice => ({
  invoiceId,
  status: 'REPAID',
  amount,
  originalAmount: amount,
  rate: null,
  ...overrides,
});

/**
 * Sums one status's entries the way a well-behaved producer would, so that a
 * test only states a checksum when that checksum is what it is about.
 *
 * Entries in another currency are skipped rather than summed: `Money.add`
 * refuses to mix currencies, and the tests that put a foreign amount in a
 * snapshot state the checksums themselves anyway.
 */
const totalOf = (
  invoices: readonly TreasuryInvoice[],
  status: TreasuryInvoiceStatus,
  fallbackCurrency: CurrencyCode,
): Money => {
  const amounts = invoices
    .filter((invoice) => invoice.status === status)
    .map((invoice) => invoice.amount);
  const currency = amounts[0]?.currency ?? fallbackCurrency;

  return amounts
    .filter((amount) => amount.currency === currency)
    .reduce((total, amount) => total.add(amount), Money.zero(currency));
};

const countOf = (
  invoices: readonly TreasuryInvoice[],
  status: TreasuryInvoiceStatus,
): number => invoices.filter((invoice) => invoice.status === status).length;

const snapshotOf = (
  overrides: Partial<TreasurySnapshot> = {},
): TreasurySnapshot => {
  const invoices = overrides.invoices ?? [];
  const creditLimit = overrides.creditLimit ?? usd(LIMIT);

  return {
    programId: 'program-1',
    sequence: 7,
    asOf: AS_OF,
    creditLimit,
    outstandingTotal: totalOf(invoices, 'OUTSTANDING', creditLimit.currency),
    invoiceCount: countOf(invoices, 'OUTSTANDING'),
    repaidTotal: totalOf(invoices, 'REPAID', creditLimit.currency),
    repaidCount: countOf(invoices, 'REPAID'),
    ...overrides,
    invoices,
  };
};

const reconcile = (
  overrides: Partial<ReconciliationInput> = {},
): ReconciliationOutcome =>
  reconcileProgram({
    program: programOf(),
    reservations: [],
    snapshot: snapshotOf(),
    appliedSequence: 6,
    ...overrides,
  });

/** Asserts the snapshot was accepted and hands the plan over for inspection. */
function applied(outcome: ReconciliationOutcome): ReconciliationPlan {
  if (outcome.verdict === 'APPLY') {
    return outcome;
  }

  throw new Error(
    `expected the snapshot to be applied, but it was rejected as ${outcome.reason}: ${outcome.detail}`,
  );
}

/** Asserts the snapshot was thrown away and hands the rejection over. */
function rejected(outcome: ReconciliationOutcome): SnapshotRejection {
  if (outcome.verdict === 'REJECT') {
    return outcome;
  }

  throw new Error(
    `expected the snapshot to be rejected, but it produced a plan with ${outcome.steps.length} step(s)`,
  );
}

/**
 * The plan as a reviewer would read it: one line per step, in application order.
 * Every ordering and content assertion goes through this, so a failure names the
 * decision rather than an index into an array of objects.
 */
const outline = (plan: ReconciliationPlan): string[] =>
  plan.steps.map((step) => {
    switch (step.action) {
      case 'RELEASE':
        return `RELEASE ${step.invoiceId} (${step.reason})`;
      case 'CORRECT':
        return `CORRECT ${step.invoiceId} from ${step.heldAmount.toDecimalString()} to ${step.correctedAmount.toDecimalString()}`;
      case 'CREATE':
        return `CREATE ${step.invoiceId} for ${step.amount.converted.toDecimalString()}`;
      case 'CHANGE_LIMIT':
        return `CHANGE_LIMIT to ${step.creditLimit.toDecimalString()}`;
    }
  });

const flagged = (plan: ReconciliationPlan): string[] =>
  plan.discrepancies.map(
    (discrepancy) => `${discrepancy.reason} ${discrepancy.invoiceId}`,
  );

/** What each step does to the reserved total, in the program's currency. */
const deltaOf = (
  step: ReconciliationPlan['steps'][number],
  currency: CurrencyCode,
): Money => {
  switch (step.action) {
    case 'RELEASE':
      return step.reservation.outstandingAmount.negate();
    case 'CORRECT':
      return step.correctedAmount.subtract(step.heldAmount);
    case 'CREATE':
      return step.amount.converted;
    case 'CHANGE_LIMIT':
      return Money.zero(currency);
  }
};

/**
 * The reserved total after each step, starting from `start` — the intermediate
 * states cycle 8 will actually pass through inside its transaction.
 */
const runningTotals = (plan: ReconciliationPlan, start: Money): Money[] => {
  const totals: Money[] = [];
  let total = start;

  for (const step of plan.steps) {
    total = total.add(deltaOf(step, start.currency));
    totals.push(total);
  }

  return totals;
};

const only = (plan: ReconciliationPlan): Discrepancy => {
  expect(plan.discrepancies).toHaveLength(1);

  return plan.discrepancies[0]!;
};

/** Runs `act`, asserting it threw `type`, and hands the error back. */
function thrown<T>(
  type: abstract new (...args: never[]) => T,
  act: () => unknown,
): T {
  try {
    act();
  } catch (error) {
    if (error instanceof type) {
      return error;
    }
    throw error;
  }

  throw new Error(`expected ${type.name} to be thrown, but nothing was`);
}

describe('reconcileProgram', () => {
  describe('the sequence watermark', () => {
    const cases: {
      situation: string;
      sequence: number;
      appliedSequence: number | null;
      verdict: string;
    }[] = [
      {
        situation: 'follows the applied one',
        sequence: 7,
        appliedSequence: 6,
        verdict: 'APPLY',
      },
      {
        situation:
          'skips ahead of the applied one, because a gap does not halt processing',
        sequence: 99,
        appliedSequence: 6,
        verdict: 'APPLY',
      },
      {
        situation: 'equals the applied one',
        sequence: 6,
        appliedSequence: 6,
        verdict: 'REJECT',
      },
      {
        situation: 'precedes the applied one',
        sequence: 5,
        appliedSequence: 6,
        verdict: 'REJECT',
      },
      {
        situation: 'arrives at a program that has never been reconciled',
        sequence: 1,
        appliedSequence: null,
        verdict: 'APPLY',
      },
      {
        situation: 'is zero at a program that has never been reconciled',
        sequence: 0,
        appliedSequence: null,
        verdict: 'APPLY',
      },
      {
        situation: 'is zero at a program that already applied zero',
        sequence: 0,
        appliedSequence: 0,
        verdict: 'REJECT',
      },
    ];

    it.each(cases)(
      'answers $verdict for a snapshot whose sequence $situation',
      ({ sequence, appliedSequence, verdict }) => {
        expect(
          reconcile({ snapshot: snapshotOf({ sequence }), appliedSequence })
            .verdict,
        ).toBe(verdict);
      },
    );

    it('calls a superseded snapshot stale, which is routine rather than a data fault', () => {
      expect(
        rejected(reconcile({ snapshot: snapshotOf({ sequence: 5 }) })).reason,
      ).toBe('STALE_SEQUENCE');
    });

    it('reports both sequences, so a log line says what was ignored and why', () => {
      const rejection = rejected(
        reconcile({
          snapshot: snapshotOf({ sequence: 5 }),
          appliedSequence: 6,
        }),
      );

      expect([rejection.sequence, rejection.appliedSequence]).toEqual([5, 6]);
    });

    it('reports a null watermark as null rather than as zero', () => {
      const outcome = applied(reconcile({ appliedSequence: null }));

      expect(outcome.appliedSequence).toBe(7);
    });

    it('advances the watermark to the snapshot it applied', () => {
      expect(
        applied(reconcile({ snapshot: snapshotOf({ sequence: 42 }) }))
          .appliedSequence,
      ).toBe(42);
    });

    it('advances the watermark even when the snapshot agrees with us in every particular', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold()],
          snapshot: snapshotOf({
            sequence: 8,
            invoices: [outstanding('invoice-1', usd(HOLD))],
          }),
        }),
      );

      expect([plan.steps, plan.discrepancies, plan.appliedSequence]).toEqual([
        [],
        [],
        8,
      ]);
    });

    const unusable: { why: string; sequence: number }[] = [
      { why: 'is not a number at all', sequence: Number.NaN },
      { why: 'is fractional', sequence: 7.5 },
      { why: 'is negative', sequence: -1 },
      { why: 'is infinite', sequence: Number.POSITIVE_INFINITY },
      {
        why: 'is past the range a number counts in ones',
        sequence: Number.MAX_SAFE_INTEGER + 1,
      },
    ];

    it.each(unusable)(
      'rejects a snapshot whose sequence $why as unusable rather than as fresh',
      ({ sequence }) => {
        expect(
          rejected(reconcile({ snapshot: snapshotOf({ sequence }) })).reason,
        ).toBe('UNUSABLE_SEQUENCE');
      },
    );

    it('judges an unusable sequence before the watermark, which every such value would pass', () => {
      // NaN <= 6 is false, so an unchecked comparison reads this as newer than
      // anything applied — and then stores it as the watermark.
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({ sequence: Number.NaN }),
            appliedSequence: 6,
          }),
        ).reason,
      ).toBe('UNUSABLE_SEQUENCE');
    });
  });

  /**
   * The one fault that is ours rather than treasury's: `program.reserved` against
   * the sum of the active holds, the invariant of docs/PLAN.md 2.4.
   *
   * Both directions of the drift are here because they fail differently. A
   * counter that is too low makes a plan that cannot be applied at all — the
   * correction below projects −0.99, which `Program` refuses and which then
   * refuses every snapshot after it, for ever. A counter that is too high is
   * worse: nothing throws, the diff finds nothing to do, and the snapshot is
   * recorded as applied while the figure clients read stays wrong.
   */
  describe('rejecting a snapshot because our own counter has drifted', () => {
    /** One hold of 1.00 USD, with the counter claiming whatever `reserved` says. */
    const drifted = (
      reserved: bigint,
      invoices: TreasuryInvoice[] = [],
    ): ReconciliationOutcome =>
      reconcile({
        program: programOf({ reserved: usd(reserved) }),
        reservations: [
          activeHold({
            originalAmount: usd(100n),
            reservedAmount: usd(100n),
          }),
        ],
        snapshot: snapshotOf({ invoices }),
      });

    it('rejects a counter that is short of the holds it is supposed to sum', () => {
      expect(rejected(drifted(0n)).reason).toBe('COUNTER_DRIFT');
    });

    it('rejects a counter that is over the holds it is supposed to sum', () => {
      expect(rejected(drifted(500n)).reason).toBe('COUNTER_DRIFT');
    });

    it('rejects a drift of a single minor unit, because an invariant holds or it does not', () => {
      expect(rejected(drifted(101n)).reason).toBe('COUNTER_DRIFT');
    });

    it('applies a snapshot when the counter agrees exactly', () => {
      expect(
        applied(drifted(100n, [outstanding('invoice-1', usd(100n))])).steps,
      ).toEqual([]);
    });

    it('refuses the correction that would project a negative reserved total', () => {
      // The reviewer's case: one hold of 1.00 against a counter of 0.00,
      // corrected to 1.01, projects -0.99 — which Program refuses, and which
      // every later snapshot would go on projecting.
      expect(
        rejected(drifted(0n, [outstanding('invoice-1', usd(101n))])).reason,
      ).toBe('COUNTER_DRIFT');
    });

    it('refuses the drift that would otherwise reconcile completely clean', () => {
      // The worse case: the snapshot agrees with the holds in every particular,
      // so nothing is planned, nothing is flagged, and the snapshot would be
      // recorded as applied over a counter of 5.00 that carries holds of 2.00.
      expect(
        rejected(
          reconcile({
            program: programOf({ reserved: usd(500n) }),
            reservations: [
              activeHold({
                invoiceId: 'invoice-1',
                originalAmount: usd(100n),
                reservedAmount: usd(100n),
              }),
              activeHold({
                invoiceId: 'invoice-2',
                originalAmount: usd(100n),
                reservedAmount: usd(100n),
              }),
            ],
            snapshot: snapshotOf({
              invoices: [
                outstanding('invoice-1', usd(100n)),
                outstanding('invoice-2', usd(100n)),
              ],
            }),
          }),
        ).reason,
      ).toBe('COUNTER_DRIFT');
    });

    it('sums the active holds only, so a released one is not expected to carry anything', () => {
      expect(
        applied(
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [
              activeHold({ invoiceId: 'invoice-1' }),
              releasedHold({ invoiceId: 'invoice-2' }),
            ],
            snapshot: snapshotOf({
              invoices: [outstanding('invoice-1', usd(HOLD))],
            }),
          }),
        ).verdict,
      ).toBe('APPLY');
    });

    it('rejects a counter that still carries a released hold', () => {
      expect(
        rejected(
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [releasedHold()],
          }),
        ).reason,
      ).toBe('COUNTER_DRIFT');
    });

    it('rejects a counter that carries something while the program holds nothing', () => {
      expect(
        rejected(reconcile({ program: programOf({ reserved: usd(1n) }) }))
          .reason,
      ).toBe('COUNTER_DRIFT');
    });

    it('applies a snapshot for a program that holds nothing and says so', () => {
      expect(applied(reconcile()).verdict).toBe('APPLY');
    });

    it('sums exactly past the range a JS number holds', () => {
      const holds = [
        activeHold({
          invoiceId: 'invoice-1',
          originalAmount: usd(BEYOND_SAFE_INTEGER),
          reservedAmount: usd(BEYOND_SAFE_INTEGER),
          reservedAt: AS_OF,
        }),
        activeHold({
          invoiceId: 'invoice-2',
          originalAmount: usd(BEYOND_SAFE_INTEGER),
          reservedAmount: usd(BEYOND_SAFE_INTEGER),
          reservedAt: AS_OF,
        }),
      ];

      expect(
        applied(
          reconcile({
            program: programOf({
              creditLimit: usd(BEYOND_SAFE_INTEGER * 4n),
              reserved: usd(BEYOND_SAFE_INTEGER * 2n),
            }),
            reservations: holds,
            snapshot: snapshotOf({
              creditLimit: usd(BEYOND_SAFE_INTEGER * 4n),
            }),
          }),
        ).verdict,
      ).toBe('APPLY');
    });

    it('notices a single minor unit of drift past that range', () => {
      expect(
        rejected(
          reconcile({
            program: programOf({
              creditLimit: usd(BEYOND_SAFE_INTEGER * 4n),
              reserved: usd(BEYOND_SAFE_INTEGER + 1n),
            }),
            reservations: [
              activeHold({
                originalAmount: usd(BEYOND_SAFE_INTEGER),
                reservedAmount: usd(BEYOND_SAFE_INTEGER),
                reservedAt: AS_OF,
              }),
            ],
            snapshot: snapshotOf({
              creditLimit: usd(BEYOND_SAFE_INTEGER * 4n),
            }),
          }),
        ).reason,
      ).toBe('COUNTER_DRIFT');
    });

    it('heals nothing: it applies no step and flags no discrepancy', () => {
      // Silent healing would erase the evidence of whatever wrote the wrong
      // figure (docs/PLAN.md 2.1), so the answer is the same nothing every
      // rejection is.
      const rejection = rejected(drifted(0n));

      expect(Object.keys(rejection).sort()).toEqual([
        'appliedSequence',
        'detail',
        'origin',
        'reason',
        'sequence',
        'verdict',
      ]);
    });

    it('names the figures that disagree, since somebody has to go and look', () => {
      expect(rejected(drifted(0n)).detail.length).toBeGreaterThan(0);
    });

    it('is a data fault rather than the routine rejection', () => {
      expect(rejected(drifted(0n)).reason).not.toBe('STALE_SEQUENCE');
    });

    it('reports the sequence it refused and the watermark it was judged against', () => {
      const rejection = rejected(drifted(0n));

      expect([rejection.sequence, rejection.appliedSequence]).toEqual([7, 6]);
    });

    it('keeps the watermark where it was, so the next snapshot is judged fresh', () => {
      // Nothing was applied, so nothing may advance: a drifted program must
      // reconcile properly the moment the counter is fixed.
      expect(rejected(drifted(0n)).appliedSequence).toBe(6);
    });
  });

  describe('rejecting a snapshot whose checksums do not match', () => {
    const invoices = [
      outstanding('invoice-1', usd(HOLD)),
      outstanding('invoice-2', usd(100_000_000n)),
    ];

    const mismatches: { why: string; snapshot: Partial<TreasurySnapshot> }[] = [
      {
        why: 'the total is short by a minor unit',
        snapshot: { outstandingTotal: usd(HOLD + 100_000_000n - 1n) },
      },
      {
        why: 'the total is over by a minor unit',
        snapshot: { outstandingTotal: usd(HOLD + 100_000_000n + 1n) },
      },
      {
        why: 'the total is zero on a non-empty list',
        snapshot: { outstandingTotal: usd(0n) },
      },
      { why: 'the count is one too few', snapshot: { invoiceCount: 1 } },
      { why: 'the count is one too many', snapshot: { invoiceCount: 3 } },
      {
        why: 'the count is zero on a non-empty list',
        snapshot: { invoiceCount: 0 },
      },
    ];

    it.each(mismatches)(
      'rejects the whole snapshot when $why',
      ({ snapshot }) => {
        expect(
          rejected(
            reconcile({ snapshot: snapshotOf({ invoices, ...snapshot }) }),
          ).reason,
        ).toBe('CHECKSUM_MISMATCH');
      },
    );

    it('rejects a snapshot whose total adds up while the count does not', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices,
              outstandingTotal: usd(HOLD + 100_000_000n),
              invoiceCount: 5,
            }),
          }),
        ).reason,
      ).toBe('CHECKSUM_MISMATCH');
    });

    it('rejects a snapshot whose count is right while the total is not', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices,
              outstandingTotal: usd(1n),
              invoiceCount: 2,
            }),
          }),
        ).reason,
      ).toBe('CHECKSUM_MISMATCH');
    });

    it('accepts an empty list whose checksums are empty too', () => {
      expect(
        applied(
          reconcile({
            snapshot: snapshotOf({
              invoices: [],
              outstandingTotal: usd(0n),
              invoiceCount: 0,
            }),
          }),
        ).steps,
      ).toEqual([]);
    });

    it('rejects an empty list that claims to carry an outstanding total', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices: [],
              outstandingTotal: usd(1n),
              invoiceCount: 0,
            }),
          }),
        ).reason,
      ).toBe('CHECKSUM_MISMATCH');
    });

    it('leaves repaid entries out of both checksums, since they are outstanding nothing', () => {
      expect(
        applied(
          reconcile({
            reservations: [activeHold()],
            program: programOf({ reserved: usd(HOLD) }),
            snapshot: snapshotOf({
              invoices: [
                repaid('invoice-1', usd(HOLD)),
                outstanding('invoice-2', usd(100_000_000n)),
              ],
              outstandingTotal: usd(100_000_000n),
              invoiceCount: 1,
            }),
          }),
        ).verdict,
      ).toBe('APPLY');
    });

    it('rejects a snapshot that counts its repaid entries as outstanding', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices: [
                repaid('invoice-1', usd(HOLD)),
                outstanding('invoice-2', usd(100_000_000n)),
              ],
              outstandingTotal: usd(HOLD + 100_000_000n),
              invoiceCount: 2,
            }),
          }),
        ).reason,
      ).toBe('CHECKSUM_MISMATCH');
    });

    it('sums exactly past the range a JS number holds', () => {
      const first = usd(BEYOND_SAFE_INTEGER);
      const second = usd(BEYOND_SAFE_INTEGER);

      expect(
        applied(
          reconcile({
            snapshot: snapshotOf({
              invoices: [
                outstanding('invoice-1', first),
                outstanding('invoice-2', second),
              ],
              outstandingTotal: usd(BEYOND_SAFE_INTEGER * 2n),
              invoiceCount: 2,
            }),
          }),
        ).steps,
      ).toHaveLength(2);
    });

    it('notices a single minor unit missing from a total past that range', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices: [
                outstanding('invoice-1', usd(BEYOND_SAFE_INTEGER)),
                outstanding('invoice-2', usd(BEYOND_SAFE_INTEGER)),
              ],
              outstandingTotal: usd(BEYOND_SAFE_INTEGER * 2n - 1n),
              invoiceCount: 2,
            }),
          }),
        ).reason,
      ).toBe('CHECKSUM_MISMATCH');
    });

    /**
     * The repaid pair, which is the only integrity check standing in front of the
     * one path that *frees* capacity (docs/PLAN.md 2.2). Verified exactly as the
     * outstanding pair is, and for a sharper reason: an outstanding entry that
     * slips through overstates or understates exposure, while a repaid entry that
     * slips through hands the limit back.
     */
    describe('over the repaid entries', () => {
      /** One hold of 9,000,000.00 USD — the whole program, nearly. */
      const wholeProgram = 900_000_000n;

      const releasing = (
        snapshot: Partial<TreasurySnapshot>,
      ): ReconciliationOutcome =>
        reconcile({
          program: programOf({ reserved: usd(wholeProgram) }),
          reservations: [
            activeHold({
              originalAmount: usd(wholeProgram),
              reservedAmount: usd(wholeProgram),
            }),
          ],
          snapshot: snapshotOf(snapshot),
        });

      it('rejects the fabricated repaid entry that no other checksum covers', () => {
        // The reviewer's case: the outstanding pair is correct precisely by
        // ignoring the entry, so without a repaid pair this frees 9,000,000.00.
        expect(
          rejected(
            releasing({
              invoices: [repaid('invoice-1', usd(1n))],
              outstandingTotal: usd(0n),
              invoiceCount: 0,
              repaidTotal: usd(0n),
              repaidCount: 0,
            }),
          ).reason,
        ).toBe('CHECKSUM_MISMATCH');
      });

      it('frees the hold when the repaid pair accounts for the entry', () => {
        expect(
          outline(
            applied(
              releasing({
                invoices: [repaid('invoice-1', usd(wholeProgram))],
                repaidTotal: usd(wholeProgram),
                repaidCount: 1,
              }),
            ),
          ),
        ).toEqual(['RELEASE invoice-1 (REPAID)']);
      });

      const mismatched: { why: string; snapshot: Partial<TreasurySnapshot> }[] =
        [
          {
            why: 'the repaid total is short by a minor unit',
            snapshot: { repaidTotal: usd(wholeProgram - 1n), repaidCount: 1 },
          },
          {
            why: 'the repaid total is over by a minor unit',
            snapshot: { repaidTotal: usd(wholeProgram + 1n), repaidCount: 1 },
          },
          {
            why: 'the repaid count is one too few',
            snapshot: { repaidTotal: usd(wholeProgram), repaidCount: 0 },
          },
          {
            why: 'the repaid count is one too many',
            snapshot: { repaidTotal: usd(wholeProgram), repaidCount: 2 },
          },
          {
            why: 'the repaid total adds up while the count does not',
            snapshot: { repaidTotal: usd(wholeProgram), repaidCount: 7 },
          },
          {
            why: 'the repaid count is right while the total is not',
            snapshot: { repaidTotal: usd(0n), repaidCount: 1 },
          },
        ];

      it.each(mismatched)(
        'rejects the whole snapshot, and frees nothing, when $why',
        ({ snapshot }) => {
          expect(
            rejected(
              releasing({
                invoices: [repaid('invoice-1', usd(wholeProgram))],
                ...snapshot,
              }),
            ).reason,
          ).toBe('CHECKSUM_MISMATCH');
        },
      );

      it('rejects a snapshot whose outstanding pair adds up while its repaid pair does not', () => {
        expect(
          rejected(
            releasing({
              invoices: [
                repaid('invoice-1', usd(wholeProgram)),
                outstanding('invoice-9', usd(100_000n)),
              ],
              outstandingTotal: usd(100_000n),
              invoiceCount: 1,
              repaidTotal: usd(1n),
              repaidCount: 1,
            }),
          ).reason,
        ).toBe('CHECKSUM_MISMATCH');
      });

      it('accepts both pairs empty on an empty list', () => {
        expect(
          applied(
            reconcile({
              snapshot: snapshotOf({
                invoices: [],
                outstandingTotal: usd(0n),
                invoiceCount: 0,
                repaidTotal: usd(0n),
                repaidCount: 0,
              }),
            }),
          ).steps,
        ).toEqual([]);
      });

      it('rejects an empty list that claims to have repaid something', () => {
        expect(
          rejected(
            reconcile({
              snapshot: snapshotOf({
                invoices: [],
                repaidTotal: usd(1n),
                repaidCount: 0,
              }),
            }),
          ).reason,
        ).toBe('CHECKSUM_MISMATCH');
      });

      it('rejects a repaid total stated in another currency', () => {
        expect(
          rejected(
            reconcile({ snapshot: snapshotOf({ repaidTotal: eur(0n) }) }),
          ).reason,
        ).toBe('FOREIGN_CURRENCY');
      });

      it('sums the repaid entries exactly past the range a JS number holds', () => {
        expect(
          applied(
            reconcile({
              snapshot: snapshotOf({
                invoices: [
                  repaid('invoice-1', usd(BEYOND_SAFE_INTEGER)),
                  repaid('invoice-2', usd(BEYOND_SAFE_INTEGER)),
                ],
                repaidTotal: usd(BEYOND_SAFE_INTEGER * 2n),
                repaidCount: 2,
              }),
            }),
          ).steps,
        ).toEqual([]);
      });

      it('notices a single minor unit missing from a repaid total past that range', () => {
        expect(
          rejected(
            reconcile({
              snapshot: snapshotOf({
                invoices: [
                  repaid('invoice-1', usd(BEYOND_SAFE_INTEGER)),
                  repaid('invoice-2', usd(BEYOND_SAFE_INTEGER)),
                ],
                repaidTotal: usd(BEYOND_SAFE_INTEGER * 2n - 1n),
                repaidCount: 2,
              }),
            }),
          ).reason,
        ).toBe('CHECKSUM_MISMATCH');
      });
    });
  });

  /**
   * A negative entry amount does not make a checksum uncomputable, the way a
   * foreign one does — it makes it unable to fail, which is worse. So it takes the
   * whole snapshot down on the same argument.
   */
  describe('rejecting a snapshot whose entries make its checksums a lie', () => {
    it('rejects two entries that cancel inside a total the snapshot states correctly', () => {
      // The reviewer's case: the pair verifies a list claiming a supplier owes
      // the funder money, and any amount of real exposure could hide behind it.
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices: [
                outstanding('invoice-a', usd(1_000_000n)),
                outstanding('invoice-b', usd(-1_000_000n)),
              ],
              outstandingTotal: usd(0n),
              invoiceCount: 2,
            }),
          }),
        ).reason,
      ).toBe('NEGATIVE_AMOUNT');
    });

    it('rejects a single negative outstanding entry even when the total states it honestly', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices: [outstanding('invoice-9', usd(-1n))],
              outstandingTotal: usd(-1n),
              invoiceCount: 1,
            }),
          }),
        ).reason,
      ).toBe('NEGATIVE_AMOUNT');
    });

    it('rejects a negative amount reported against a hold we have', () => {
      expect(
        rejected(
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [activeHold()],
            snapshot: snapshotOf({
              invoices: [outstanding('invoice-1', usd(-1n))],
            }),
          }),
        ).reason,
      ).toBe('NEGATIVE_AMOUNT');
    });

    it('rejects a negative repaid amount, which the repaid pair sums just the same', () => {
      expect(
        rejected(
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [activeHold()],
            snapshot: snapshotOf({
              invoices: [repaid('invoice-1', usd(-1n))],
            }),
          }),
        ).reason,
      ).toBe('NEGATIVE_AMOUNT');
    });

    it('accepts an amount of zero, which cancels nothing and is flagged on its own', () => {
      expect(
        flagged(
          applied(
            reconcile({
              snapshot: snapshotOf({
                invoices: [outstanding('invoice-9', usd(0n))],
              }),
            }),
          ),
        ),
      ).toEqual(['UNUSABLE_AMOUNT invoice-9']);
    });

    it('flags a negative original amount rather than rejecting, since no checksum sums it', () => {
      // The original is evidence about the invoice, not a figure the snapshot
      // adds up, so one contradictory entry stays one contradictory entry.
      expect(
        flagged(
          applied(
            reconcile({
              snapshot: snapshotOf({
                invoices: [
                  outstanding('invoice-9', usd(100_000n), {
                    originalAmount: eur(-1n),
                    rate: USD_PER_EUR,
                  }),
                ],
              }),
            }),
          ),
        ),
      ).toEqual(['INCONSISTENT_FX_EVIDENCE invoice-9']);
    });
  });

  describe('rejecting a snapshot that cannot be applied at all', () => {
    it('rejects a snapshot describing another program', () => {
      expect(
        rejected(
          reconcile({ snapshot: snapshotOf({ programId: 'program-2' }) }),
        ).reason,
      ).toBe('WRONG_PROGRAM');
    });

    it('rejects a snapshot whose asOf cannot be read', () => {
      // Every comparison against NaN is false, so an unchecked asOf would sort
      // every hold as older than the snapshot and flag the lot.
      expect(
        rejected(
          reconcile({ snapshot: snapshotOf({ asOf: new Date('not a date') }) }),
        ).reason,
      ).toBe('UNREADABLE_AS_OF');
    });

    it('rejects a negative credit limit rather than letting Program refuse it mid-transaction', () => {
      expect(
        rejected(reconcile({ snapshot: snapshotOf({ creditLimit: usd(-1n) }) }))
          .reason,
      ).toBe('UNUSABLE_LIMIT');
    });

    it('accepts a credit limit of zero, which is how a program is suspended', () => {
      expect(
        outline(
          applied(
            reconcile({ snapshot: snapshotOf({ creditLimit: usd(0n) }) }),
          ),
        ),
      ).toEqual(['CHANGE_LIMIT to 0.00']);
    });

    it('rejects a limit stated in another currency', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              creditLimit: eur(LIMIT),
              outstandingTotal: usd(0n),
            }),
          }),
        ).reason,
      ).toBe('FOREIGN_CURRENCY');
    });

    it('rejects a checksum total stated in another currency', () => {
      expect(
        rejected(
          reconcile({ snapshot: snapshotOf({ outstandingTotal: eur(0n) }) }),
        ).reason,
      ).toBe('FOREIGN_CURRENCY');
    });

    it('rejects an entry whose outstanding amount is in another currency', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices: [outstanding('invoice-9', eur(100_000n))],
              outstandingTotal: usd(100_000n),
              invoiceCount: 1,
            }),
          }),
        ).reason,
      ).toBe('FOREIGN_CURRENCY');
    });

    it('rejects a repaid entry in another currency too, since nothing in a snapshot may be unsummable', () => {
      expect(
        rejected(
          reconcile({
            reservations: [activeHold()],
            program: programOf({ reserved: usd(HOLD) }),
            snapshot: snapshotOf({
              invoices: [repaid('invoice-1', eur(HOLD))],
              outstandingTotal: usd(0n),
              invoiceCount: 0,
            }),
          }),
        ).reason,
      ).toBe('FOREIGN_CURRENCY');
    });

    it('accepts an original amount in another currency, which is the point of recording it', () => {
      expect(
        outline(
          applied(
            reconcile({
              snapshot: snapshotOf({
                invoices: [
                  outstanding('invoice-9', usd(10_987n), {
                    originalAmount: eur(10_000n),
                    rate: USD_PER_EUR,
                  }),
                ],
              }),
            }),
          ),
        ),
      ).toEqual(['CREATE invoice-9 for 109.87']);
    });

    it.each(['', '   ', '\t'])(
      'rejects the whole snapshot for the unidentifiable invoice id %p',
      (invoiceId) => {
        expect(
          rejected(
            reconcile({
              snapshot: snapshotOf({
                invoices: [outstanding(invoiceId, usd(100_000n))],
              }),
            }),
          ).reason,
        ).toBe('BLANK_INVOICE_ID');
      },
    );

    it('rejects a snapshot that lists the same invoice twice', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices: [
                outstanding('invoice-9', usd(100_000n)),
                outstanding('invoice-9', usd(200_000n)),
              ],
            }),
          }),
        ).reason,
      ).toBe('DUPLICATE_INVOICE');
    });

    it('rejects a duplicate even when the two entries agree, rather than silently deduplicating', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices: [
                outstanding('invoice-9', usd(100_000n)),
                outstanding('invoice-9', usd(100_000n)),
              ],
            }),
          }),
        ).reason,
      ).toBe('DUPLICATE_INVOICE');
    });

    it('rejects a duplicate that differs only in status, where the diff would contradict itself', () => {
      expect(
        rejected(
          reconcile({
            reservations: [activeHold()],
            program: programOf({ reserved: usd(HOLD) }),
            snapshot: snapshotOf({
              invoices: [
                outstanding('invoice-1', usd(HOLD)),
                repaid('invoice-1', usd(HOLD)),
              ],
            }),
          }),
        ).reason,
      ).toBe('DUPLICATE_INVOICE');
    });

    it('treats two spellings of one invoice id as the duplicate they are', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices: [
                outstanding('invoice-9', usd(100_000n)),
                outstanding('  invoice-9 ', usd(100_000n)),
              ],
            }),
          }),
        ).reason,
      ).toBe('DUPLICATE_INVOICE');
    });

    it('applies no step and flags nothing when it rejects', () => {
      const rejection = rejected(
        reconcile({
          reservations: [activeHold()],
          program: programOf({ reserved: usd(HOLD) }),
          snapshot: snapshotOf({
            sequence: 5,
            creditLimit: usd(400_000_000n),
            invoices: [repaid('invoice-1', usd(HOLD))],
          }),
        }),
      );

      expect(Object.keys(rejection).sort()).toEqual([
        'appliedSequence',
        'detail',
        'origin',
        'reason',
        'sequence',
        'verdict',
      ]);
    });

    it('says which figures did not add up, for the log line and the DLQ envelope', () => {
      expect(
        rejected(
          reconcile({ snapshot: snapshotOf({ outstandingTotal: usd(1n) }) }),
        ).detail.length,
      ).toBeGreaterThan(0);
    });
  });

  describe('the order the gates are applied in', () => {
    it('calls a stale snapshot stale even when its checksums are also wrong', () => {
      // Routine in, routine out: a snapshot we have already superseded must not
      // be able to raise an alarm about data a later one has corrected.
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              sequence: 6,
              invoices: [outstanding('invoice-9', usd(100_000n))],
              outstandingTotal: usd(1n),
              invoiceCount: 9,
            }),
          }),
        ).reason,
      ).toBe('STALE_SEQUENCE');
    });

    it('calls a stale snapshot stale even when it lists an invoice twice', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              sequence: 2,
              invoices: [
                outstanding('invoice-9', usd(100_000n)),
                outstanding('invoice-9', usd(100_000n)),
              ],
            }),
          }),
        ).reason,
      ).toBe('STALE_SEQUENCE');
    });

    it('names the wrong program before it looks at the sequence', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({ programId: 'program-2', sequence: 1 }),
          }),
        ).reason,
      ).toBe('WRONG_PROGRAM');
    });

    it('names a duplicate invoice before summing a list it cannot sum meaningfully', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices: [
                outstanding('invoice-9', usd(100_000n)),
                outstanding('invoice-9', usd(100_000n)),
              ],
              outstandingTotal: usd(100_000n),
              invoiceCount: 1,
            }),
          }),
        ).reason,
      ).toBe('DUPLICATE_INVOICE');
    });

    it('names a foreign currency before a checksum it makes uncomputable', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices: [outstanding('invoice-9', eur(100_000n))],
              outstandingTotal: usd(999n),
              invoiceCount: 7,
            }),
          }),
        ).reason,
      ).toBe('FOREIGN_CURRENCY');
    });

    it('names a foreign currency before a negative amount, for an entry that is both', () => {
      // Both make the checksum worthless; the currency is the more useful thing
      // to tell a producer about the entry.
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices: [outstanding('invoice-9', eur(-1n))],
              outstandingTotal: usd(0n),
              invoiceCount: 1,
            }),
          }),
        ).reason,
      ).toBe('FOREIGN_CURRENCY');
    });

    it('names a negative amount before the checksum it is allowed to satisfy', () => {
      expect(
        rejected(
          reconcile({
            snapshot: snapshotOf({
              invoices: [outstanding('invoice-9', usd(-1n))],
              outstandingTotal: usd(999n),
              invoiceCount: 9,
            }),
          }),
        ).reason,
      ).toBe('NEGATIVE_AMOUNT');
    });

    /**
     * Where the counter-drift gate sits, which is the one ordering decision in
     * this file that is about *our* state rather than the message's.
     *
     * After the watermark: a stale snapshot arrives routinely, and often in bulk
     * after a restart, so one bad counter must not alarm once per redelivery.
     * Before every gate about the message: drift is the only fault here that the
     * next snapshot cannot fix, and answering it with a producer-side reason would
     * send an operator to the wrong side of the boundary.
     */
    describe('and where the drift gate sits among them', () => {
      const drifting = (
        snapshot: Partial<TreasurySnapshot>,
      ): ReconciliationOutcome =>
        reconcile({
          // 1.00 USD held, nothing counted.
          program: programOf({ reserved: usd(0n) }),
          reservations: [
            activeHold({
              originalAmount: usd(100n),
              reservedAmount: usd(100n),
            }),
          ],
          snapshot: snapshotOf(snapshot),
        });

      it('calls a stale snapshot stale even though the counter has drifted', () => {
        expect(rejected(drifting({ sequence: 6 })).reason).toBe(
          'STALE_SEQUENCE',
        );
      });

      it('names the wrong program before it looks at our counter', () => {
        expect(rejected(drifting({ programId: 'program-2' })).reason).toBe(
          'WRONG_PROGRAM',
        );
      });

      it('names an unusable sequence before it looks at our counter', () => {
        expect(rejected(drifting({ sequence: -1 })).reason).toBe(
          'UNUSABLE_SEQUENCE',
        );
      });

      it('names the drift before a checksum the producer would be asked to fix', () => {
        expect(
          rejected(drifting({ outstandingTotal: usd(999n), invoiceCount: 9 }))
            .reason,
        ).toBe('COUNTER_DRIFT');
      });

      it('names the drift before an unreadable asOf', () => {
        expect(
          rejected(drifting({ asOf: new Date('not a date') })).reason,
        ).toBe('COUNTER_DRIFT');
      });

      it('names the drift before a foreign limit', () => {
        expect(
          rejected(
            drifting({ creditLimit: eur(LIMIT), outstandingTotal: usd(0n) }),
          ).reason,
        ).toBe('COUNTER_DRIFT');
      });

      it('names the drift before a duplicated invoice', () => {
        expect(
          rejected(
            drifting({
              invoices: [
                outstanding('invoice-9', usd(100_000n)),
                outstanding('invoice-9', usd(100_000n)),
              ],
            }),
          ).reason,
        ).toBe('COUNTER_DRIFT');
      });
    });
  });

  /**
   * Which side each rejection blames, as a property of the value.
   *
   * Cycle 8 has to answer this about every rejection before it does anything else —
   * does this message belong in the producer's DLQ? — and the table is keyed by
   * `SnapshotRejectionReason`, so a reason added without an origin does not
   * compile. Each row provokes the reason it claims, and the assertion pins both,
   * so a trigger that stops provoking what it says also fails here.
   */
  describe('which side of the boundary a rejection blames', () => {
    const rejections: Record<
      SnapshotRejectionReason,
      { origin: RejectionOrigin; provoke: () => ReconciliationOutcome }
    > = {
      STALE_SEQUENCE: {
        origin: 'TREASURY',
        provoke: () => reconcile({ snapshot: snapshotOf({ sequence: 5 }) }),
      },
      UNUSABLE_SEQUENCE: {
        origin: 'TREASURY',
        provoke: () =>
          reconcile({ snapshot: snapshotOf({ sequence: Number.NaN }) }),
      },
      UNREADABLE_AS_OF: {
        origin: 'TREASURY',
        provoke: () =>
          reconcile({ snapshot: snapshotOf({ asOf: new Date('not a date') }) }),
      },
      UNUSABLE_LIMIT: {
        origin: 'TREASURY',
        provoke: () =>
          reconcile({ snapshot: snapshotOf({ creditLimit: usd(-1n) }) }),
      },
      FOREIGN_CURRENCY: {
        origin: 'TREASURY',
        provoke: () =>
          reconcile({ snapshot: snapshotOf({ outstandingTotal: eur(0n) }) }),
      },
      NEGATIVE_AMOUNT: {
        origin: 'TREASURY',
        provoke: () =>
          reconcile({
            snapshot: snapshotOf({
              invoices: [outstanding('invoice-9', usd(-1n))],
              outstandingTotal: usd(-1n),
              invoiceCount: 1,
            }),
          }),
      },
      BLANK_INVOICE_ID: {
        origin: 'TREASURY',
        provoke: () =>
          reconcile({
            snapshot: snapshotOf({
              invoices: [outstanding('', usd(100_000n))],
            }),
          }),
      },
      DUPLICATE_INVOICE: {
        origin: 'TREASURY',
        provoke: () =>
          reconcile({
            snapshot: snapshotOf({
              invoices: [
                outstanding('invoice-9', usd(100_000n)),
                outstanding('invoice-9', usd(100_000n)),
              ],
            }),
          }),
      },
      CHECKSUM_MISMATCH: {
        origin: 'TREASURY',
        provoke: () =>
          reconcile({ snapshot: snapshotOf({ outstandingTotal: usd(1n) }) }),
      },
      /**
       * Ours. Not a mis-keyed message: a snapshot naming a program that does not
       * exist never reaches this function, and docs/PLAN.md 2.9 sends that to the
       * DLQ as treasury's typo. Reaching here means cycle 8 locked one program and
       * handed it another's snapshot, which is our routing and nobody else's.
       */
      WRONG_PROGRAM: {
        origin: 'SERVICE',
        provoke: () =>
          reconcile({ snapshot: snapshotOf({ programId: 'program-2' }) }),
      },
      /** Ours, and the one the whole discriminant was added for. */
      COUNTER_DRIFT: {
        origin: 'SERVICE',
        provoke: () => reconcile({ program: programOf({ reserved: usd(1n) }) }),
      },
    };

    it.each(
      Object.entries(rejections).map(([reason, row]) => ({ reason, ...row })),
    )(
      'reports $reason as coming from $origin',
      ({ reason, origin, provoke }) => {
        const rejection = rejected(provoke());

        expect([rejection.reason, rejection.origin]).toEqual([reason, origin]);
      },
    );

    it('blames this service for exactly the two rejections about our own state', () => {
      const ours = Object.values(rejections)
        .map(({ provoke }) => rejected(provoke()))
        .filter((rejection) => rejection.origin === 'SERVICE')
        .map((rejection) => rejection.reason)
        .sort();

      expect(ours).toEqual(['COUNTER_DRIFT', 'WRONG_PROGRAM']);
    });

    it('blames treasury for the routine rejection too, which is a separate axis', () => {
      // Superseded is not the same as faulty: cycle 8 keeps `STALE_SEQUENCE` out
      // of the DLQ because it is routine, not because of where it came from.
      expect(
        rejected(reconcile({ snapshot: snapshotOf({ sequence: 5 }) })).origin,
      ).toBe('TREASURY');
    });

    it('states an origin on every rejection, whichever gate answered', () => {
      const origins = Object.values(rejections).map(
        ({ provoke }) => rejected(provoke()).origin,
      );

      expect(origins.filter((origin) => origin === undefined)).toEqual([]);
    });
  });

  describe('the per-invoice diff of docs/PLAN.md 2.1', () => {
    const cases: {
      situation: string;
      invoices: TreasuryInvoice[];
      reservations: Reservation[];
      reserved: bigint;
      steps: string[];
      discrepancies: string[];
    }[] = [
      {
        situation: 'treasury says repaid and we hold the invoice',
        invoices: [repaid('invoice-1', usd(HOLD))],
        reservations: [activeHold()],
        reserved: HOLD,
        steps: ['RELEASE invoice-1 (REPAID)'],
        discrepancies: [],
      },
      {
        situation: 'treasury says repaid and we already released it',
        invoices: [repaid('invoice-1', usd(HOLD))],
        reservations: [releasedHold()],
        reserved: 0n,
        steps: [],
        discrepancies: [],
      },
      {
        situation: 'treasury says repaid and we never knew the invoice',
        invoices: [repaid('invoice-9', usd(100_000n))],
        reservations: [],
        reserved: 0n,
        steps: [],
        discrepancies: [],
      },
      {
        situation: 'treasury reports the amount we already hold',
        invoices: [outstanding('invoice-1', usd(HOLD))],
        reservations: [activeHold()],
        reserved: HOLD,
        steps: [],
        discrepancies: [],
      },
      {
        situation: 'treasury reports more than we hold',
        invoices: [outstanding('invoice-1', usd(HOLD + 1n))],
        reservations: [activeHold()],
        reserved: HOLD,
        steps: ['CORRECT invoice-1 from 2500000.00 to 2500000.01'],
        discrepancies: [],
      },
      {
        situation: 'treasury reports less than we hold',
        invoices: [outstanding('invoice-1', usd(HOLD - 1n))],
        reservations: [activeHold()],
        reserved: HOLD,
        steps: ['CORRECT invoice-1 from 2500000.00 to 2499999.99'],
        discrepancies: [],
      },
      {
        situation:
          'treasury reports an invoice we released before it took its picture',
        invoices: [outstanding('invoice-1', usd(HOLD))],
        reservations: [releasedHold()],
        reserved: 0n,
        steps: [],
        discrepancies: ['REPORTED_AGAINST_RELEASED_HOLD invoice-1'],
      },
      {
        situation:
          'treasury reports an invoice we released after it took its picture',
        invoices: [outstanding('invoice-1', usd(HOLD))],
        reservations: [releasedHold({ releasedAt: at(AS_OF, 1_000) })],
        reserved: 0n,
        steps: [],
        discrepancies: [],
      },
      {
        situation: 'treasury reports an invoice we never knew',
        invoices: [outstanding('invoice-9', usd(100_000n))],
        reservations: [],
        reserved: 0n,
        steps: ['CREATE invoice-9 for 1000.00'],
        discrepancies: [],
      },
      {
        situation:
          'a hold we have is missing from the snapshot and predates it',
        invoices: [],
        reservations: [activeHold()],
        reserved: HOLD,
        steps: [],
        discrepancies: ['HELD_BUT_NOT_REPORTED invoice-1'],
      },
      {
        situation:
          'a hold we have is missing from the snapshot and is in flight',
        invoices: [],
        reservations: [activeHold({ reservedAt: at(AS_OF, 1_000) })],
        reserved: HOLD,
        steps: [],
        discrepancies: [],
      },
      {
        situation: 'a hold we released is missing from the snapshot',
        invoices: [],
        reservations: [releasedHold()],
        reserved: 0n,
        steps: [],
        discrepancies: [],
      },
    ];

    it.each(cases)(
      'plans $steps when $situation',
      ({ invoices, reservations, reserved, steps, discrepancies }) => {
        const plan = applied(
          reconcile({
            program: programOf({ reserved: usd(reserved) }),
            reservations,
            snapshot: snapshotOf({ invoices }),
          }),
        );

        expect([outline(plan), flagged(plan)]).toEqual([steps, discrepancies]);
      },
    );
  });

  describe('an invoice treasury reports as repaid', () => {
    it('frees exactly what the hold carries, never the amount treasury reported', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold()],
          snapshot: snapshotOf({
            invoices: [repaid('invoice-1', usd(999_999n))],
          }),
        }),
      );
      const [step] = plan.steps;

      expect(
        step?.action === 'RELEASE' &&
          step.reservation.reservedAmount.toString(),
      ).toBe('2500000.00 USD');
      expect(plan.projectedReserved.isZero()).toBe(true);
    });

    it('does not correct a hold on the way to releasing it', () => {
      expect(
        outline(
          applied(
            reconcile({
              program: programOf({ reserved: usd(HOLD) }),
              reservations: [activeHold()],
              snapshot: snapshotOf({
                invoices: [repaid('invoice-1', usd(HOLD + 50_000n))],
              }),
            }),
          ),
        ),
      ).toEqual(['RELEASE invoice-1 (REPAID)']);
    });

    it('hands over the very reservation it was given, so cycle 8 needs no second lookup', () => {
      const reservation = activeHold();
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [reservation],
          snapshot: snapshotOf({ invoices: [repaid('invoice-1', usd(HOLD))] }),
        }),
      );
      const [step] = plan.steps;

      expect(step?.action === 'RELEASE' && step.reservation).toBe(reservation);
    });

    it('releases nothing twice for an invoice we already released, and flags nothing either', () => {
      const plan = applied(
        reconcile({
          reservations: [releasedHold()],
          snapshot: snapshotOf({ invoices: [repaid('invoice-1', usd(HOLD))] }),
        }),
      );

      expect([plan.steps, plan.discrepancies]).toEqual([[], []]);
    });

    it('releases nothing for a repaid invoice we never held', () => {
      expect(
        applied(
          reconcile({
            snapshot: snapshotOf({
              invoices: [repaid('invoice-9', usd(100_000n))],
            }),
          }),
        ).steps,
      ).toEqual([]);
    });

    it('releases every repaid hold the snapshot names, in the snapshot order', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD * 2n) }),
          reservations: [
            activeHold({ invoiceId: 'invoice-1' }),
            activeHold({ invoiceId: 'invoice-2' }),
          ],
          snapshot: snapshotOf({
            invoices: [
              repaid('invoice-2', usd(HOLD)),
              repaid('invoice-1', usd(HOLD)),
            ],
          }),
        }),
      );

      expect(outline(plan)).toEqual([
        'RELEASE invoice-2 (REPAID)',
        'RELEASE invoice-1 (REPAID)',
      ]);
    });
  });

  describe('a hold the snapshot does not mention', () => {
    const boundary: {
      situation: string;
      reservedAt: Date;
      flagged: boolean;
    }[] = [
      {
        situation: 'taken after the snapshot was cut',
        reservedAt: at(AS_OF, 1),
        flagged: false,
      },
      {
        situation: 'taken at the very instant the snapshot was cut',
        reservedAt: AS_OF,
        flagged: false,
      },
      {
        situation: 'taken a millisecond inside the margin',
        reservedAt: at(CUTOFF, 1),
        flagged: false,
      },
      {
        situation: 'taken exactly on the cutoff',
        reservedAt: CUTOFF,
        flagged: false,
      },
      {
        situation: 'taken a millisecond outside the margin',
        reservedAt: at(CUTOFF, -1),
        flagged: true,
      },
      {
        situation: 'taken long before the snapshot',
        reservedAt: LONG_BEFORE,
        flagged: true,
      },
    ];

    it.each(boundary)(
      'flags=$flagged for a hold $situation',
      ({ reservedAt, flagged: expected }) => {
        const plan = applied(
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [activeHold({ reservedAt })],
          }),
        );

        expect(plan.discrepancies.length === 1).toBe(expected);
      },
    );

    it('never releases a hold the snapshot omits, however old it is', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [
            activeHold({ reservedAt: new Date('2020-01-01T00:00:00.000Z') }),
          ],
        }),
      );

      expect([outline(plan), plan.projectedReserved.toString()]).toEqual([
        [],
        '2500000.00 USD',
      ]);
    });

    it('says nothing at all about a hold that is in flight, because there is nothing to resolve', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold({ reservedAt: at(AS_OF, 30_000) })],
        }),
      );

      expect([plan.steps, plan.discrepancies]).toEqual([[], []]);
    });

    it('resolves the boundary in favour of silence when told there is no skew at all', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold({ reservedAt: AS_OF })],
          clockSkewMarginMs: 0,
        }),
      );

      expect(plan.discrepancies).toEqual([]);
    });

    it('flags a hold a millisecond old when told there is no skew at all', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold({ reservedAt: at(AS_OF, -1) })],
          clockSkewMarginMs: 0,
        }),
      );

      expect(flagged(plan)).toEqual(['HELD_BUT_NOT_REPORTED invoice-1']);
    });

    it('widens the in-flight window when a deployment asks for a wider margin', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold({ reservedAt: at(AS_OF, -4 * 60_000) })],
          clockSkewMarginMs: 5 * 60_000,
        }),
      );

      expect(plan.discrepancies).toEqual([]);
    });

    it('defaults the margin to one minute, which is what the boundary cases assume', () => {
      expect(DEFAULT_CLOCK_SKEW_MARGIN_MS).toBe(60_000);
    });

    it('treats an absent margin as the default rather than as zero', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold({ reservedAt: at(AS_OF, -30_000) })],
          clockSkewMarginMs: undefined,
        }),
      );

      expect(plan.discrepancies).toEqual([]);
    });

    it('keeps every hold on an empty snapshot, which is the treasury bug the rule exists for', () => {
      const holds = [
        activeHold({ invoiceId: 'invoice-1' }),
        activeHold({ invoiceId: 'invoice-2' }),
        activeHold({ invoiceId: 'invoice-3' }),
      ];
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD * 3n) }),
          reservations: holds,
          snapshot: snapshotOf({ invoices: [] }),
        }),
      );

      expect([
        outline(plan),
        flagged(plan),
        plan.projectedReserved.toString(),
      ]).toEqual([
        [],
        [
          'HELD_BUT_NOT_REPORTED invoice-1',
          'HELD_BUT_NOT_REPORTED invoice-2',
          'HELD_BUT_NOT_REPORTED invoice-3',
        ],
        '7500000.00 USD',
      ]);
    });

    it('does not free the limit when an empty snapshot also leaves the limit alone', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold()],
          snapshot: snapshotOf({ invoices: [] }),
        }),
      );

      expect(plan.steps).toEqual([]);
    });

    it('sorts the flagged holds by invoice id, so a plan does not depend on the query order', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD * 3n) }),
          reservations: [
            activeHold({ invoiceId: 'invoice-c' }),
            activeHold({ invoiceId: 'invoice-a' }),
            activeHold({ invoiceId: 'invoice-b' }),
          ],
        }),
      );

      expect(flagged(plan)).toEqual([
        'HELD_BUT_NOT_REPORTED invoice-a',
        'HELD_BUT_NOT_REPORTED invoice-b',
        'HELD_BUT_NOT_REPORTED invoice-c',
      ]);
    });

    it('flags only the holds the snapshot left out', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD * 2n) }),
          reservations: [
            activeHold({ invoiceId: 'invoice-1' }),
            activeHold({ invoiceId: 'invoice-2' }),
          ],
          snapshot: snapshotOf({
            invoices: [outstanding('invoice-1', usd(HOLD))],
          }),
        }),
      );

      expect(flagged(plan)).toEqual(['HELD_BUT_NOT_REPORTED invoice-2']);
    });

    it('matches a hold against the snapshot by the trimmed invoice id', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold({ invoiceId: 'invoice-1' })],
          snapshot: snapshotOf({
            invoices: [outstanding('  invoice-1  ', usd(HOLD))],
          }),
        }),
      );

      expect([plan.steps, plan.discrepancies]).toEqual([[], []]);
    });
  });

  describe('correcting a hold to what treasury says it is', () => {
    const corrections: {
      direction: string;
      reported: bigint;
      steps: string[];
    }[] = [
      {
        direction: 'up',
        reported: HOLD + 50_000n,
        steps: ['CORRECT invoice-1 from 2500000.00 to 2500500.00'],
      },
      {
        direction: 'down',
        reported: HOLD - 50_000n,
        steps: ['CORRECT invoice-1 from 2500000.00 to 2499500.00'],
      },
      {
        direction: 'down to a single minor unit',
        reported: 1n,
        steps: ['CORRECT invoice-1 from 2500000.00 to 0.01'],
      },
      {
        direction: 'to the amount already held',
        reported: HOLD,
        steps: [],
      },
    ];

    it.each(corrections)(
      'plans $steps when treasury corrects the hold $direction',
      ({ reported, steps }) => {
        expect(
          outline(
            applied(
              reconcile({
                program: programOf({ reserved: usd(HOLD) }),
                reservations: [activeHold()],
                snapshot: snapshotOf({
                  invoices: [outstanding('invoice-1', usd(reported))],
                }),
              }),
            ),
          ),
        ).toEqual(steps);
      },
    );

    it('records no correction for an unchanged invoice, so a snapshot every minute writes no audit rows', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold()],
          snapshot: snapshotOf({
            invoices: [outstanding('invoice-1', usd(HOLD))],
          }),
        }),
      );

      expect([plan.steps, plan.discrepancies]).toEqual([[], []]);
    });

    it('corrects past the range a JS number holds, one minor unit at a time', () => {
      expect(
        outline(
          applied(
            reconcile({
              program: programOf({
                creditLimit: usd(BEYOND_SAFE_INTEGER * 2n),
                reserved: usd(BEYOND_SAFE_INTEGER),
              }),
              reservations: [
                activeHold({
                  originalAmount: usd(BEYOND_SAFE_INTEGER),
                  reservedAmount: usd(BEYOND_SAFE_INTEGER),
                }),
              ],
              snapshot: snapshotOf({
                creditLimit: usd(BEYOND_SAFE_INTEGER * 2n),
                invoices: [
                  outstanding('invoice-1', usd(BEYOND_SAFE_INTEGER + 1n)),
                ],
              }),
            }),
          ),
        ),
      ).toEqual([
        `CORRECT invoice-1 from ${usd(BEYOND_SAFE_INTEGER).toDecimalString()} to ${usd(BEYOND_SAFE_INTEGER + 1n).toDecimalString()}`,
      ]);
    });

    it('corrects a converted hold without restating the original amount or the frozen rate', () => {
      const reservation = activeHold({
        originalAmount: eur(10_000n),
        reservedAmount: usd(10_987n),
        fxRate: USD_PER_EUR,
      });
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(10_987n) }),
          reservations: [reservation],
          snapshot: snapshotOf({
            invoices: [
              outstanding('invoice-1', usd(11_000n), {
                originalAmount: eur(10_010n),
                rate: USD_PER_EUR,
              }),
            ],
          }),
        }),
      );
      const [step] = plan.steps;

      expect([
        outline(plan),
        step?.action === 'CORRECT' &&
          step.reservation.originalAmount.toString(),
        step?.action === 'CORRECT' &&
          step.reservation.fxRate?.toDecimalString(),
      ]).toEqual([
        ['CORRECT invoice-1 from 109.87 to 110.00'],
        '100.00 EUR',
        '1.0987',
      ]);
    });

    it('corrects on the reported amount alone, even when the entry FX evidence contradicts itself', () => {
      // The evidence is what it takes to *open* a hold. Restating one uses only
      // the figure treasury is authoritative about (docs/PLAN.md 2.1, 2.3).
      expect(
        outline(
          applied(
            reconcile({
              program: programOf({ reserved: usd(HOLD) }),
              reservations: [activeHold()],
              snapshot: snapshotOf({
                invoices: [
                  outstanding('invoice-1', usd(HOLD + 1n), {
                    originalAmount: eur(1n),
                    rate: null,
                  }),
                ],
              }),
            }),
          ),
        ),
      ).toEqual(['CORRECT invoice-1 from 2500000.00 to 2500000.01']);
    });

    it('carries what the hold currently holds, so the plan reads as a fact on its own', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold()],
          snapshot: snapshotOf({
            invoices: [outstanding('invoice-1', usd(1_000n))],
          }),
        }),
      );
      const [step] = plan.steps;

      expect(
        step?.action === 'CORRECT' && [
          step.heldAmount.toString(),
          step.correctedAmount.toString(),
          step.reservation.reservedAmount.toString(),
        ],
      ).toEqual(['2500000.00 USD', '10.00 USD', '2500000.00 USD']);
    });

    /**
     * Zero only. A negative amount is the other case entirely: it can cancel
     * another entry inside a stated total, so it takes the whole snapshot down —
     * see 'rejecting a snapshot whose entries make its checksums a lie'.
     */
    it('flags an outstanding amount of zero rather than correcting a hold to nothing', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold()],
          snapshot: snapshotOf({
            invoices: [outstanding('invoice-1', usd(0n))],
          }),
        }),
      );

      expect([outline(plan), flagged(plan)]).toEqual([
        [],
        ['UNUSABLE_AMOUNT invoice-1'],
      ]);
    });

    it('flags an outstanding amount of zero for an invoice it would otherwise create', () => {
      const plan = applied(
        reconcile({
          snapshot: snapshotOf({
            invoices: [outstanding('invoice-9', usd(0n))],
          }),
        }),
      );

      expect([outline(plan), flagged(plan)]).toEqual([
        [],
        ['UNUSABLE_AMOUNT invoice-9'],
      ]);
    });

    it('keeps reconciling the rest of the snapshot around one unusable amount', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold({ invoiceId: 'invoice-1' })],
          snapshot: snapshotOf({
            invoices: [
              outstanding('invoice-1', usd(0n)),
              outstanding('invoice-9', usd(100_000n)),
            ],
          }),
        }),
      );

      expect([outline(plan), flagged(plan)]).toEqual([
        ['CREATE invoice-9 for 1000.00'],
        ['UNUSABLE_AMOUNT invoice-1'],
      ]);
    });
  });

  describe('an invoice treasury reports against a hold we have released', () => {
    it('flags it rather than correcting a released hold, which docs/PLAN.md 2.5 forbids', () => {
      const plan = applied(
        reconcile({
          reservations: [releasedHold()],
          snapshot: snapshotOf({
            invoices: [outstanding('invoice-1', usd(HOLD + 1n))],
          }),
        }),
      );

      expect([outline(plan), flagged(plan)]).toEqual([
        [],
        ['REPORTED_AGAINST_RELEASED_HOLD invoice-1'],
      ]);
    });

    it('flags it even when treasury reports exactly what the hold used to carry', () => {
      const plan = applied(
        reconcile({
          reservations: [releasedHold()],
          snapshot: snapshotOf({
            invoices: [outstanding('invoice-1', usd(HOLD))],
          }),
        }),
      );

      expect(flagged(plan)).toEqual([
        'REPORTED_AGAINST_RELEASED_HOLD invoice-1',
      ]);
    });

    it('does not re-open the invoice, because an invoice is financed exactly once', () => {
      const plan = applied(
        reconcile({
          reservations: [releasedHold()],
          snapshot: snapshotOf({
            invoices: [outstanding('invoice-1', usd(HOLD))],
          }),
        }),
      );

      expect([plan.steps, plan.projectedReserved.isZero()]).toEqual([[], true]);
    });

    it('records both beliefs, so the disagreement can be resolved from the row alone', () => {
      const plan = applied(
        reconcile({
          reservations: [releasedHold()],
          snapshot: snapshotOf({
            invoices: [outstanding('invoice-1', usd(HOLD + 1n))],
          }),
        }),
      );
      const discrepancy = only(plan);

      expect([
        discrepancy.invoiceId,
        discrepancy.held?.toString(),
        discrepancy.localStatus,
        discrepancy.reported?.toString(),
        discrepancy.reportedStatus,
      ]).toEqual([
        'invoice-1',
        '2500000.00 USD',
        'RELEASED',
        '2500000.01 USD',
        'OUTSTANDING',
      ]);
    });

    /**
     * The other direction of the same race, and the mirror of the table on
     * `reservedAt`: a release this service performed after treasury took its
     * picture is as routine as a reservation taken after it, and treasury still
     * reporting the invoice as outstanding is the expected view of an event it had
     * not seen yet. Flagging it would report a discrepancy every time a snapshot
     * crossed a REST release or an `InvoiceRepaid`.
     */
    describe('while the release was still in flight', () => {
      const reportedAfter = (
        releasedAt: Date,
        clockSkewMarginMs?: number,
      ): ReconciliationPlan =>
        applied(
          reconcile({
            reservations: [releasedHold({ releasedAt })],
            snapshot: snapshotOf({
              invoices: [outstanding('invoice-1', usd(HOLD))],
            }),
            clockSkewMarginMs,
          }),
        );

      const boundary: {
        situation: string;
        releasedAt: Date;
        flagged: boolean;
      }[] = [
        {
          situation: 'released well after the snapshot was cut',
          releasedAt: at(AS_OF, 30_000),
          flagged: false,
        },
        {
          situation: 'released at the very instant the snapshot was cut',
          releasedAt: AS_OF,
          flagged: false,
        },
        {
          situation: 'released a millisecond inside the margin',
          releasedAt: at(CUTOFF, 1),
          flagged: false,
        },
        {
          situation: 'released exactly on the cutoff',
          releasedAt: CUTOFF,
          flagged: false,
        },
        {
          situation: 'released a millisecond outside the margin',
          releasedAt: at(CUTOFF, -1),
          flagged: true,
        },
        {
          situation: 'released long before the snapshot',
          releasedAt: at(LONG_BEFORE, 3_600_000),
          flagged: true,
        },
      ];

      it.each(boundary)(
        'flags=$flagged for a hold $situation',
        ({ releasedAt, flagged: expected }) => {
          expect(reportedAfter(releasedAt).discrepancies.length === 1).toBe(
            expected,
          );
        },
      );

      it('says nothing at all about a release that is in flight', () => {
        const plan = reportedAfter(at(AS_OF, 1_000));

        expect([plan.steps, plan.discrepancies]).toEqual([[], []]);
      });

      it('does not re-open the hold it kept quiet about', () => {
        expect(reportedAfter(at(AS_OF, 1_000)).projectedReserved.isZero()).toBe(
          true,
        );
      });

      it('resolves the boundary in favour of silence when told there is no skew at all', () => {
        expect(reportedAfter(AS_OF, 0).discrepancies).toEqual([]);
      });

      it('flags a release a millisecond old when told there is no skew at all', () => {
        expect(flagged(reportedAfter(at(AS_OF, -1), 0))).toEqual([
          'REPORTED_AGAINST_RELEASED_HOLD invoice-1',
        ]);
      });

      it('widens the window for the release just as it does for the hold', () => {
        expect(
          reportedAfter(at(AS_OF, -4 * 60_000), 5 * 60_000).discrepancies,
        ).toEqual([]);
      });

      it('measures the release against one and the same cutoff as the hold', () => {
        // One margin, one cutoff: a hold taken at the boundary and a release
        // performed at the boundary are both in flight, so neither of these two
        // programs has anything to report.
        const kept = applied(
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [activeHold({ reservedAt: CUTOFF })],
          }),
        );

        expect([
          kept.discrepancies,
          reportedAfter(CUTOFF).discrepancies,
        ]).toEqual([[], []]);
      });

      it('still frees a hold treasury reports repaid, whenever we released it', () => {
        const plan = applied(
          reconcile({
            reservations: [releasedHold({ releasedAt: at(AS_OF, 1_000) })],
            snapshot: snapshotOf({
              invoices: [repaid('invoice-1', usd(HOLD))],
            }),
          }),
        );

        expect([plan.steps, plan.discrepancies]).toEqual([[], []]);
      });
    });
  });

  describe('creating a hold for an invoice only treasury knows', () => {
    it('states the invoice, the exposure and no rate when nothing was converted', () => {
      const plan = applied(
        reconcile({
          snapshot: snapshotOf({
            invoices: [outstanding('invoice-9', usd(100_000n))],
          }),
        }),
      );
      const [step] = plan.steps;

      expect(
        step?.action === 'CREATE' && [
          step.invoiceId,
          step.amount.original.toString(),
          step.amount.converted.toString(),
          step.amount.rate,
        ],
      ).toEqual(['invoice-9', '1000.00 USD', '1000.00 USD', null]);
    });

    it('carries treasury rate as the evidence for a converted invoice', () => {
      const plan = applied(
        reconcile({
          snapshot: snapshotOf({
            invoices: [
              outstanding('invoice-9', usd(10_987n), {
                originalAmount: eur(10_000n),
                rate: USD_PER_EUR,
              }),
            ],
          }),
        }),
      );
      const [step] = plan.steps;

      expect(
        step?.action === 'CREATE' && [
          step.amount.original.toString(),
          step.amount.converted.toString(),
          step.amount.rate?.toDecimalString(),
          step.amount.rate?.source,
        ],
      ).toEqual(['100.00 EUR', '109.87 USD', '1.0987', 'treasury']);
    });

    it('trims the invoice id it plans to hold, so padding cannot split one invoice into two', () => {
      const plan = applied(
        reconcile({
          snapshot: snapshotOf({
            invoices: [outstanding('  invoice-9  ', usd(100_000n))],
          }),
        }),
      );
      const [step] = plan.steps;

      expect(step?.action === 'CREATE' && step.invoiceId).toBe('invoice-9');
    });

    it('creates a hold that exceeds what the program has left rather than refusing reality', () => {
      const plan = applied(
        reconcile({
          program: programOf({ creditLimit: usd(1_000n), reserved: usd(0n) }),
          snapshot: snapshotOf({
            creditLimit: usd(1_000n),
            invoices: [outstanding('invoice-9', usd(500_000n))],
          }),
        }),
      );

      expect([outline(plan), plan.projectedReserved.toString()]).toEqual([
        ['CREATE invoice-9 for 5000.00'],
        '5000.00 USD',
      ]);
    });

    it('creates every unknown invoice the snapshot names, in the snapshot order', () => {
      expect(
        outline(
          applied(
            reconcile({
              snapshot: snapshotOf({
                invoices: [
                  outstanding('invoice-b', usd(200_000n)),
                  outstanding('invoice-a', usd(100_000n)),
                ],
              }),
            }),
          ),
        ),
      ).toEqual([
        'CREATE invoice-b for 2000.00',
        'CREATE invoice-a for 1000.00',
      ]);
    });

    describe('when the snapshot FX evidence will not support a hold', () => {
      const noRate = outstanding('invoice-9', usd(10_987n), {
        originalAmount: eur(10_000n),
        rate: null,
      });

      it('flags a foreign invoice with no rate rather than inventing one', () => {
        const plan = applied(
          reconcile({ snapshot: snapshotOf({ invoices: [noRate] }) }),
        );

        expect([outline(plan), flagged(plan)]).toEqual([
          [],
          ['MISSING_FX_EVIDENCE invoice-9'],
        ]);
      });

      it('records what treasury reported, so the hold can be taken once the rate is known', () => {
        const discrepancy = only(
          applied(reconcile({ snapshot: snapshotOf({ invoices: [noRate] }) })),
        );

        expect([
          discrepancy.held,
          discrepancy.localStatus,
          discrepancy.reported?.toString(),
          discrepancy.reportedStatus,
        ]).toEqual([null, null, '109.87 USD', 'OUTSTANDING']);
      });

      const inconsistent: { why: string; invoice: TreasuryInvoice }[] = [
        {
          why: 'the rate does not reproduce the amount reported next to it',
          invoice: outstanding('invoice-9', usd(10_986n), {
            originalAmount: eur(10_000n),
            rate: USD_PER_EUR,
          }),
        },
        {
          why: 'the producer rounded to nearest where docs/PLAN.md 2.3 rounds up',
          invoice: outstanding('invoice-9', usd(1n), {
            originalAmount: eur(1n),
            rate: USD_PER_EUR,
          }),
        },
        {
          why: 'the rate prices the wrong pair',
          invoice: outstanding('invoice-9', usd(10_987n), {
            originalAmount: eur(10_000n),
            rate: FxRate.fromDecimalString({
              base: 'USD',
              quote: 'EUR',
              value: '0.9235',
              source: 'treasury',
              asOf: LONG_BEFORE,
            }),
          }),
        },
        {
          why: 'a rate is recorded although nothing was converted',
          invoice: outstanding('invoice-9', usd(10_987n), {
            originalAmount: usd(10_987n),
            rate: USD_PER_EUR,
          }),
        },
        {
          why: 'two amounts in one currency disagree with no rate to explain it',
          invoice: outstanding('invoice-9', usd(10_987n), {
            originalAmount: usd(10_000n),
            rate: null,
          }),
        },
        /**
         * Nobody invoices nothing, so an exposure that claims to come from a
         * non-positive invoice contradicts itself before any rate is applied —
         * which is also why the check has to run *before* the reproduction:
         * `applyRate` refuses a negative amount, and asking it first would throw
         * out of `reconcileProgram` and turn one flagged invoice into a
         * whole-snapshot trip to the DLQ.
         */
        {
          why: 'the exposure claims to come from a negative invoice',
          invoice: outstanding('invoice-9', usd(100n), {
            originalAmount: eur(-1n),
            rate: USD_PER_EUR,
          }),
        },
        {
          why: 'the exposure claims to come from an invoice of nothing',
          invoice: outstanding('invoice-9', usd(100n), {
            originalAmount: eur(0n),
            rate: USD_PER_EUR,
          }),
        },
        {
          why: 'a negative invoice is reported with no conversion at all',
          invoice: outstanding('invoice-9', usd(100n), {
            originalAmount: usd(-100n),
            rate: null,
          }),
        },
      ];

      it.each(inconsistent)('flags an invoice where $why', ({ invoice }) => {
        const plan = applied(
          reconcile({ snapshot: snapshotOf({ invoices: [invoice] }) }),
        );

        expect([outline(plan), flagged(plan)]).toEqual([
          [],
          ['INCONSISTENT_FX_EVIDENCE invoice-9'],
        ]);
      });

      it('accepts the amount cycle 1 would produce from the same rate, ceiling included', () => {
        const converted = applyRate(eur(1n), USD_PER_EUR);
        const plan = applied(
          reconcile({
            snapshot: snapshotOf({
              invoices: [
                outstanding('invoice-9', converted, {
                  originalAmount: eur(1n),
                  rate: USD_PER_EUR,
                }),
              ],
            }),
          }),
        );

        expect([converted.toString(), outline(plan)]).toEqual([
          '0.02 USD',
          ['CREATE invoice-9 for 0.02'],
        ]);
      });

      it('keeps reconciling the rest of the snapshot around one unusable entry', () => {
        const plan = applied(
          reconcile({
            snapshot: snapshotOf({
              invoices: [noRate, outstanding('invoice-8', usd(100_000n))],
            }),
          }),
        );

        expect([outline(plan), flagged(plan)]).toEqual([
          ['CREATE invoice-8 for 1000.00'],
          ['MISSING_FX_EVIDENCE invoice-9'],
        ]);
      });

      it('holds nothing for the flagged invoice, so availability is overstated until it is resolved', () => {
        expect(
          applied(
            reconcile({ snapshot: snapshotOf({ invoices: [noRate] }) }),
          ).projectedReserved.isZero(),
        ).toBe(true);
      });
    });
  });

  describe('the credit limit treasury owns', () => {
    it('plans no change when the snapshot restates the limit we already hold', () => {
      expect(
        applied(
          reconcile({ snapshot: snapshotOf({ creditLimit: usd(LIMIT) }) }),
        ).steps,
      ).toEqual([]);
    });

    it('plans an increase', () => {
      expect(
        outline(
          applied(
            reconcile({
              snapshot: snapshotOf({ creditLimit: usd(LIMIT * 2n) }),
            }),
          ),
        ),
      ).toEqual(['CHANGE_LIMIT to 20000000.00']);
    });

    it('plans a reduction', () => {
      expect(
        outline(
          applied(
            reconcile({
              snapshot: snapshotOf({ creditLimit: usd(400_000_000n) }),
            }),
          ),
        ),
      ).toEqual(['CHANGE_LIMIT to 4000000.00']);
    });

    it('carries the limit it is replacing, as evidence for whoever reads the plan', () => {
      const plan = applied(
        reconcile({ snapshot: snapshotOf({ creditLimit: usd(400_000_000n) }) }),
      );
      const [step] = plan.steps;

      expect(
        step?.action === 'CHANGE_LIMIT' && [
          step.previousCreditLimit.toString(),
          step.creditLimit.toString(),
        ],
      ).toEqual(['10000000.00 USD', '4000000.00 USD']);
    });

    it('plans a reduction that leaves the program over-utilised rather than refusing it', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold({ reservedAt: at(AS_OF, 1_000) })],
          snapshot: snapshotOf({ creditLimit: usd(100_000_000n) }),
        }),
      );
      const [step] = plan.steps;
      const available =
        step?.action === 'CHANGE_LIMIT'
          ? step.creditLimit.subtract(plan.projectedReserved)
          : null;

      expect([outline(plan), available?.toString()]).toEqual([
        ['CHANGE_LIMIT to 1000000.00'],
        '-1500000.00 USD',
      ]);
    });

    it('reduces the limit and corrects a hold upward in one plan, past the limit', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold()],
          snapshot: snapshotOf({
            creditLimit: usd(100_000_000n),
            invoices: [outstanding('invoice-1', usd(300_000_000n))],
          }),
        }),
      );

      expect([outline(plan), plan.projectedReserved.toString()]).toEqual([
        [
          'CORRECT invoice-1 from 2500000.00 to 3000000.00',
          'CHANGE_LIMIT to 1000000.00',
        ],
        '3000000.00 USD',
      ]);
    });

    it('reduces the limit to zero without touching a single hold', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [activeHold({ reservedAt: AS_OF })],
          snapshot: snapshotOf({ creditLimit: usd(0n) }),
        }),
      );

      expect([outline(plan), plan.projectedReserved.toString()]).toEqual([
        ['CHANGE_LIMIT to 0.00'],
        '2500000.00 USD',
      ]);
    });
  });

  describe('the order the plan is applied in', () => {
    /**
     * One snapshot exercising every step at once: a repayment, a correction in
     * each direction, an invoice we have never seen, and a new limit.
     */
    const busy = (): ReconciliationOutcome =>
      reconcile({
        program: programOf({ reserved: usd(HOLD * 4n) }),
        reservations: [
          activeHold({ invoiceId: 'invoice-up' }),
          activeHold({ invoiceId: 'invoice-down' }),
          activeHold({ invoiceId: 'invoice-repaid' }),
          activeHold({ invoiceId: 'invoice-untouched' }),
        ],
        snapshot: snapshotOf({
          creditLimit: usd(LIMIT * 2n),
          invoices: [
            outstanding('invoice-up', usd(HOLD + 100_000_000n)),
            outstanding('invoice-new', usd(50_000_000n)),
            repaid('invoice-repaid', usd(HOLD)),
            outstanding('invoice-down', usd(HOLD - 100_000_000n)),
            outstanding('invoice-untouched', usd(HOLD)),
          ],
        }),
      });

    it('frees capacity first, consumes it last and moves the limit at the very end', () => {
      expect(outline(applied(busy()))).toEqual([
        'RELEASE invoice-repaid (REPAID)',
        'CORRECT invoice-down from 2500000.00 to 1500000.00',
        'CORRECT invoice-up from 2500000.00 to 3500000.00',
        'CREATE invoice-new for 500000.00',
        'CHANGE_LIMIT to 20000000.00',
      ]);
    });

    it('never passes through a reserved total higher than where it starts or ends', () => {
      const plan = applied(busy());
      const start = usd(HOLD * 4n);
      const ceiling = start.isGreaterThanOrEqual(plan.projectedReserved)
        ? start
        : plan.projectedReserved;

      expect(
        runningTotals(plan, start).every((total) =>
          ceiling.isGreaterThanOrEqual(total),
        ),
      ).toBe(true);
    });

    it('arrives at the projected total by applying its own steps in its own order', () => {
      const plan = applied(busy());
      const totals = runningTotals(plan, usd(HOLD * 4n));

      expect(totals[totals.length - 1]?.toString()).toBe(
        plan.projectedReserved.toString(),
      );
    });

    it('keeps releases before corrections even when the snapshot lists them the other way round', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD * 2n) }),
          reservations: [
            activeHold({ invoiceId: 'invoice-1' }),
            activeHold({ invoiceId: 'invoice-2' }),
          ],
          snapshot: snapshotOf({
            invoices: [
              outstanding('invoice-1', usd(HOLD + 1n)),
              repaid('invoice-2', usd(HOLD)),
            ],
          }),
        }),
      );

      expect(outline(plan)).toEqual([
        'RELEASE invoice-2 (REPAID)',
        'CORRECT invoice-1 from 2500000.00 to 2500000.01',
      ]);
    });

    it('puts the limit change last even when it is the only other step', () => {
      const plan = applied(
        reconcile({
          snapshot: snapshotOf({
            creditLimit: usd(LIMIT * 2n),
            invoices: [outstanding('invoice-9', usd(100_000n))],
          }),
        }),
      );

      expect(outline(plan)).toEqual([
        'CREATE invoice-9 for 1000.00',
        'CHANGE_LIMIT to 20000000.00',
      ]);
    });
  });

  describe('the projected reserved total', () => {
    const projections: {
      situation: string;
      plan: () => ReconciliationOutcome;
      projected: string;
    }[] = [
      {
        situation: 'nothing changes',
        plan: () =>
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [activeHold()],
            snapshot: snapshotOf({
              invoices: [outstanding('invoice-1', usd(HOLD))],
            }),
          }),
        projected: '2500000.00 USD',
      },
      {
        situation: 'a hold is released',
        plan: () =>
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [activeHold()],
            snapshot: snapshotOf({
              invoices: [repaid('invoice-1', usd(HOLD))],
            }),
          }),
        projected: '0.00 USD',
      },
      {
        situation: 'a hold is corrected upward',
        plan: () =>
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [activeHold()],
            snapshot: snapshotOf({
              invoices: [outstanding('invoice-1', usd(HOLD * 2n))],
            }),
          }),
        projected: '5000000.00 USD',
      },
      {
        situation: 'a hold is created',
        plan: () =>
          reconcile({
            snapshot: snapshotOf({
              invoices: [outstanding('invoice-9', usd(100_000n))],
            }),
          }),
        projected: '1000.00 USD',
      },
      {
        situation: 'only the limit moves',
        plan: () =>
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [activeHold({ reservedAt: AS_OF })],
            snapshot: snapshotOf({ creditLimit: usd(1n) }),
          }),
        projected: '2500000.00 USD',
      },
      {
        situation: 'a discrepancy is flagged instead of a change being made',
        plan: () =>
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [activeHold()],
            snapshot: snapshotOf({ invoices: [] }),
          }),
        projected: '2500000.00 USD',
      },
    ];

    it.each(projections)(
      'projects $projected when $situation',
      ({ plan, projected }) => {
        expect(applied(plan()).projectedReserved.toString()).toBe(projected);
      },
    );

    it('projects a total past the range a JS number holds without losing a minor unit', () => {
      const plan = applied(
        reconcile({
          program: programOf({
            creditLimit: usd(BEYOND_SAFE_INTEGER * 4n),
            reserved: usd(BEYOND_SAFE_INTEGER),
          }),
          // The counter has to be carried by a hold, or the drift gate answers
          // before the projection is ever computed. In flight, so the hold the
          // snapshot leaves out adds no discrepancy to this case either.
          reservations: [
            activeHold({
              originalAmount: usd(BEYOND_SAFE_INTEGER),
              reservedAmount: usd(BEYOND_SAFE_INTEGER),
              reservedAt: AS_OF,
            }),
          ],
          snapshot: snapshotOf({
            creditLimit: usd(BEYOND_SAFE_INTEGER * 4n),
            invoices: [outstanding('invoice-9', usd(BEYOND_SAFE_INTEGER))],
          }),
        }),
      );

      expect(plan.projectedReserved.minorUnits).toBe(BEYOND_SAFE_INTEGER * 2n);
    });

    it('states the projection in the program currency even when nothing moves', () => {
      expect(applied(reconcile()).projectedReserved.toString()).toBe(
        '0.00 USD',
      );
    });
  });

  describe('what the plan records about the snapshot it applied', () => {
    it('reports treasury asOf as the instant the program was reconciled to', () => {
      expect(applied(reconcile()).reconciledAt.toISOString()).toBe(
        AS_OF.toISOString(),
      );
    });

    it('hands back a clone, so a caller cannot move the instant it reported', () => {
      const plan = applied(reconcile());

      plan.reconciledAt.setUTCFullYear(1999);

      expect(applied(reconcile()).reconciledAt.toISOString()).toBe(
        AS_OF.toISOString(),
      );
    });

    it('does not hand back the snapshot own Date instance', () => {
      const asOf = new Date(AS_OF.getTime());

      expect(
        applied(reconcile({ snapshot: snapshotOf({ asOf }) })).reconciledAt,
      ).not.toBe(asOf);
    });

    it('answers with a plan whose shape a reviewer can read as a list of facts', () => {
      expect(Object.keys(applied(reconcile())).sort()).toEqual([
        'appliedSequence',
        'discrepancies',
        'projectedReserved',
        'reconciledAt',
        'steps',
        'verdict',
      ]);
    });
  });

  describe('a discrepancy as data', () => {
    it('states what we believe and that treasury said nothing, for a hold left out', () => {
      const discrepancy = only(
        applied(
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [activeHold()],
          }),
        ),
      );

      expect([
        discrepancy.reason,
        discrepancy.invoiceId,
        discrepancy.held?.toString(),
        discrepancy.localStatus,
        discrepancy.reported,
        discrepancy.reportedStatus,
      ]).toEqual([
        'HELD_BUT_NOT_REPORTED',
        'invoice-1',
        '2500000.00 USD',
        'ACTIVE',
        null,
        null,
      ]);
    });

    it('explains itself in a sentence a person can act on', () => {
      const discrepancy = only(
        applied(
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [activeHold()],
          }),
        ),
      );

      expect(discrepancy.detail.length).toBeGreaterThan(0);
    });

    it('does not repeat the sequence or the instant that the plan already carries', () => {
      const discrepancy = only(
        applied(
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [activeHold()],
          }),
        ),
      );

      expect(Object.keys(discrepancy).sort()).toEqual([
        'detail',
        'held',
        'invoiceId',
        'localStatus',
        'reason',
        'reported',
        'reportedStatus',
      ]);
    });

    it('flags one discrepancy per invoice and no more', () => {
      const plan = applied(
        reconcile({
          // One active hold carries the counter; the released one carries
          // nothing, which is what the drift gate sums over.
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [
            activeHold({ invoiceId: 'invoice-1' }),
            releasedHold({ invoiceId: 'invoice-2' }),
          ],
          snapshot: snapshotOf({
            invoices: [outstanding('invoice-2', usd(HOLD))],
          }),
        }),
      );

      expect(flagged(plan)).toEqual([
        'REPORTED_AGAINST_RELEASED_HOLD invoice-2',
        'HELD_BUT_NOT_REPORTED invoice-1',
      ]);
    });

    it('reports the snapshot-driven discrepancies before the holds it noticed were missing', () => {
      const plan = applied(
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [
            activeHold({ invoiceId: 'invoice-aaa' }),
            releasedHold({ invoiceId: 'invoice-zzz' }),
          ],
          snapshot: snapshotOf({
            invoices: [outstanding('invoice-zzz', usd(HOLD))],
          }),
        }),
      );

      expect(plan.discrepancies.map((d) => d.reason)).toEqual([
        'REPORTED_AGAINST_RELEASED_HOLD',
        'HELD_BUT_NOT_REPORTED',
      ]);
    });
  });

  /**
   * Rows that cycle 2's factories would have refused, reaching the diff intact
   * because MikroORM hydrates without the constructor (docs/PLAN.md 2.6).
   * `reservation.ts` says so and predicts this outcome in as many words: an
   * unreadable instant "would quietly sort as 'older than asOf' and have the hold
   * flagged".
   *
   * Flagged is the whole requirement. One corrupt row costs its own invoice a
   * discrepancy and costs the program nothing — an exception here would stop a
   * program reconciling over a timestamp, and a `RangeError` out of a pure domain
   * function is a 500 with no code for the exception filter to map.
   */
  describe('a stored row whose instants were never validated', () => {
    /** Readable to a person, and free of what an unreadable `Date` prints as. */
    const readable = (detail: string): boolean =>
      detail.length > 0 && !/Invalid Date|NaN/.test(detail);

    describe('an active hold taken at an unreadable instant', () => {
      const omitting = (): ReconciliationOutcome =>
        reconcile({
          program: programOf({ reserved: usd(HOLD) }),
          reservations: [holdTakenAtAnUnreadableInstant()],
          snapshot: snapshotOf({ invoices: [] }),
        });

      it('reconciles the program instead of throwing out of it', () => {
        expect(() => omitting()).not.toThrow();
      });

      it('flags the hold, which is where an unreadable instant has to sort', () => {
        expect(flagged(applied(omitting()))).toEqual([
          'HELD_BUT_NOT_REPORTED invoice-1',
        ]);
      });

      it('explains itself in a sentence rather than formatting an unreadable date', () => {
        expect(readable(only(applied(omitting())).detail)).toBe(true);
      });

      it('keeps the capacity, as it does for any hold the snapshot omits', () => {
        expect(applied(omitting()).projectedReserved.toString()).toBe(
          '2500000.00 USD',
        );
      });

      it('answers with a plan rather than a rejection, since the message is sound', () => {
        expect(omitting().verdict).toBe('APPLY');
      });

      it('reconciles the rest of the snapshot around it', () => {
        const plan = applied(
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [holdTakenAtAnUnreadableInstant()],
            snapshot: snapshotOf({
              invoices: [outstanding('invoice-9', usd(100_000n))],
            }),
          }),
        );

        expect([outline(plan), flagged(plan)]).toEqual([
          ['CREATE invoice-9 for 1000.00'],
          ['HELD_BUT_NOT_REPORTED invoice-1'],
        ]);
      });

      it('corrects such a hold as normal, since a correction reads no instant', () => {
        const plan = applied(
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [holdTakenAtAnUnreadableInstant()],
            snapshot: snapshotOf({
              invoices: [outstanding('invoice-1', usd(HOLD + 1n))],
            }),
          }),
        );

        expect([outline(plan), flagged(plan)]).toEqual([
          ['CORRECT invoice-1 from 2500000.00 to 2500000.01'],
          [],
        ]);
      });

      it('releases such a hold as normal when treasury says it is repaid', () => {
        const plan = applied(
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [holdTakenAtAnUnreadableInstant()],
            snapshot: snapshotOf({
              invoices: [repaid('invoice-1', usd(HOLD))],
            }),
          }),
        );

        expect([outline(plan), flagged(plan)]).toEqual([
          ['RELEASE invoice-1 (REPAID)'],
          [],
        ]);
      });
    });

    describe('a released hold that cannot say when it was released', () => {
      const reporting = (reservation: Reservation): ReconciliationOutcome =>
        reconcile({
          reservations: [reservation],
          snapshot: snapshotOf({
            invoices: [outstanding('invoice-1', usd(HOLD))],
          }),
        });

      const corrupt: { why: string; reservation: () => Reservation }[] = [
        {
          why: 'the instant cannot be read',
          reservation: holdReleasedAtAnUnreadableInstant,
        },
        {
          why: 'no instant was stored at all',
          reservation: holdReleasedAtNoInstant,
        },
      ];

      it.each(corrupt)(
        'reconciles the program instead of throwing when $why',
        ({ reservation }) => {
          expect(() => reporting(reservation())).not.toThrow();
        },
      );

      it.each(corrupt)(
        'flags the disagreement rather than granting the margin when $why',
        ({ reservation }) => {
          // Being in flight is a claim about an instant, so a row that cannot name
          // one does not get the benefit of the doubt.
          expect(flagged(applied(reporting(reservation())))).toEqual([
            'REPORTED_AGAINST_RELEASED_HOLD invoice-1',
          ]);
        },
      );

      it.each(corrupt)(
        'explains itself in a sentence rather than formatting the missing instant when $why',
        ({ reservation }) => {
          expect(readable(only(applied(reporting(reservation()))).detail)).toBe(
            true,
          );
        },
      );

      it.each(corrupt)('re-opens nothing when $why', ({ reservation }) => {
        const plan = applied(reporting(reservation()));

        expect([plan.steps, plan.projectedReserved.isZero()]).toEqual([
          [],
          true,
        ]);
      });

      it('says nothing about such a row that the snapshot does not mention', () => {
        // A released hold nobody is arguing about is closed on both sides, and no
        // instant is read to establish that.
        const plan = applied(
          reconcile({ reservations: [holdReleasedAtNoInstant()] }),
        );

        expect([plan.steps, plan.discrepancies]).toEqual([[], []]);
      });

      it('still agrees with treasury that such a row is repaid', () => {
        const plan = applied(
          reconcile({
            reservations: [holdReleasedAtAnUnreadableInstant()],
            snapshot: snapshotOf({
              invoices: [repaid('invoice-1', usd(HOLD))],
            }),
          }),
        );

        expect([plan.steps, plan.discrepancies]).toEqual([[], []]);
      });
    });
  });

  describe('inputs this service is responsible for rather than treasury', () => {
    it.each([-1, -60_000, Number.NaN, Number.POSITIVE_INFINITY])(
      'refuses the clock-skew margin %p as a misconfiguration on our side',
      (clockSkewMarginMs) => {
        expect(() => reconcile({ clockSkewMarginMs })).toThrow(
          InvalidReconciliationInputError,
        );
      },
    );

    it('does not blame treasury for our own margin, which would DLQ a good snapshot', () => {
      expect(() => reconcile({ clockSkewMarginMs: -1 })).toThrow(
        InvalidReconciliationInputError,
      );
    });

    it('refuses a reservation belonging to another program', () => {
      expect(() =>
        reconcile({ reservations: [activeHold({ programId: 'program-2' })] }),
      ).toThrow(InvalidReconciliationInputError);
    });

    it('refuses a reservation holding an amount in another currency', () => {
      expect(() =>
        reconcile({
          reservations: [
            activeHold({
              originalAmount: eur(HOLD),
              reservedAmount: eur(HOLD),
            }),
          ],
        }),
      ).toThrow(InvalidReconciliationInputError);
    });

    /**
     * A counter in the wrong currency is a corrupt program row, not a drift: it is
     * refused where every other currency of our own state is refused, which also
     * keeps the drift gate's arithmetic on one currency by construction. Otherwise
     * `Money.equals` rightly calls a EUR zero unequal to a USD zero, the gate
     * concludes "drift", and `subtract` throws while writing the message.
     */
    describe('and a counter stated in the wrong currency', () => {
      it.each([0n, HOLD])(
        'refuses a reserved total of %p minor units in another currency',
        (minorUnits) => {
          expect(() =>
            reconcile({ program: programCountingIn(eur(minorUnits)) }),
          ).toThrow(InvalidReconciliationInputError);
        },
      );

      it('refuses it even when a hold of the same figure would make the counter look sound', () => {
        expect(() =>
          reconcile({
            program: programCountingIn(eur(HOLD)),
            reservations: [activeHold()],
          }),
        ).toThrow(InvalidReconciliationInputError);
      });

      it('does not let the currency mismatch escape from the message the gate writes', () => {
        expect(() =>
          reconcile({ program: programCountingIn(eur(0n)) }),
        ).not.toThrow(CurrencyMismatchError);
      });

      it('carries the code the rest of our own faults carry, not a value-object error', () => {
        const error = thrown(InvalidReconciliationInputError, () =>
          reconcile({ program: programCountingIn(eur(0n)) }),
        );

        expect([error.code, error.reason.length > 0]).toEqual([
          'INVALID_RECONCILIATION_INPUT',
          true,
        ]);
      });
    });

    it('refuses two reservations for the same invoice, which the unique key forbids', () => {
      expect(() =>
        reconcile({
          reservations: [
            activeHold({ invoiceId: 'invoice-1' }),
            releasedHold({ invoiceId: 'invoice-1' }),
          ],
        }),
      ).toThrow(InvalidReconciliationInputError);
    });

    it('carries a stable code and the reason it refused', () => {
      const error = thrown(InvalidReconciliationInputError, () =>
        reconcile({ clockSkewMarginMs: -1 }),
      );

      expect([error.code, error.reason.length > 0]).toEqual([
        'INVALID_RECONCILIATION_INPUT',
        true,
      ]);
    });

    it('accepts a margin of zero, which is a decision rather than a misconfiguration', () => {
      expect(() => reconcile({ clockSkewMarginMs: 0 })).not.toThrow();
    });

    /**
     * The margin is the width of the window in which this service says nothing, so
     * an unbounded one is a switch that turns every discrepancy off — silently,
     * because a plan with no discrepancies is what a healthy program produces.
     */
    describe('and the ceiling on the margin', () => {
      it('caps the margin at the two hours docs/PLAN.md 2.8 alerts on', () => {
        expect(MAX_CLOCK_SKEW_MARGIN_MS).toBe(7_200_000);
      });

      it('accepts a margin of exactly the maximum, so a configured round number is not off by one', () => {
        expect(() =>
          reconcile({ clockSkewMarginMs: MAX_CLOCK_SKEW_MARGIN_MS }),
        ).not.toThrow();
      });

      it('refuses a margin a millisecond above the maximum', () => {
        expect(() =>
          reconcile({ clockSkewMarginMs: MAX_CLOCK_SKEW_MARGIN_MS + 1 }),
        ).toThrow(InvalidReconciliationInputError);
      });

      it('refuses the finite-but-absurd margin that would silence every discrepancy for ever', () => {
        expect(() => reconcile({ clockSkewMarginMs: 1e300 })).toThrow(
          InvalidReconciliationInputError,
        );
      });

      it('refuses it rather than quietly reporting a clean program', () => {
        // Without the ceiling the cutoff becomes -1e300, every hold and every
        // release reads as in flight, and a program that has forgotten a hold
        // for a year reconciles with nothing to say about it.
        expect(() =>
          reconcile({
            program: programOf({ reserved: usd(HOLD) }),
            reservations: [
              activeHold({ reservedAt: new Date('2020-01-01T00:00:00.000Z') }),
            ],
            clockSkewMarginMs: 1e300,
          }),
        ).toThrow(InvalidReconciliationInputError);
      });

      it('still flags that hold at a margin the ceiling allows', () => {
        expect(
          flagged(
            applied(
              reconcile({
                program: programOf({ reserved: usd(HOLD) }),
                reservations: [
                  activeHold({
                    reservedAt: new Date('2020-01-01T00:00:00.000Z'),
                  }),
                ],
                clockSkewMarginMs: MAX_CLOCK_SKEW_MARGIN_MS,
              }),
            ),
          ),
        ).toEqual(['HELD_BUT_NOT_REPORTED invoice-1']);
      });

      it('names the ceiling in the reason, so a misconfiguration is fixable from the message', () => {
        const error = thrown(InvalidReconciliationInputError, () =>
          reconcile({ clockSkewMarginMs: 1e300 }),
        );

        expect(error.reason.length).toBeGreaterThan(0);
      });
    });
  });

  describe('determinism and freedom from side effects', () => {
    /**
     * Every kind of step and both kinds of discrepancy in one call, plus one
     * converted hold the snapshot agrees with — it produces nothing, and it is
     * there so that the FX fields a correction must never touch are carried by
     * something other than `null`.
     */
    const everything = (): ReconciliationInput => ({
      program: programOf({ reserved: usd(HOLD * 4n + 10_987n) }),
      reservations: [
        activeHold({ invoiceId: 'invoice-repaid' }),
        activeHold({ invoiceId: 'invoice-corrected' }),
        activeHold({ invoiceId: 'invoice-forgotten' }),
        activeHold({ invoiceId: 'invoice-inflight', reservedAt: AS_OF }),
        activeHold({
          invoiceId: 'invoice-converted',
          originalAmount: eur(10_000n),
          reservedAmount: usd(10_987n),
          fxRate: USD_PER_EUR,
        }),
        releasedHold({ invoiceId: 'invoice-closed' }),
      ],
      snapshot: snapshotOf({
        creditLimit: usd(400_000_000n),
        invoices: [
          repaid('invoice-repaid', usd(HOLD)),
          outstanding('invoice-corrected', usd(HOLD + 1n)),
          outstanding('invoice-closed', usd(HOLD)),
          outstanding('invoice-new', usd(100_000n)),
          outstanding('invoice-converted', usd(10_987n), {
            originalAmount: eur(10_000n),
            rate: USD_PER_EUR,
          }),
        ],
      }),
      appliedSequence: 6,
    });

    it('answers the same thing twice for the same input', () => {
      const input = everything();

      expect(reconcileProgram(input)).toEqual(reconcileProgram(input));
    });

    it('answers the same thing for two equal inputs built separately', () => {
      expect(outline(applied(reconcileProgram(everything())))).toEqual(
        outline(applied(reconcileProgram(everything()))),
      );
    });

    it('leaves the program it was handed exactly as it found it', () => {
      const input = everything();
      const { program } = input;
      const before = [
        program.creditLimit.toString(),
        program.reserved.toString(),
        program.available.toString(),
        program.overUtilized,
      ];

      reconcileProgram(input);

      expect([
        program.creditLimit.toString(),
        program.reserved.toString(),
        program.available.toString(),
        program.overUtilized,
      ]).toEqual(before);
    });

    it('leaves every reservation it was handed exactly as it found it', () => {
      const input = everything();
      const state = (): unknown[] =>
        input.reservations.map((reservation) => [
          reservation.status,
          reservation.reservedAmount.toString(),
          reservation.releasedAmount.toString(),
          reservation.outstandingAmount.toString(),
          reservation.releasedAt?.toISOString() ?? null,
          reservation.releaseReason,
          // The evidence a correction is forbidden to rewrite (docs/PLAN.md 2.3)
          // and the instant the in-flight rule reads. Unasserted, a plan that
          // restated a rate or moved a timestamp would look pure.
          reservation.originalAmount.toString(),
          reservation.fxRate?.toDecimalString() ?? null,
          reservation.fxRate?.asOf.toISOString() ?? null,
          reservation.reservedAt.toISOString(),
        ]);
      const before = state();

      reconcileProgram(input);

      expect(state()).toEqual(before);
    });

    it('leaves the snapshot it was handed exactly as it found it', () => {
      const input = everything();
      const { snapshot } = input;
      const state = (): unknown[] => [
        snapshot.sequence,
        snapshot.asOf.toISOString(),
        snapshot.creditLimit.toString(),
        snapshot.outstandingTotal.toString(),
        snapshot.invoiceCount,
        snapshot.repaidTotal.toString(),
        snapshot.repaidCount,
        snapshot.invoices.map((invoice) => invoice.invoiceId),
      ];
      const before = state();

      reconcileProgram(input);

      expect(state()).toEqual(before);
    });

    it('does not reorder the arrays it was handed', () => {
      const input = everything();
      const reservations = [...input.reservations];
      const invoices = [...input.snapshot.invoices];

      reconcileProgram(input);

      expect([input.reservations, input.snapshot.invoices]).toEqual([
        reservations,
        invoices,
      ]);
    });

    it('decides the whole busy case in one pass, for the record', () => {
      const plan = applied(reconcileProgram(everything()));

      expect([
        outline(plan),
        flagged(plan),
        plan.projectedReserved.toString(),
      ]).toEqual([
        [
          'RELEASE invoice-repaid (REPAID)',
          'CORRECT invoice-corrected from 2500000.00 to 2500000.01',
          'CREATE invoice-new for 1000.00',
          'CHANGE_LIMIT to 4000000.00',
        ],
        [
          'REPORTED_AGAINST_RELEASED_HOLD invoice-closed',
          'HELD_BUT_NOT_REPORTED invoice-forgotten',
        ],
        '7501109.88 USD',
      ]);
    });
  });
});

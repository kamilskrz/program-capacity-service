/**
 * Reconciles a program against a treasury snapshot, as a pure function
 * (docs/PLAN.md 2.1, 2.10). Decides; applies nothing.
 * Governing rule: when in doubt, hold the capacity — never release it.
 */

import { type CurrencyCode } from '../../capacity/domain/currency';
import { DomainError } from '../../capacity/domain/errors';
import { Money } from '../../capacity/domain/money';
import { type Program } from '../../capacity/domain/program';
import {
  type ReleaseReason,
  type Reservation,
  type ReservationStatus,
} from '../../capacity/domain/reservation';
import { applyRate, type Conversion } from '../../fx/convert';
import { type FxRate } from '../../fx/fx-rate';

/**
 * How treasury describes an invoice it is reporting on (docs/PLAN.md 2.2).
 * `REPAID` may appear on a snapshot entry, not only on an `InvoiceRepaid`
 * message — it is the positive evidence the governing rule requires before
 * releasing anything.
 */
export type TreasuryInvoiceStatus = 'OUTSTANDING' | 'REPAID';

/** One invoice as treasury reports it. */
export interface TreasuryInvoice {
  readonly invoiceId: string;
  readonly status: TreasuryInvoiceStatus;
  /** The outstanding exposure, in the program's currency. */
  readonly amount: Money;
  /** The invoice as issued, in whatever currency it was issued in. */
  readonly originalAmount: Money;
  /** Rate from {@link originalAmount} to {@link amount}; `null` when no conversion was involved. */
  readonly rate: FxRate | null;
}

/**
 * A full-state snapshot of one program, as published on
 * `treasury.program-events` (docs/PLAN.md 2.1, 2.2). Nothing here is trusted —
 * every field is still checked in this file.
 *
 * The checksums come in two pairs, one per status: `outstandingTotal` with
 * `invoiceCount` over the `OUTSTANDING` entries, `repaidTotal` with
 * `repaidCount` over the `REPAID` ones. The repaid pair is the only integrity
 * check on the release path, so a mismatch in either pair rejects the whole
 * snapshot.
 */
export interface TreasurySnapshot {
  readonly programId: string;
  /** The monotonically increasing publication counter of docs/PLAN.md 2.1. */
  readonly sequence: number;
  /** The instant the snapshot describes: treasury's clock, not ours. */
  readonly asOf: Date;
  readonly creditLimit: Money;
  readonly invoices: readonly TreasuryInvoice[];
  readonly outstandingTotal: Money;
  readonly invoiceCount: number;
  readonly repaidTotal: Money;
  readonly repaidCount: number;
}

/**
 * Why a whole snapshot was thrown away (docs/PLAN.md 2.1: "ignore the
 * snapshot", "reject the whole snapshot"). `STALE_SEQUENCE` is the one routine
 * member; everything else is a data fault for the DLQ.
 */
export type SnapshotRejectionReason =
  /** Already applied, or superseded (`sequence <= ` the watermark). Routine. */
  | 'STALE_SEQUENCE'
  /** The snapshot's `programId` is not the program's — our routing, not treasury's fault. */
  | 'WRONG_PROGRAM'
  /** `sequence` is not a non-negative safe integer. */
  | 'UNUSABLE_SEQUENCE'
  /** The program's `reserved` total does not equal the sum of the active holds handed in. Ours, not healed automatically. */
  | 'COUNTER_DRIFT'
  /** `asOf` is not a readable instant. */
  | 'UNREADABLE_AS_OF'
  /** An amount that must be in the program's currency is not (limit, checksum or an entry's outstanding amount). */
  | 'FOREIGN_CURRENCY'
  /** An entry amount below zero, which could cancel another entry inside a checksum. */
  | 'NEGATIVE_AMOUNT'
  /** A negative credit limit. */
  | 'UNUSABLE_LIMIT'
  /** An entry whose invoice id is empty or whitespace. */
  | 'BLANK_INVOICE_ID'
  /** The same invoice listed twice. Not deduplicated. */
  | 'DUPLICATE_INVOICE'
  /** A checksum total or count disagrees with the entries it covers. */
  | 'CHECKSUM_MISMATCH';

/**
 * Which side of the boundary a rejection is a statement about: `TREASURY`
 * (the message is wrong, goes to the DLQ) or `SERVICE` (our own state; not the
 * producer's fault).
 */
export type RejectionOrigin = 'TREASURY' | 'SERVICE';

/** Which side each reason blames — stated once, as data, so a new reason without an origin does not compile. */
const REJECTION_ORIGIN: Record<SnapshotRejectionReason, RejectionOrigin> = {
  STALE_SEQUENCE: 'TREASURY',
  UNUSABLE_SEQUENCE: 'TREASURY',
  UNREADABLE_AS_OF: 'TREASURY',
  FOREIGN_CURRENCY: 'TREASURY',
  NEGATIVE_AMOUNT: 'TREASURY',
  UNUSABLE_LIMIT: 'TREASURY',
  BLANK_INVOICE_ID: 'TREASURY',
  DUPLICATE_INVOICE: 'TREASURY',
  CHECKSUM_MISMATCH: 'TREASURY',
  WRONG_PROGRAM: 'SERVICE',
  COUNTER_DRIFT: 'SERVICE',
};

/**
 * A snapshot that will not be applied at all: no steps, no discrepancies, no
 * watermark movement.
 */
export interface SnapshotRejection {
  readonly verdict: 'REJECT';
  readonly reason: SnapshotRejectionReason;
  readonly origin: RejectionOrigin;
  /** One sentence for the log line and DLQ envelope. Not a stable contract. */
  readonly detail: string;
  /** The sequence the snapshot claimed, verbatim — including an unusable one. */
  readonly sequence: number;
  /** The watermark it was judged against; `null` if the program never reconciled. */
  readonly appliedSequence: number | null;
}

/**
 * Why one invoice could not be reconciled automatically — the
 * `DISCREPANCY_FLAGGED` event of docs/PLAN.md 2.8. Never a capacity change.
 */
export type DiscrepancyReason =
  /** An active reservation the snapshot does not mention, older than the cutoff. The hold is kept, not released. */
  | 'HELD_BUT_NOT_REPORTED'
  /** Treasury reports as outstanding an invoice already released here, and the release is not itself in flight. */
  | 'REPORTED_AGAINST_RELEASED_HOLD'
  /** An unknown invoice reported in a foreign currency with no rate to explain it. */
  | 'MISSING_FX_EVIDENCE'
  /** An unknown invoice whose own figures contradict each other (wrong-pair rate, or one that does not reproduce the amount). */
  | 'INCONSISTENT_FX_EVIDENCE'
  /** An outstanding exposure of exactly zero — neither a hold nor a correction can carry it. */
  | 'UNUSABLE_AMOUNT';

/**
 * One invoice this service and treasury disagree about (docs/PLAN.md 2.8).
 * Both beliefs are carried in full, side by side; either may be `null` when
 * that side has nothing to say about the invoice. The snapshot `sequence` and
 * `asOf` are deliberately not repeated here — they live on
 * {@link ReconciliationPlan}.
 */
export interface Discrepancy {
  readonly reason: DiscrepancyReason;
  readonly invoiceId: string;
  /** `null` if this service holds nothing for the invoice. */
  readonly held: Money | null;
  readonly localStatus: ReservationStatus | null;
  /** `null` if the snapshot did not mention the invoice at all. */
  readonly reported: Money | null;
  readonly reportedStatus: TreasuryInvoiceStatus | null;
  /** One sentence for a person reading the audit log. Not a contract. */
  readonly detail: string;
}

/**
 * Free the capacity a hold is carrying (docs/PLAN.md 2.1). Cycle 8 runs
 * `program.release(step.reservation, step.reason, context)` — no amount, since
 * a release frees exactly what the hold carries, never treasury's figure.
 */
export interface ReleaseHoldStep {
  readonly action: 'RELEASE';
  readonly invoiceId: string;
  readonly reservation: Reservation;
  /** Always `REPAID` today; the type stays open for a future `CANCELLED` via snapshot. */
  readonly reason: ReleaseReason;
}

/**
 * Restate what a hold carries: treasury wins (docs/PLAN.md 2.1). Cycle 8 runs
 * `program.correctReservation(...)`. Emitted only when the figures actually
 * differ. The original amount and stored rate are not touched — a correction
 * is new truth about exposure, not a new conversion (docs/PLAN.md 2.3).
 */
export interface CorrectHoldStep {
  readonly action: 'CORRECT';
  readonly invoiceId: string;
  readonly reservation: Reservation;
  readonly heldAmount: Money;
  readonly correctedAmount: Money;
}

/**
 * Open a hold for an invoice treasury knows and this service does not
 * (docs/PLAN.md 2.1). Cycle 8 runs `program.recordTreasuryHold(...)` —
 * reconciliation's own operation, not `program.reserve`, since this one has no
 * capacity veto.
 */
export interface CreateHoldStep {
  readonly action: 'CREATE';
  readonly invoiceId: string;
  /** `null` when treasury reported it in the program's own currency. */
  readonly amount: Conversion;
}

/**
 * Set the credit limit to treasury's (docs/PLAN.md 2.1). Emitted only when the
 * limit actually moves. A reduction below current exposure is emitted anyway
 * and leaves the program over-utilised.
 */
export interface ChangeCreditLimitStep {
  readonly action: 'CHANGE_LIMIT';
  readonly previousCreditLimit: Money;
  readonly creditLimit: Money;
}

/**
 * One thing to do, in the order to do it: releases, then downward corrections,
 * then upward corrections, then creations, then the limit change last. Within
 * each group, snapshot order is preserved.
 */
export type ReconciliationStep =
  ReleaseHoldStep | CorrectHoldStep | CreateHoldStep | ChangeCreditLimitStep;

/**
 * The decisions a snapshot leads to: everything cycle 8 needs to apply it
 * inside one transaction, and nothing it has to derive for itself.
 */
export interface ReconciliationPlan {
  readonly verdict: 'APPLY';
  /** Stored even for a plan with no steps — the watermark still advances. */
  readonly appliedSequence: number;
  /** Treasury's `asOf`, cloned. Backs `lastReconciledAt` (docs/PLAN.md 2.7). */
  readonly reconciledAt: Date;
  /** In application order. See {@link ReconciliationStep}. */
  readonly steps: readonly ReconciliationStep[];
  /** Snapshot-driven discrepancies first; `HELD_BUT_NOT_REPORTED` ones follow, sorted by invoice id. */
  readonly discrepancies: readonly Discrepancy[];
  /** Current total plus the signed sum of the steps, not clamped. */
  readonly projectedReserved: Money;
}

/** What {@link reconcileProgram} answers. */
export type ReconciliationOutcome = ReconciliationPlan | SnapshotRejection;

/**
 * Everything the decision depends on. A pure function's whole state, named.
 */
export interface ReconciliationInput {
  /** Read under `LockMode.PESSIMISTIC_WRITE` by the caller. Read, never written. */
  readonly program: Program;
  /**
   * Every active hold, plus every reservation the snapshot names whatever its
   * status — not every reservation the program has ever had.
   *
   * Precondition the caller must meet: the identifiers used to select the
   * named reservations must include every `OUTSTANDING` entry's. Drop one and
   * its reservation is not loaded, so an invoice this service already
   * released arrives with no hold attached; this function then reads that as
   * "treasury knows the invoice, we do not" and opens a fresh hold for it
   * instead of flagging `REPORTED_AGAINST_RELEASED_HOLD` — capacity invented
   * from nothing. The function cannot detect the mistake: an absent row and
   * an unselected row look identical from here. Passing `REPAID` identifiers
   * too is cheap insurance but not required.
   */
  readonly reservations: readonly Reservation[];
  readonly snapshot: TreasurySnapshot;
  /** Highest `sequence` already applied, or `null` if never reconciled. */
  readonly appliedSequence: number | null;
  /**
   * How far treasury's clock may run ahead of ours before a hold or release
   * stops counting as in flight, in milliseconds. Defaults to
   * {@link DEFAULT_CLOCK_SKEW_MARGIN_MS}, capped at {@link MAX_CLOCK_SKEW_MARGIN_MS}.
   */
  readonly clockSkewMarginMs?: number;
}

/** The default clock-skew margin: one minute. A parameter, not a constant, since it is a deployment property. */
export const DEFAULT_CLOCK_SKEW_MARGIN_MS = 60_000;

/**
 * The largest clock-skew margin that may be configured: two hours, the
 * snapshot-lag alerting threshold — a margin any wider would silence every
 * discrepancy for good, silently.
 */
export const MAX_CLOCK_SKEW_MARGIN_MS = 2 * 60 * 60 * 1_000;

/**
 * Inputs that are this service's own fault rather than treasury's — an
 * exception, not a {@link SnapshotRejection}: answering with a rejection would
 * file a perfectly good snapshot as poison and quietly stop reconciling.
 */
export class InvalidReconciliationInputError extends DomainError {
  readonly code = 'INVALID_RECONCILIATION_INPUT';

  constructor(readonly reason: string) {
    super(`Cannot reconcile: ${reason}`);
  }
}

/** Why an entry could not become a hold, with the sentence that says so. */
interface EvidenceFault {
  readonly reason: 'MISSING_FX_EVIDENCE' | 'INCONSISTENT_FX_EVIDENCE';
  readonly detail: string;
}

/**
 * The margin the in-flight rule is measured with, refused rather than
 * defaulted when it makes no sense (negative, `NaN`/infinite, or above
 * {@link MAX_CLOCK_SKEW_MARGIN_MS}) — a misconfiguration on this side of the
 * boundary, so an exception rather than a rejection.
 */
function resolveClockSkewMargin(marginMs: number | undefined): number {
  const margin = marginMs ?? DEFAULT_CLOCK_SKEW_MARGIN_MS;

  if (!Number.isFinite(margin) || margin < 0) {
    throw new InvalidReconciliationInputError(
      `the clock-skew margin must be a non-negative finite number of milliseconds, got ${String(margin)}`,
    );
  }

  // Exactly the ceiling is accepted.
  if (margin > MAX_CLOCK_SKEW_MARGIN_MS) {
    throw new InvalidReconciliationInputError(
      `the clock-skew margin may not exceed ${MAX_CLOCK_SKEW_MARGIN_MS} ms, the snapshot-lag alerting threshold, got ${margin}`,
    );
  }

  return margin;
}

/**
 * The program's reservations by trimmed invoice id, and the active total they
 * sum to, all checked on the way in. Everything refused here is this
 * service's own fault, not treasury's.
 */
function indexReservations(
  program: Program,
  reservations: readonly Reservation[],
): { holds: Map<string, Reservation>; activeTotal: Money } {
  const holds = new Map<string, Reservation>();
  let activeTotal = Money.zero(program.currency);

  // Checked first: a counter in another currency is a corrupt row, not a
  // drift, and letting the drift gate see it would throw a
  // `CurrencyMismatchError` from the sentence meant to explain the drift.
  if (program.reserved.currency !== program.currency) {
    throw new InvalidReconciliationInputError(
      `a ${program.currency} program cannot count ${program.reserved.toString()} as reserved`,
    );
  }

  for (const reservation of reservations) {
    if (reservation.programId !== program.id) {
      throw new InvalidReconciliationInputError(
        `reservation for invoice ${reservation.invoiceId} belongs to program ${reservation.programId}, not ${program.id}`,
      );
    }

    if (reservation.reservedAmount.currency !== program.currency) {
      throw new InvalidReconciliationInputError(
        `reservation for invoice ${reservation.invoiceId} holds ${reservation.reservedAmount.toString()} against a ${program.currency} program`,
      );
    }

    // Same reason: `outstandingAmount` subtracts one from the other below.
    if (reservation.releasedAmount.currency !== program.currency) {
      throw new InvalidReconciliationInputError(
        `reservation for invoice ${reservation.invoiceId} released ${reservation.releasedAmount.toString()} against a ${program.currency} program`,
      );
    }

    const invoiceId = reservation.invoiceId.trim();

    if (holds.has(invoiceId)) {
      throw new InvalidReconciliationInputError(
        `invoice ${invoiceId} has two reservations, which the unique key on (program_id, invoice_id) forbids`,
      );
    }

    holds.set(invoiceId, reservation);

    if (reservation.isActive()) {
      activeTotal = activeTotal.add(reservation.outstandingAmount);
    }
  }

  return { holds, activeTotal };
}

/**
 * Whether the denormalized counter still equals the active holds — the
 * invariant of docs/PLAN.md 2.4 — as the rejection sentence, or `null`.
 * Nothing is written back: see `COUNTER_DRIFT`.
 */
function counterDriftFault(
  program: Program,
  activeTotal: Money,
): string | null {
  if (program.reserved.equals(activeTotal)) {
    return null;
  }

  return `the program counts ${program.reserved.toString()} reserved while its active holds carry ${activeTotal.toString()}, a drift of ${program.reserved.subtract(activeTotal).toString()}`;
}

/**
 * An instant as a discrepancy's sentence may state it. `toISOString()` throws
 * on an unreadable `Date` (a stored row can hold one, docs/PLAN.md 2.6), so
 * both an unreadable and a missing instant are named instead of formatted.
 */
function describeInstant(instant: Date | null): string {
  if (instant === null) {
    return 'an unrecorded date';
  }

  return Number.isNaN(instant.getTime())
    ? 'an unreadable date'
    : instant.toISOString();
}

/** Codepoint order, not `localeCompare`, so sorting does not depend on the runtime's collation data. */
function byInvoiceId(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

/**
 * The first amount in the snapshot not in the program's currency, as the
 * rejection sentence, or `null`. Entry *originals* are not checked — any
 * currency is fine there; entry `amount`s are, whatever their status.
 */
function firstForeignAmount(
  currency: CurrencyCode,
  snapshot: TreasurySnapshot,
): string | null {
  if (snapshot.creditLimit.currency !== currency) {
    return `a ${currency} program cannot carry a limit of ${snapshot.creditLimit.toString()}`;
  }

  if (snapshot.outstandingTotal.currency !== currency) {
    return `the outstanding checksum total ${snapshot.outstandingTotal.toString()} is not in ${currency}`;
  }

  if (snapshot.repaidTotal.currency !== currency) {
    return `the repaid checksum total ${snapshot.repaidTotal.toString()} is not in ${currency}`;
  }

  for (const entry of snapshot.invoices) {
    if (entry.amount.currency !== currency) {
      return `invoice ${entry.invoiceId} reports ${entry.amount.toString()} against a ${currency} program`;
    }
  }

  return null;
}

/**
 * The first entry reporting an amount below zero, as the rejection sentence,
 * or `null`. Run after {@link firstForeignAmount}, so an entry that is both
 * reports the more useful fault. Every status is examined.
 */
function firstNegativeAmount(snapshot: TreasurySnapshot): string | null {
  for (const entry of snapshot.invoices) {
    if (entry.amount.isNegative()) {
      return `invoice ${entry.invoiceId} reports ${entry.amount.toString()}, and a negative amount can cancel another entry inside a stated total`;
    }
  }

  return null;
}

/**
 * Whether all four checksums describe the list the snapshot actually carries.
 * One pass, two pairs, each summed and counted together — the repaid pair is
 * the only integrity check on the path that frees capacity.
 */
function checksumFault(
  currency: CurrencyCode,
  snapshot: TreasurySnapshot,
): string | null {
  let outstandingTotal = Money.zero(currency);
  let outstandingCount = 0;
  let repaidTotal = Money.zero(currency);
  let repaidCount = 0;

  for (const entry of snapshot.invoices) {
    if (entry.status === 'OUTSTANDING') {
      outstandingTotal = outstandingTotal.add(entry.amount);
      outstandingCount += 1;
    } else {
      repaidTotal = repaidTotal.add(entry.amount);
      repaidCount += 1;
    }
  }

  const faults: string[] = [];

  if (
    !outstandingTotal.equals(snapshot.outstandingTotal) ||
    outstandingCount !== snapshot.invoiceCount
  ) {
    faults.push(
      `the outstanding entries sum to ${outstandingTotal.toString()} over ${outstandingCount} invoice(s), but the snapshot claims ${snapshot.outstandingTotal.toString()} over ${snapshot.invoiceCount}`,
    );
  }

  if (
    !repaidTotal.equals(snapshot.repaidTotal) ||
    repaidCount !== snapshot.repaidCount
  ) {
    faults.push(
      `the repaid entries sum to ${repaidTotal.toString()} over ${repaidCount} invoice(s), but the snapshot claims ${snapshot.repaidTotal.toString()} over ${snapshot.repaidCount}`,
    );
  }

  return faults.length === 0 ? null : faults.join('; ');
}

/**
 * Judges a whole snapshot before a single invoice is looked at, and answers
 * with the first failing gate, in order: WRONG_PROGRAM, UNUSABLE_SEQUENCE,
 * STALE_SEQUENCE, COUNTER_DRIFT, UNREADABLE_AS_OF, UNUSABLE_LIMIT,
 * FOREIGN_CURRENCY, NEGATIVE_AMOUNT, BLANK_INVOICE_ID, DUPLICATE_INVOICE,
 * CHECKSUM_MISMATCH. `null` when the snapshot is fit to diff.
 */
function screenSnapshot(
  program: Program,
  snapshot: TreasurySnapshot,
  appliedSequence: number | null,
  activeTotal: Money,
): SnapshotRejection | null {
  const refuse = (
    reason: SnapshotRejectionReason,
    detail: string,
  ): SnapshotRejection => ({
    verdict: 'REJECT',
    reason,
    origin: REJECTION_ORIGIN[reason],
    detail,
    sequence: snapshot.sequence,
    appliedSequence,
  });

  if (snapshot.programId.trim() !== program.id) {
    return refuse(
      'WRONG_PROGRAM',
      `the snapshot describes program ${snapshot.programId}, not ${program.id}`,
    );
  }

  if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) {
    return refuse(
      'UNUSABLE_SEQUENCE',
      `sequence ${String(snapshot.sequence)} is not a non-negative safe integer`,
    );
  }

  if (appliedSequence !== null && snapshot.sequence <= appliedSequence) {
    return refuse(
      'STALE_SEQUENCE',
      `sequence ${snapshot.sequence} is at or behind the applied watermark ${appliedSequence}`,
    );
  }

  const drift = counterDriftFault(program, activeTotal);

  if (drift !== null) {
    return refuse('COUNTER_DRIFT', drift);
  }

  if (Number.isNaN(snapshot.asOf.getTime())) {
    return refuse(
      'UNREADABLE_AS_OF',
      'asOf is not a readable instant, so no hold could be told in flight from missing',
    );
  }

  if (snapshot.creditLimit.isNegative()) {
    return refuse(
      'UNUSABLE_LIMIT',
      `a limit cannot be negative, got ${snapshot.creditLimit.toString()}`,
    );
  }

  const foreign = firstForeignAmount(program.currency, snapshot);

  if (foreign !== null) {
    return refuse('FOREIGN_CURRENCY', foreign);
  }

  const negative = firstNegativeAmount(snapshot);

  if (negative !== null) {
    return refuse('NEGATIVE_AMOUNT', negative);
  }

  // Two passes, so BLANK_INVOICE_ID is reported before DUPLICATE_INVOICE.
  for (const entry of snapshot.invoices) {
    if (entry.invoiceId.trim().length === 0) {
      return refuse(
        'BLANK_INVOICE_ID',
        `an entry reporting ${entry.amount.toString()} names no invoice, so nothing could be matched or resolved`,
      );
    }
  }

  const seen = new Set<string>();

  for (const entry of snapshot.invoices) {
    const invoiceId = entry.invoiceId.trim();

    if (seen.has(invoiceId)) {
      return refuse(
        'DUPLICATE_INVOICE',
        `invoice ${invoiceId} is listed twice, so the checksums no longer describe the invoices the snapshot claims to carry`,
      );
    }

    seen.add(invoiceId);
  }

  const checksum = checksumFault(program.currency, snapshot);

  return checksum === null ? null : refuse('CHECKSUM_MISMATCH', checksum);
}

/**
 * Whether an entry's own figures could open a reservation, asked only on the
 * path that creates one. Restates `Reservation.open`'s rules so a snapshot
 * wrong about one invoice produces a discrepancy rather than an exception.
 */
function assessFxEvidence(entry: TreasuryInvoice): EvidenceFault | null {
  const { amount, originalAmount, rate } = entry;
  const converted = originalAmount.currency !== amount.currency;

  if (converted && rate === null) {
    return {
      reason: 'MISSING_FX_EVIDENCE',
      detail: `${originalAmount.toString()} is reported as ${amount.toString()} with no rate to explain it`,
    };
  }

  if (!converted && rate !== null) {
    return {
      reason: 'INCONSISTENT_FX_EVIDENCE',
      detail: `a ${rate.base}/${rate.quote} rate is reported although nothing was converted`,
    };
  }

  if (
    rate !== null &&
    (rate.base !== originalAmount.currency || rate.quote !== amount.currency)
  ) {
    return {
      reason: 'INCONSISTENT_FX_EVIDENCE',
      detail: `rate ${rate.base}/${rate.quote} does not price ${originalAmount.currency} into ${amount.currency}`,
    };
  }

  if (!originalAmount.isPositive()) {
    return {
      reason: 'INCONSISTENT_FX_EVIDENCE',
      detail: `an exposure of ${amount.toString()} cannot come from an invoice of ${originalAmount.toString()}`,
    };
  }

  if (rate === null) {
    return amount.equals(originalAmount)
      ? null
      : {
          reason: 'INCONSISTENT_FX_EVIDENCE',
          detail: `${amount.toString()} is reported for an invoice of ${originalAmount.toString()} with nothing converted`,
        };
  }

  const reproduced = applyRate(originalAmount, rate);

  return reproduced.equals(amount)
    ? null
    : {
        reason: 'INCONSISTENT_FX_EVIDENCE',
        detail: `rate ${rate.toDecimalString()} turns ${originalAmount.toString()} into ${reproduced.toString()}, not ${amount.toString()}`,
      };
}

/**
 * Decides what a treasury snapshot means for a program. Pure: no I/O, no
 * clock, no randomness; nothing is written.
 *
 * Gate order: see {@link screenSnapshot}. Per-invoice diff: docs/PLAN.md 2.1.
 * Invoice ids are trimmed on both sides before matching.
 *
 * The clock-skew margin applies to both directions of the race: `cutoff = asOf
 * - clockSkewMarginMs`; a hold the snapshot omits is in flight when
 * `reservedAt >= cutoff`, a release treasury contradicts is in flight the same
 * way against `releasedAt`. Exactly at the cutoff, both count as in flight. An
 * instant that cannot be read fails the test and is flagged, which costs only
 * its own invoice a discrepancy, never the whole snapshot.
 *
 * A correction is judged only on the amount in the program's currency — FX
 * evidence is needed to open a reservation, never to restate one.
 *
 * @throws {InvalidReconciliationInputError} if `clockSkewMarginMs` is invalid;
 * if the program's reserved total, or any reservation, is in the wrong
 * currency or belongs to another program; or if two reservations name the
 * same invoice. See `COUNTER_DRIFT` for the faults of ours answered with a
 * rejection instead of an exception.
 */
export function reconcileProgram(
  input: ReconciliationInput,
): ReconciliationOutcome {
  const { program, reservations, snapshot, appliedSequence } = input;

  const clockSkewMarginMs = resolveClockSkewMargin(input.clockSkewMarginMs);
  const { holds, activeTotal } = indexReservations(program, reservations);
  const rejection = screenSnapshot(
    program,
    snapshot,
    appliedSequence,
    activeTotal,
  );

  if (rejection !== null) {
    return rejection;
  }

  // Shared by both directions of the race.
  const cutoff = snapshot.asOf.getTime() - clockSkewMarginMs;

  // One list per group: the groups are the step order (see `ReconciliationStep`).
  const releases: ReleaseHoldStep[] = [];
  const decreases: CorrectHoldStep[] = [];
  const increases: CorrectHoldStep[] = [];
  const creations: CreateHoldStep[] = [];
  const discrepancies: Discrepancy[] = [];
  const mentioned = new Set<string>();

  for (const entry of snapshot.invoices) {
    const invoiceId = entry.invoiceId.trim();
    const hold = holds.get(invoiceId) ?? null;

    mentioned.add(invoiceId);

    if (entry.status === 'REPAID') {
      // Only where a hold is still active; a release frees what it carries,
      // not treasury's reported amount.
      if (hold !== null && hold.isActive()) {
        releases.push({
          action: 'RELEASE',
          invoiceId,
          reservation: hold,
          reason: 'REPAID',
        });
      }

      continue;
    }

    if (!entry.amount.isPositive()) {
      discrepancies.push({
        reason: 'UNUSABLE_AMOUNT',
        invoiceId,
        held: hold?.reservedAmount ?? null,
        localStatus: hold?.status ?? null,
        reported: entry.amount,
        reportedStatus: entry.status,
        detail: `treasury reports an outstanding exposure of ${entry.amount.toString()}, which neither a hold nor a correction can carry`,
      });

      continue;
    }

    if (hold === null) {
      const fault = assessFxEvidence(entry);

      if (fault !== null) {
        discrepancies.push({
          reason: fault.reason,
          invoiceId,
          held: null,
          localStatus: null,
          reported: entry.amount,
          reportedStatus: entry.status,
          detail: fault.detail,
        });

        continue;
      }

      creations.push({
        action: 'CREATE',
        invoiceId,
        // Assembled from the snapshot alone, never an FX lookup (docs/PLAN.md 2.3).
        amount: {
          original: entry.originalAmount,
          converted: entry.amount,
          rate: entry.rate,
        },
      });

      continue;
    }

    if (hold.isReleased()) {
      const releasedAt = hold.releasedAt;

      // The other direction of the race, against the same cutoff. No readable
      // instant means no benefit of the doubt.
      if (releasedAt !== null && releasedAt.getTime() >= cutoff) {
        continue;
      }

      discrepancies.push({
        reason: 'REPORTED_AGAINST_RELEASED_HOLD',
        invoiceId,
        held: hold.reservedAmount,
        localStatus: hold.status,
        reported: entry.amount,
        reportedStatus: entry.status,
        detail: `treasury reports ${entry.amount.toString()} outstanding for a hold this service released on ${describeInstant(releasedAt)}`,
      });

      continue;
    }

    const heldAmount = hold.reservedAmount;
    const direction = entry.amount.compare(heldAmount);

    if (direction === 0) {
      continue;
    }

    const correction: CorrectHoldStep = {
      action: 'CORRECT',
      invoiceId,
      reservation: hold,
      heldAmount,
      correctedAmount: entry.amount,
    };

    // The sign decides the group, not the caller.
    (direction < 0 ? decreases : increases).push(correction);
  }

  const forgotten: Discrepancy[] = [];

  for (const reservation of reservations) {
    const invoiceId = reservation.invoiceId.trim();

    if (!reservation.isActive() || mentioned.has(invoiceId)) {
      continue;
    }

    if (reservation.reservedAt.getTime() >= cutoff) {
      continue;
    }

    forgotten.push({
      reason: 'HELD_BUT_NOT_REPORTED',
      invoiceId,
      held: reservation.reservedAmount,
      localStatus: reservation.status,
      reported: null,
      reportedStatus: null,
      detail: `this service holds ${reservation.reservedAmount.toString()} taken at ${describeInstant(reservation.reservedAt)}, which the snapshot as of ${snapshot.asOf.toISOString()} does not mention; the hold is kept`,
    });
  }

  forgotten.sort((left, right) => byInvoiceId(left.invoiceId, right.invoiceId));

  const steps: ReconciliationStep[] = [
    ...releases,
    ...decreases,
    ...increases,
    ...creations,
  ];

  // Limit change last: emitted only when it actually moves.
  if (!snapshot.creditLimit.equals(program.creditLimit)) {
    steps.push({
      action: 'CHANGE_LIMIT',
      previousCreditLimit: program.creditLimit,
      creditLimit: snapshot.creditLimit,
    });
  }

  return {
    verdict: 'APPLY',
    appliedSequence: snapshot.sequence,
    // Cloned, so a caller reading `lastReconciledAt` off the plan cannot move
    // the instant it reported — nor reach the snapshot's own `Date`.
    reconciledAt: new Date(snapshot.asOf.getTime()),
    steps,
    discrepancies: [...discrepancies, ...forgotten],
    projectedReserved: projectReserved(program, steps),
  };
}

/**
 * The reserved total once every step is applied: current total plus the
 * signed sum of the steps, not clamped.
 */
function projectReserved(
  program: Program,
  steps: readonly ReconciliationStep[],
): Money {
  let reserved = program.reserved;

  for (const step of steps) {
    switch (step.action) {
      case 'RELEASE':
        reserved = reserved.subtract(step.reservation.outstandingAmount);
        break;
      case 'CORRECT':
        reserved = reserved.subtract(step.heldAmount).add(step.correctedAmount);
        break;
      case 'CREATE':
        reserved = reserved.add(step.amount.converted);
        break;
      case 'CHANGE_LIMIT':
        break;
    }
  }

  return reserved;
}

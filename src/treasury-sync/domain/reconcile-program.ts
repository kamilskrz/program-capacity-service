/**
 * Reconciliation of a program against a treasury snapshot, as a pure function
 * (docs/PLAN.md 2.1, 2.10).
 *
 * **What this file is.** The per-invoice diff table of docs/PLAN.md 2.1, the
 * `sequence` watermark, the `asOf` in-flight rule and the checksum gate, stated
 * once, with no database, no broker, no clock and no randomness anywhere near
 * them. It decides; it applies nothing. Cycle 8 takes the plan it returns and
 * executes it inside one `em.transactional()` through `Program`'s own operations
 * (docs/PLAN.md 2.4, 3: `treasury-sync` never writes to `capacity` tables).
 *
 * **The governing rule, which every branch here is bent around: when in doubt,
 * hold the capacity — never release it.** A snapshot may add a hold or correct
 * one. It never releases a hold because data is *absent*: a treasury-side bug
 * that publishes an empty invoice list would otherwise free an entire limit in
 * one message. The only thing that releases a hold is treasury positively
 * saying, of that invoice, that it is repaid. The cost — a lost repayment keeps
 * capacity held until somebody resolves the discrepancy — is an error in the
 * safe direction, and it is recorded rather than silent.
 *
 * **Why a pure function rather than a service.** This is the densest logic in
 * the service and the only part whose input space is genuinely a table: eight
 * ways to reject a snapshot, six per-invoice situations, a boundary comparison
 * on two clocks. Every one of those cases is one object literal away when the
 * decision is a function of its arguments, and one Postgres container plus one
 * Kafka broker away when it is not. Nothing here is asynchronous, so nothing
 * here can interleave, and a failure in a test names a rule rather than a
 * transaction.
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
 *
 * **Decision: `REPAID` is a value a snapshot may carry, not only a value an
 * `InvoiceRepaid` message carries.** docs/PLAN.md 2.1 lists "Treasury says
 * REPAID, locally ACTIVE → release" as a *snapshot* diff rule while also
 * describing the snapshot as a list of **outstanding** invoices, and the two
 * cannot both be taken literally: under the governing rule, absence from the
 * list is explicitly not a release, so if the list could only ever contain
 * outstanding invoices there would be no snapshot-driven release at all and that
 * row of the table would be unreachable. §2.2 settles it by giving each entry a
 * `status` field, which is redundant unless some entries are not outstanding.
 *
 * So: an entry is the positive evidence the governing rule asks for. `REPAID`
 * means treasury is telling us, of this invoice, that the money came back —
 * which is exactly the statement that may free capacity. A snapshot that carries
 * only outstanding entries is still perfectly valid; it simply releases nothing,
 * and the repayments it implies surface as discrepancies instead.
 */
export type TreasuryInvoiceStatus = 'OUTSTANDING' | 'REPAID';

/**
 * One invoice as treasury reports it.
 *
 * `amount` is the exposure in the **program's** currency — the figure that
 * consumes the limit and the only figure reconciliation acts on. `originalAmount`
 * is the invoice as it was issued (docs/PLAN.md 2.2: "amount in program currency
 * plus the original"), and it is only ever *stored*, never used to recompute
 * `amount`: treasury wins on exposure, and re-deriving its number from its
 * original would be this service quietly disagreeing with the authority it is
 * reconciling against.
 *
 * `rate` is the addition this cycle makes to the message format of
 * docs/PLAN.md 2.2, and it is not optional dressing — see
 * {@link reconcileProgram} and `DiscrepancyReason`'s `MISSING_FX_EVIDENCE`.
 * Cycle 2's `Reservation.open` refuses a hold whose original and held currencies
 * differ with no rate to explain the difference (the two FX fields are nullable
 * *together*, docs/PLAN.md 2.3), so a foreign-currency invoice that this service
 * learns about only through a snapshot cannot become a reservation unless the
 * snapshot says which rate produced the figure it is reporting. The alternatives
 * were to synthesise an identity rate (a quote nobody made, written into the
 * audit trail as evidence) or to restate the original in the program currency (a
 * lie about what the supplier invoiced, and a future REST replay for the same
 * invoice would then read as a `409` — docs/PLAN.md 2.5 compares *original*
 * amounts). Both corrupt the record permanently and invisibly; asking the
 * producer for the rate it already used does not.
 *
 * `rate` is `null` if and only if `originalAmount` and `amount` are in the same
 * currency, the same invariant `Conversion` carries.
 */
export interface TreasuryInvoice {
  readonly invoiceId: string;
  readonly status: TreasuryInvoiceStatus;
  /** The outstanding exposure, in the program's currency. */
  readonly amount: Money;
  /** The invoice as issued, in whatever currency it was issued in. */
  readonly originalAmount: Money;
  /**
   * The rate treasury used to state {@link amount} from {@link originalAmount},
   * `null` when no conversion was involved.
   */
  readonly rate: FxRate | null;
}

/**
 * A full-state snapshot of one program, as published on
 * `treasury.program-events` (docs/PLAN.md 2.1, 2.2).
 *
 * This is the shape *after* the anti-corruption layer: currency codes are
 * parsed, amounts are `Money`, timestamps are `Date`. What it is not is
 * *trusted* — every field is still checked here, because the checks that matter
 * are the ones no JSON schema can express (does the checksum add up, is the
 * limit in the program's currency, is one invoice listed twice), and because a
 * snapshot that would make `Program` throw halfway through a transaction has to
 * be rejected before the transaction opens rather than rolled back out of it.
 *
 * **The checksums come in two pairs, one per status** (docs/PLAN.md 2.2).
 * `outstandingTotal` with `invoiceCount` covers the entries whose status is
 * `OUTSTANDING`; `repaidTotal` with `repaidCount` covers the `REPAID` ones. Each
 * pair has to describe *one and the same set* as its partner, or neither figure
 * verifies anything: a checksum is useful precisely because a truncated or
 * duplicated list fails it, and a count taken over a different set than the
 * total would leave a gap where a dropped entry could cancel a gained one.
 *
 * **Why the repaid entries need a pair of their own.** A single pair over the
 * outstanding entries leaves the release path — the only path in this whole file
 * that *frees* capacity — with no integrity check whatsoever, because the
 * outstanding figures are correct precisely by ignoring the repaid entries. One
 * fabricated `REPAID` line would then free an entire hold while both checksums
 * agreed: a snapshot reading `[REPAID invoice-a 0.01]` with `outstandingTotal
 * 0.00` over `0` invoices is internally consistent and releases 9,000,000.00.
 * That is the one way arithmetic can defeat the governing rule, so the entries
 * that can free capacity are the entries verified most, and a mismatch in either
 * pair rejects the whole snapshot.
 *
 * A repaid entry's `amount` therefore has to be stated even though nothing in the
 * diff reads it: a release frees what the *hold* carries (docs/PLAN.md 2.3), so
 * the figure's only job is to be checksummed.
 */
export interface TreasurySnapshot {
  /**
   * Checked against the program handed in. A mismatch is a wiring fault, not a
   * business outcome, but it is checked here for the same reason
   * `Program.release` checks it: the consequence otherwise is capacity moving on
   * somebody else's limit with nothing downstream to explain it.
   */
  readonly programId: string;
  /**
   * The monotonically increasing publication counter of docs/PLAN.md 2.1. A
   * `number` rather than a `bigint`, matching `CapacityEventMetadata.snapshotSequence`.
   */
  readonly sequence: number;
  /** The instant the snapshot describes: treasury's clock, not ours. */
  readonly asOf: Date;
  /** Treasury owns the limit (docs/PLAN.md 2.1). */
  readonly creditLimit: Money;
  readonly invoices: readonly TreasuryInvoice[];
  /** Checksum: the sum of `amount` over the `OUTSTANDING` entries. */
  readonly outstandingTotal: Money;
  /** Checksum: how many `OUTSTANDING` entries there are. */
  readonly invoiceCount: number;
  /**
   * Checksum: the sum of `amount` over the `REPAID` entries — the integrity
   * check on the only path that frees capacity. See the note above.
   */
  readonly repaidTotal: Money;
  /** Checksum: how many `REPAID` entries there are. */
  readonly repaidCount: number;
}

/**
 * Why a whole snapshot was thrown away (docs/PLAN.md 2.1: "ignore the
 * snapshot", "reject the whole snapshot").
 *
 * **Decision: one flat, granular union rather than a coarse one plus free
 * text.** Both a stale `sequence` and a failed checksum mean "apply nothing",
 * but cycle 8 must treat them as different events — one is the routine
 * consequence of at-least-once delivery and redelivery after a redeploy, the
 * other is a data fault that belongs in the DLQ with somebody's attention
 * (docs/PLAN.md 2.8: `kafka_dlq_total`, and the README's alert on rising DLQ
 * volume). Exactly one member of this union is routine, {@link
 * SnapshotRejectionReason} names it, and everything else is a fault. Cycle 8
 * therefore switches on this value and the compiler tells it when a new fault
 * appears, which a boolean flag or a parsed message would not.
 *
 * Granular rather than two or three members with the specifics in `detail`,
 * because these are the labels of a metric. Eleven known values give an operator a
 * breakdown; two values plus a free-text field give them a grep.
 *
 * Two members report a fault in **this service** rather than in the message, and
 * {@link SnapshotRejection.origin} is how a caller tells them apart without
 * matching string literals. They are rejections all the same, and not exceptions,
 * because every snapshot for the program is genuinely unappliable until somebody
 * looks: the answer "apply nothing, and alarm" is exactly what a rejection means,
 * and raising it as an exception would make the routine arrival of a message
 * crash a consumer that has nothing wrong with the message.
 *
 * | reason | origin | routine? | what happened |
 * |---|---|---|---|
 * | `STALE_SEQUENCE` | `TREASURY` | yes | `sequence <= ` the applied watermark |
 * | `WRONG_PROGRAM` | `SERVICE` | no | the snapshot describes another program than the one we loaded |
 * | `COUNTER_DRIFT` | `SERVICE` | no | **our** counter disagrees with our own active holds |
 * | `UNUSABLE_SEQUENCE` | `TREASURY` | no | not a non-negative safe integer |
 * | `UNREADABLE_AS_OF` | `TREASURY` | no | `asOf` is not a readable instant |
 * | `FOREIGN_CURRENCY` | `TREASURY` | no | a limit, checksum or entry amount outside the program's currency |
 * | `NEGATIVE_AMOUNT` | `TREASURY` | no | an entry amount below zero, which makes a checksum a lie |
 * | `UNUSABLE_LIMIT` | `TREASURY` | no | a negative credit limit |
 * | `BLANK_INVOICE_ID` | `TREASURY` | no | an entry that names no invoice |
 * | `DUPLICATE_INVOICE` | `TREASURY` | no | one invoice listed twice |
 * | `CHECKSUM_MISMATCH` | `TREASURY` | no | a total or a count disagrees with the entries it covers |
 */
export type SnapshotRejectionReason =
  /**
   * Already applied, or superseded by one we applied later (docs/PLAN.md 2.1:
   * `sequence <= last applied` → ignore). **The routine one**: Kafka redelivers,
   * a consumer restarts, a partition is reassigned. It is a log line and a
   * metric, never an alarm and never the DLQ.
   */
  | 'STALE_SEQUENCE'
  /**
   * The snapshot's `programId` is not the program's.
   *
   * Carries `origin: 'SERVICE'`, which may read oddly for a value taken out of
   * the message, so the reasoning: this gate cannot fire on a mis-keyed message.
   * A snapshot naming a program that does not exist never reaches this function —
   * cycle 8's lookup fails first, and docs/PLAN.md 2.9 sends *that* to the DLQ as
   * treasury's typo. Reaching here means cycle 8 loaded program A, locked it, and
   * handed it a snapshot for program B: both exist, the message is very likely
   * fine, and the fault is in our routing. Filing it in the producer's DLQ would
   * page treasury over a bug only we can fix, and the snapshot would be lost for
   * the program it was actually about.
   */
  | 'WRONG_PROGRAM'
  /**
   * `sequence` is not a non-negative safe integer — `NaN`, fractional, negative,
   * or past 2^53 where `number` stops counting in ones. Checked before the
   * watermark comparison, which every such value would silently pass: `NaN <= n`
   * is `false`, so an unusable sequence would read as "newer than anything we
   * have applied" and would then be stored as the watermark, freezing the
   * program's reconciliation for good.
   */
  | 'UNUSABLE_SEQUENCE'
  /**
   * The program's denormalized `reserved` total does not equal the sum of the
   * **active** holds handed in — the invariant of docs/PLAN.md 2.4,
   * `reserved_amount == SUM(active reservations)`, found broken before anything
   * is computed on top of it. Released holds are not summed: they carry nothing
   * towards the total, which is the whole point of releasing them.
   *
   * The only fault in this union that is ours rather than treasury's, and the
   * only one the next message cannot fix. It is rejected for two reasons and
   * healed for none:
   *
   * - **Every plan computed on a drifted counter is unappliable.** One hold of
   *   1.00 with a counter of 0.00, corrected to 1.01, projects a reserved total
   *   of −0.99; `Program.correctReservation` refuses it (`CapacityInvariantError`,
   *   and §2.4 forbids a negative counter outright), so the transaction throws —
   *   and so does the next snapshot's, and the next, because nothing in the
   *   sequence heals the counter. The program stops reconciling for good with a
   *   stack trace as the only explanation.
   * - **Saying nothing is worse.** A plain drift — a counter of 5.00 against two
   *   holds of 1.00 — reconciles *completely clean*: no steps, no discrepancies,
   *   the snapshot recorded as applied, and the service still reporting an
   *   exposure treasury has just contradicted. The one figure clients read would
   *   be wrong, permanently, with a fresh audit entry asserting it was checked.
   *
   * It is **not** healed automatically, deliberately (docs/PLAN.md 2.1). Writing
   * the corrected figure would erase the evidence of whatever wrote the wrong one
   * — a lost transaction, a hand-edited row, a bug in a release path — and that
   * evidence is the only thing that can find the cause. The audit log
   * (docs/PLAN.md 2.8) can reconstruct the true total; a reconciliation that
   * quietly overwrote it would leave nothing to compare against.
   */
  | 'COUNTER_DRIFT'
  /**
   * `asOf` is not a readable instant. Refused rather than tolerated because
   * every comparison against `NaN` is `false`: the in-flight rule would classify
   * *every* hold as older than the snapshot and flag the lot, which is the one
   * failure mode that turns a safe rule into a flood of false discrepancies.
   */
  | 'UNREADABLE_AS_OF'
  /**
   * An amount that has to be in the program's currency is not: the credit limit,
   * the checksum total, or an entry's outstanding `amount`. (An entry's
   * *original* amount may of course be in any currency — that is the point of
   * recording it.)
   *
   * A whole-snapshot rejection rather than a per-entry discrepancy, unlike an
   * amount of zero, and the difference is not arbitrary: a foreign entry amount
   * makes the checksum uncomputable — `Money.add` refuses to sum USD into a EUR
   * total, and rightly — so the snapshot cannot be verified at all, and an
   * unverifiable snapshot is exactly what the checksum gate exists to discard.
   */
  | 'FOREIGN_CURRENCY'
  /**
   * An entry reporting an amount below zero, whatever its status.
   *
   * A whole-snapshot rejection on exactly the argument `FOREIGN_CURRENCY`
   * rests on, arrived at from the other direction: a negative entry does not make
   * the checksum uncomputable, it makes it *unable to fail*. Two entries of
   * 10,000.00 and −10,000.00 sum to a stated total of 0.00 over a stated count of
   * 2, so the pair verifies a list that says a supplier owes the funder money —
   * and an arbitrary amount of real exposure can be hidden behind an entry that
   * cancels it. A gate whose sum can be steered by its own input is not a gate.
   *
   * Zero is deliberately *not* here: it cannot cancel anything, so the checksums
   * still do their job and the entry is flagged on its own as `UNUSABLE_AMOUNT`,
   * leaving the other 199 invoices reconciled.
   */
  | 'NEGATIVE_AMOUNT'
  /**
   * A negative credit limit. `Program.changeCreditLimit` refuses it
   * (`InvalidCreditLimitError`), so letting it through would mean discovering
   * the fault as an exception midway through cycle 8's transaction, after other
   * steps had already been applied and with the rollback as the only thing
   * separating the program from a half-reconciled state.
   */
  | 'UNUSABLE_LIMIT'
  /**
   * An entry whose invoice id is empty or whitespace. It cannot be matched
   * against a reservation, and it cannot even be flagged as a discrepancy: a
   * discrepancy exists to be resolved by a human, and one that names no invoice
   * names nothing to resolve.
   */
  | 'BLANK_INVOICE_ID'
  /**
   * The same invoice listed twice (after trimming), whether the two entries
   * agree or not.
   *
   * Not deduplicated, deliberately. Picking one of two entries means choosing
   * which exposure is real on the producer's behalf, and even when the two are
   * identical the checksums no longer describe the invoices the snapshot claims
   * to carry — a list of 200 invoices with one duplicated is a list of 199 with
   * one counted twice, and the diff would be right about one invoice and wrong
   * about the total. A producer repeating an invoice has a bug, and the bug is
   * worth a message in the DLQ.
   */
  | 'DUPLICATE_INVOICE'
  /**
   * Any of the four checksums disagrees with the entries it covers — the
   * "checksums do not match" row of docs/PLAN.md 2.1. One is enough, and the
   * repaid pair counts for exactly as much as the outstanding one: it is the only
   * check standing between a fabricated `REPAID` line and a freed hold (see
   * {@link TreasurySnapshot}).
   *
   * A total that adds up while its count does not is a *more* alarming message
   * than a plain truncation, not a less alarming one: entries were lost and
   * gained in amounts that happened to cancel.
   */
  | 'CHECKSUM_MISMATCH';

/**
 * Which side of the boundary a rejection is a statement about.
 *
 * **Decision: the side is a property of the value, not knowledge a caller is
 * expected to carry.** Cycle 8 has to answer one question about every rejection
 * before it does anything else — does this message belong in the producer's DLQ?
 * — and getting it wrong is expensive in both directions: a `SERVICE` rejection
 * filed as poison puts `kafka_dlq_total` and the README's DLQ alert on treasury's
 * desk over a bug only we can fix, and loses a snapshot that was never faulty,
 * while a `TREASURY` rejection swallowed as our own problem drops a genuinely
 * corrupt message with nobody told. Deriving the answer from a ten-member union
 * means hardcoding two literals at the call site and revisiting every such site
 * whenever a reason is added — which is exactly the kind of knowledge that is held
 * in one team's head until the day it is not.
 *
 * `TREASURY` — the rejection is about the message: its sequence, its figures, its
 * list. The snapshot is what has to change, so the DLQ is the right place for it
 * and a metric counting it is counting the producer's health. `STALE_SEQUENCE` is
 * a `TREASURY` verdict that is nonetheless *routine* — the message is superseded,
 * not wrong — which is why origin and routine-ness are two axes and not one: the
 * table on {@link SnapshotRejectionReason} states both.
 *
 * `SERVICE` — the rejection is about this service's own state: a drifted counter,
 * or a program that is not the one the snapshot is for. Nothing about the message
 * needs fixing, so it must not be filed against the producer, and replaying it
 * will keep failing until somebody here changes something.
 */
export type RejectionOrigin = 'TREASURY' | 'SERVICE';

/**
 * Which side each reason blames — the mapping stated once, as data.
 *
 * A `Record` keyed by {@link SnapshotRejectionReason}, so a reason added without an
 * origin does not compile. That is the point of writing it as a table rather than
 * as a `switch` or as a literal at each `refuse` call: the origin is a fixed
 * property of the reason, not a decision the gate that happens to fire gets to
 * make, and eleven gates each choosing their own would be eleven chances to choose
 * differently.
 */
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
  // Ours: see the reasons themselves. Neither is fixed by the next message, and
  // neither may be filed against the producer.
  WRONG_PROGRAM: 'SERVICE',
  COUNTER_DRIFT: 'SERVICE',
};

/**
 * A snapshot that will not be applied at all.
 *
 * Nothing partial: no steps, no discrepancies, no watermark movement. In
 * particular `STALE_SEQUENCE` leaves the applied watermark alone — it is already
 * at or past this snapshot — and a faulted snapshot leaves it alone too, so the
 * *next* snapshot is judged against the last one that was actually applied and a
 * corrupt message cannot make a good one look stale.
 */
export interface SnapshotRejection {
  readonly verdict: 'REJECT';
  readonly reason: SnapshotRejectionReason;
  /**
   * Whose state the rejection is about — and therefore whether the message may be
   * filed against the producer. Fixed per {@link reason}; see
   * {@link RejectionOrigin} and the table on {@link SnapshotRejectionReason}.
   */
  readonly origin: RejectionOrigin;
  /**
   * One sentence naming the figures involved, for the log line and the DLQ
   * envelope. Not a stable contract: `reason` is what code branches on.
   */
  readonly detail: string;
  /** The sequence the snapshot claimed, verbatim — including an unusable one. */
  readonly sequence: number;
  /** The watermark it was judged against; `null` if the program never reconciled. */
  readonly appliedSequence: number | null;
}

/**
 * Why one invoice could not be reconciled automatically — the
 * `DISCREPANCY_FLAGGED` event of docs/PLAN.md 2.8, and what
 * `treasury_reconciliation_discrepancies_total` counts.
 *
 * A discrepancy is never a capacity change. It is a statement that this service
 * and treasury disagree about one invoice in a way no rule may settle on its
 * own, recorded so that a human can settle it and a metric can notice how often
 * that is needed.
 */
export type DiscrepancyReason =
  /**
   * We hold an active reservation that the snapshot does not mention, and the
   * hold is older than `asOf` less the clock-skew margin — the fifth row of
   * docs/PLAN.md 2.1's table.
   *
   * **The hold is kept.** This is the governing rule's whole point: the likeliest
   * explanation is a repayment whose `InvoiceRepaid` we lost, but "treasury did
   * not mention it" is not the same statement as "treasury says it is repaid",
   * and only the second may free a limit.
   *
   * **Also where a hold with an unreadable `reservedAt` lands**, and deliberately
   * so. MikroORM hydrates without calling the constructor (docs/PLAN.md 2.6), so
   * `Reservation.rehydrate`'s guard against an unreadable instant is not on the
   * ORM's path and a corrupt row reaches here intact — `reservation.ts` says as
   * much and predicts this outcome. Every comparison against `NaN` is `false`, so
   * such a row cannot satisfy the in-flight test and sorts as older than the
   * cutoff, which is the safe direction: it is flagged for a person rather than
   * silently excused. The detail says the instant is unreadable instead of
   * formatting it, because `toISOString()` on an unreadable `Date` throws a
   * `RangeError` — and one corrupt row must not stop a program reconciling, which
   * is what an exception out of here would do.
   */
  | 'HELD_BUT_NOT_REPORTED'
  /**
   * Treasury reports an invoice as outstanding that this service has already
   * released.
   *
   * docs/PLAN.md 2.5 requires exactly this: correcting a released reservation is
   * an illegal transition (`ReservationStateError`), and reconciliation must
   * treat it as a discrepancy to flag rather than a capacity change. Flagged
   * whatever the amounts say, including when treasury's figure equals what the
   * hold used to carry — the disagreement is about the invoice being open at
   * all, and re-opening a released hold is refused by docs/PLAN.md 2.5 anyway
   * ("an invoice is financed exactly once").
   *
   * **Unless the release is itself in flight**: a hold released at or after
   * `asOf` less the clock-skew margin says nothing at all. The margin applies to
   * both directions of the race, which is the point of having one — a release
   * this service performed a second *after* treasury took its picture is as
   * routine as a reservation taken a second after it, and treasury reporting the
   * invoice as outstanding is then not a disagreement but the expected view of an
   * event it had not seen yet. Flagging it would report a discrepancy on every
   * snapshot that crossed a REST release or an `InvoiceRepaid`, which are the two
   * most ordinary things that happen to this service.
   *
   * A released hold whose `releasedAt` is **missing or unreadable** is flagged
   * rather than treated as in flight. Both are corrupt rows that only the
   * constructor-less hydration path can produce (docs/PLAN.md 2.6) — cycle 2
   * refuses either on the way in — and a row that cannot say when it was released
   * cannot claim the benefit of the margin: "in flight" is a claim about an
   * instant, so with no readable instant there is nothing to compare and the
   * benefit is not granted. The safe direction again, and the same reason it is
   * safe: flagging asks somebody to look, while the alternative silently excuses an
   * invoice both sides disagree about. The detail names the missing instant rather
   * than formatting it.
   */
  | 'REPORTED_AGAINST_RELEASED_HOLD'
  /**
   * The snapshot reports an invoice this service does not know, in a currency
   * other than the program's, with no rate.
   *
   * The one place the governing rule bends, and the decision is stated where it
   * is made rather than buried: the honest options are to record an exposure
   * with fabricated FX evidence or to record no exposure and say so loudly.
   * Fabricated evidence is permanent, invisible and contaminates the audit trail
   * this service exists to keep (docs/PLAN.md 2.3: a stored rate *is* evidence);
   * a flagged discrepancy is visible, counted, alerted on, and healed by the
   * next snapshot that carries the rate or by the REST reservation that should
   * have created the hold in the first place. Availability is overstated
   * meanwhile, which is why this is a discrepancy and not a log line.
   *
   * See {@link TreasuryInvoice}: with the rate in the message format, a
   * well-behaved producer never reaches this branch.
   */
  | 'MISSING_FX_EVIDENCE'
  /**
   * The snapshot reports an invoice this service does not know, and its own
   * figures contradict each other: a rate for the wrong pair, a rate recorded
   * although nothing was converted, two different amounts in one currency, or a
   * rate that does not reproduce the amount reported next to it.
   *
   * Checked here rather than left to `Reservation.open`, which applies the same
   * rules and would throw `InvalidReservationError` inside cycle 8's
   * transaction, discarding a snapshot that is wrong about one invoice and right
   * about 199. Note what "reproduce" means: cycle 1's `applyRate`, ceiling
   * rounding included (docs/PLAN.md 2.3). A producer that rounds to nearest will
   * land here on roughly half its foreign-currency invoices — see the report on
   * this cycle; that is a statement about the message contract, not about this
   * branch.
   */
  | 'INCONSISTENT_FX_EVIDENCE'
  /**
   * Treasury reports an outstanding exposure of exactly zero.
   *
   * Neither a hold nor a correction can carry it: a reservation must consume
   * capacity and a hold restated to nothing is a release, not a correction
   * (cycle 2's `Reservation.open` and `correctTo` both refuse it). A per-entry
   * discrepancy rather than a whole-snapshot rejection, because a zero leaves the
   * checksums computable *and* able to fail, so the other 199 invoices are still
   * worth reconciling.
   *
   * A *negative* amount is the other case and is not this one: it can cancel
   * another entry inside a stated total, so it takes the whole snapshot down as
   * `NEGATIVE_AMOUNT`.
   */
  | 'UNUSABLE_AMOUNT';

/**
 * One invoice this service and treasury disagree about, shaped so that a person
 * can resolve it months later and a metric can count it today (docs/PLAN.md 2.8).
 *
 * **Decision: both beliefs, side by side, in full.** The question a discrepancy
 * has to answer is "what did each side think, and why could that not be
 * settled?", so all three are fields: what we hold and in what state, what
 * treasury reported and in what state, and the reason. Either side may be
 * absent, and the absence is the evidence — `reported` and `reportedStatus` are
 * `null` exactly when the snapshot did not mention the invoice, `held` and
 * `localStatus` exactly when this service has no reservation for it. Storing a
 * pre-rendered sentence instead would make the row unqueryable; storing only the
 * reason would make it unresolvable.
 *
 * What is deliberately *not* here: the snapshot `sequence` and `asOf`. They are
 * identical for every discrepancy in one plan and they live on
 * {@link ReconciliationPlan}, which is what cycle 8 reads when it fills
 * `metadata.snapshotSequence`. Repeating them per row invites two copies to
 * disagree.
 */
export interface Discrepancy {
  readonly reason: DiscrepancyReason;
  readonly invoiceId: string;
  /** What this service holds for the invoice, or `null` if it holds nothing. */
  readonly held: Money | null;
  /** The local lifecycle state, or `null` if there is no reservation. */
  readonly localStatus: ReservationStatus | null;
  /**
   * What treasury reported, in the program's currency, or `null` if the snapshot
   * did not mention the invoice at all.
   */
  readonly reported: Money | null;
  /** Treasury's status, or `null` if the snapshot did not mention the invoice. */
  readonly reportedStatus: TreasuryInvoiceStatus | null;
  /** One sentence for a person reading the audit log. Not a contract. */
  readonly detail: string;
}

/**
 * Free the capacity a hold is carrying: the first row of docs/PLAN.md 2.1's
 * table, and the only step a snapshot can produce that reduces exposure.
 *
 * Cycle 8 runs `program.release(step.reservation, step.reason, context)`. The
 * amount is deliberately absent: a release frees **exactly what the hold
 * carries**, never a recomputed figure (docs/PLAN.md 2.3), which is why
 * `Reservation.release` takes no amount either. Treasury's reported amount for a
 * repaid invoice is not used at all — not even when it disagrees with the hold.
 * The exposure is ending; restating it first would churn the audit log to reach
 * the same zero.
 */
export interface ReleaseHoldStep {
  readonly action: 'RELEASE';
  readonly invoiceId: string;
  /**
   * The very instance handed in through {@link ReconciliationInput}, so cycle 8
   * passes the entity its unit of work is already tracking and does not look the
   * invoice up a second time (a second lookup is a second chance to miss).
   */
  readonly reservation: Reservation;
  /**
   * Always `REPAID` today, and stated rather than left to cycle 8 to invent:
   * only an explicit repaid entry releases anything here, and
   * `REPAID` versus `CANCELLED` is a distinction risk and audit read
   * (docs/PLAN.md 2.5). The type stays open because a cancellation arriving
   * through a snapshot would be this same step with the other reason.
   */
  readonly reason: ReleaseReason;
}

/**
 * Restate what a hold carries: "amounts differ → treasury wins; adjust and write
 * an audit entry" (docs/PLAN.md 2.1).
 *
 * Cycle 8 runs `program.correctReservation(step.reservation, step.correctedAmount,
 * context)`. Emitted only when the figures actually differ — a correction to the
 * amount already held is a no-op that produces no event (docs/PLAN.md 2.8), so a
 * snapshot repeating an unchanged invoice every few minutes must not fill the
 * log with adjustments that adjusted nothing, and the cheapest way to guarantee
 * that is for the plan not to contain the step.
 *
 * The original amount and the stored rate are **not** touched, even when
 * treasury's original disagrees with ours. A correction is the new truth about
 * exposure, not a new conversion (docs/PLAN.md 2.3): the rate was frozen when
 * the hold was taken and remains the evidence of what was quoted, and the
 * original amount is what the client stated and what a REST replay is compared
 * against (docs/PLAN.md 2.5). Rewriting either to match a snapshot would make an
 * honest retry look like a conflict.
 */
export interface CorrectHoldStep {
  readonly action: 'CORRECT';
  readonly invoiceId: string;
  readonly reservation: Reservation;
  /** What the hold carries now, so the plan reads as a fact on its own. */
  readonly heldAmount: Money;
  /** What treasury says it should carry, in the program's currency. */
  readonly correctedAmount: Money;
}

/**
 * Take a hold for an invoice treasury knows and this service does not: "treasury
 * knows the invoice, we do not → create the reservation" (docs/PLAN.md 2.1).
 *
 * Cycle 8 runs `program.recordTreasuryHold({ invoiceId, amount }, null,
 * context)` — reconciliation's own operation, **not** `program.reserve`. The two
 * differ in exactly one respect: `reserve` refuses a request that would breach
 * the credit limit, which is right for a client and wrong here, because the
 * exposure exists in treasury whether or not this service has room for it and
 * docs/PLAN.md 2.1 requires the resulting overrun to be *stored* rather than
 * refused. Everything else is checked identically, so a snapshot cannot state an
 * amount, a currency or an FX pairing that a client could not.
 *
 * The `existing` argument is `null` by construction — this step is only produced
 * for an invoice with no reservation at all — and `recordTreasuryHold` refuses a
 * non-null one outright instead of replaying it: a hold that exists means the
 * plan was computed against state that has since moved, which the next snapshot
 * heals, rather than a retry to smooth over. The conversion is complete and
 * already checked against everything `Reservation.open` demands, so the step
 * cannot fail on its own evidence either.
 *
 * The step ordering below therefore no longer has a capacity veto to work
 * around; it survives because it is still worth applying the plan in an order
 * whose intermediate totals never exceed its endpoints.
 */
export interface CreateHoldStep {
  readonly action: 'CREATE';
  readonly invoiceId: string;
  /**
   * The invoice, the exposure it creates in the program's currency, and the rate
   * that relates them — `null` when treasury reported it in the program's own
   * currency. Assembled from the snapshot, never from an FX lookup: the rate a
   * reservation stores has to be the rate that produced its amount, and today's
   * quote did not (docs/PLAN.md 2.3).
   */
  readonly amount: Conversion;
}

/**
 * Set the credit limit to treasury's: treasury owns the limit (docs/PLAN.md 2.1).
 *
 * Cycle 8 runs `program.changeCreditLimit(step.creditLimit, context)`. Emitted
 * only when the limit actually moves, for the same reason a correction is:
 * `changeCreditLimit` already answers a restatement of the current limit with no
 * event, and a plan that contains a step which does nothing is a plan a reviewer
 * cannot read as a list of changes.
 *
 * A reduction below current exposure is emitted without hesitation and leaves
 * the program over-utilised (docs/PLAN.md 2.1). Refusing it would mean this
 * service vetoing a funder's own risk decision, and the exposure would not go
 * away for being unrecorded.
 */
export interface ChangeCreditLimitStep {
  readonly action: 'CHANGE_LIMIT';
  /** What the program's limit is now — evidence for whoever reads the plan. */
  readonly previousCreditLimit: Money;
  readonly creditLimit: Money;
}

/**
 * One thing to do, in the order to do it.
 *
 * **Decision: a single ordered list of tagged steps, not one array per kind.**
 * Cycle 8 needs a `for` loop and a `switch` whose exhaustiveness the compiler
 * checks, and the order in which capacity moves has to be part of the *value*
 * rather than a sentence in a document that a future refactor will not read.
 * Separate `creates`, `corrections` and `releases` arrays would hand the
 * ordering decision back to the caller — the one place it must not be made,
 * since a snapshot that releases one hold and creates another inside a single
 * transaction is exactly where the intermediate state matters.
 *
 * **The order, and why.** Every step that frees capacity precedes every step
 * that consumes it: releases, then downward corrections, then upward
 * corrections, then creations. The reserved total therefore falls and then rises
 * as the plan is applied, so no intermediate value ever exceeds the larger of
 * the total before and the total after. Nothing in the plan is refused for want
 * of capacity — `Program.recordTreasuryHold` has no limit veto, which is the
 * whole point of it — so this is no longer what keeps a step from failing; it is
 * what keeps the intermediate states of a half-applied transaction sane for
 * anything reading them, and what keeps the plan's meaning independent of how it
 * is chunked.
 *
 * **The limit change goes last.** With no capacity check anywhere on this path
 * its position cannot change the outcome, so the reason is legibility rather
 * than correctness: the plan reads as "reconcile the exposure, then adopt the
 * limit it was measured against", and the resulting `overUtilized` verdict is
 * computed once, against treasury's new limit and treasury's full exposure,
 * instead of flickering as the two arrive in some other order.
 *
 * Within each group, snapshot order is preserved, so a plan can be read next to
 * the payload that produced it. The one exception is documented on {@link
 * ReconciliationPlan.discrepancies}.
 */
export type ReconciliationStep =
  ReleaseHoldStep | CorrectHoldStep | CreateHoldStep | ChangeCreditLimitStep;

/**
 * The decisions a snapshot leads to: everything cycle 8 needs to apply it inside
 * one transaction, and nothing it has to derive for itself.
 *
 * **Decision: the function decides completely, or not at all.** Anything cycle 8
 * would have to work out — which reservation an invoice refers to, what a hold
 * carries now, whether a correction is worth recording, the order — is decided
 * here, where it is tested against a table, and is carried in the value. A plan
 * that needed a second look at the snapshot to be applied would be a plan whose
 * rules live in two places, and the second place is inside a transaction that no
 * unit test can reach.
 */
export interface ReconciliationPlan {
  readonly verdict: 'APPLY';
  /**
   * The watermark to store: this snapshot's `sequence`. Stored **even for a plan
   * with no steps at all** — a snapshot that agrees with us in every particular
   * has still been applied, and not advancing the watermark would leave the
   * program re-judging it forever.
   */
  readonly appliedSequence: number;
  /**
   * Treasury's `asOf`, cloned. This is the value behind `lastReconciledAt` in
   * `GET /capacity` (docs/PLAN.md 2.7) and the input to
   * `treasury_snapshot_lag_seconds` (docs/PLAN.md 2.8): what a reader wants to
   * know is how current the *authority's* picture is, not when this service got
   * round to processing it.
   */
  readonly reconciledAt: Date;
  /** In application order. See {@link ReconciliationStep}. */
  readonly steps: readonly ReconciliationStep[];
  /**
   * Every invoice that could not be settled, each to be recorded as a
   * `DISCREPANCY_FLAGGED` event (docs/PLAN.md 2.8).
   *
   * Snapshot-driven discrepancies come first, in snapshot order; the
   * `HELD_BUT_NOT_REPORTED` ones follow, sorted by invoice id. Sorted rather
   * than left in the order the reservations arrived, because that order is
   * whatever the repository's query returned — a plan should not change because
   * Postgres chose a different access path, and a diff of two audit logs should
   * be about the invoices, not about row order.
   */
  readonly discrepancies: readonly Discrepancy[];
  /**
   * The program's reserved total once every step has been applied.
   *
   * Stated so that the plan checks itself: cycle 8 can assert the program's
   * counter against this figure after the transaction, which is the invariant of
   * docs/PLAN.md 2.4 (`reserved_amount == SUM(active reservations)`) applied to
   * the one operation most likely to break it. It equals the current reserved
   * total plus the signed sum of the steps, and it is **not** clamped: a
   * reduction of the limit or an upward correction may leave the program
   * over-utilised, and `creditLimit − projectedReserved` is how a reader sees by
   * how much.
   */
  readonly projectedReserved: Money;
}

/**
 * What {@link reconcileProgram} answers.
 *
 * A two-member tagged union rather than a plan with an `ignored` flag or a
 * nullable plan: "apply nothing" carries information — which fault, against
 * which watermark — that a plan has nowhere to put, and a caller holding a
 * `ReconciliationPlan` should not have to ask whether it is real. `verdict` is
 * the discriminant, so cycle 8's first line is a `switch` and the happy path
 * stays one branch deep.
 */
export type ReconciliationOutcome = ReconciliationPlan | SnapshotRejection;

/**
 * Everything the decision depends on. A pure function's whole state, named.
 */
export interface ReconciliationInput {
  /**
   * The program as it stands, read under `LockMode.PESSIMISTIC_WRITE` by the
   * caller (docs/PLAN.md 2.4). Read, never written: this function decides and
   * cycle 8 applies, so not one field of it moves here.
   */
  readonly program: Program;
  /**
   * **Every active hold**, plus **every reservation the snapshot names** whatever its
   * status. Not every reservation the program has ever had.
   *
   * Both halves are required and neither is padding. The active holds have to be
   * complete because the invariant of docs/PLAN.md 2.4 is checked here:
   * `program.reserved` must equal the sum of the **active** holds in this list or the
   * snapshot is rejected as `COUNTER_DRIFT`. A caller that filtered them would be
   * telling this function that capacity is held by nothing, so that half is all of
   * them or the answer is worthless. The named reservations have to include the
   * **released** ones because a snapshot repeating an invoice we already released
   * cannot otherwise be told apart from a snapshot naming an invoice we never knew,
   * and the two have opposite answers — a discrepancy versus a new hold.
   *
   * What is deliberately absent is a released reservation the snapshot is silent
   * about: no rule in docs/PLAN.md 2.1 consults one. The per-invoice rules each need
   * only the row for an invoice the snapshot mentions, the counter-drift gate sums
   * only active holds, and the held-but-not-reported rule skips non-active rows. So
   * the set is narrowed to what the rules read, and the read does not grow with the
   * program's lifetime history.
   *
   * The narrowing has one precondition, and it is the caller's: the identifiers used
   * to select the named reservations must include **every `OUTSTANDING` entry's**.
   * Drop one and its reservation is not loaded, so an invoice this service has already
   * released arrives here with no hold attached; this function reads that as "treasury
   * knows the invoice, we do not" and opens a **fresh hold** for it, instead of
   * flagging the `REPORTED_AGAINST_RELEASED_HOLD` discrepancy docs/PLAN.md 2.1
   * requires. That is capacity invented from nothing. The function cannot detect the
   * mistake, because an absent row and an unselected row look identical from here —
   * which is why it is stated as a precondition rather than checked.
   *
   * Passing the `REPAID` entries' identifiers too costs nothing and is worth doing,
   * but it is insurance and not a requirement: a repaid entry whose hold is already
   * released and a repaid entry with no local hold are both no-ops here, so omitting
   * the released row changes no outcome. A repaid entry whose hold is still active is
   * loaded anyway, by the active half of the set. The insurance is against a later
   * cycle giving those two cases different answers.
   *
   * A row here may be corrupt in ways cycle 2's factories would have refused,
   * because MikroORM hydrates without the constructor (docs/PLAN.md 2.6). Two such
   * faults are answered differently on purpose: a hold in the wrong currency or
   * from another program is an exception, since nothing about this program could be
   * decided around it, while an unreadable timestamp costs only its own invoice a
   * discrepancy — see the in-flight rule on {@link reconcileProgram}.
   */
  readonly reservations: readonly Reservation[];
  readonly snapshot: TreasurySnapshot;
  /**
   * The highest `sequence` already applied to this program, or `null` if it has
   * never been reconciled.
   *
   * `null` rather than a default of zero, because zero is a sequence a producer
   * may legitimately publish and "never reconciled" is a different statement
   * from "reconciled at sequence zero".
   *
   * Passed in rather than read off `Program`: cycle 2's aggregate has no such
   * field, and this cycle may not add one (see the report — the program row
   * needs `last_snapshot_sequence` and `last_reconciled_at` in the persistence
   * cycle).
   */
  readonly appliedSequence: number | null;
  /**
   * How far treasury's clock may run ahead of ours before a hold, or a release,
   * stops counting as in flight, in milliseconds. Defaults to
   * {@link DEFAULT_CLOCK_SKEW_MARGIN_MS} and may not exceed
   * {@link MAX_CLOCK_SKEW_MARGIN_MS}.
   *
   * @see reconcileProgram for the rule and the boundary.
   */
  readonly clockSkewMarginMs?: number;
}

/**
 * The default clock-skew margin: one minute.
 *
 * **Decision: a parameter with a default, and this is the default.**
 * docs/PLAN.md 2.1 keeps a reservation "newer than `asOf` (with clock-skew
 * margin)" without saying what the margin is, so:
 *
 * The margin exists because `reservedAt` and `asOf` are read from two different
 * clocks and the interval between them is not the only thing separating them. A
 * snapshot is produced (treasury reads its own database, serialises, publishes),
 * carried (broker, partition, consumer lag) and only then compared against our
 * timestamps. With a margin of zero, a hold taken a few hundred milliseconds
 * before treasury's cutoff on a host whose NTP offset runs the other way is
 * classified as old, flagged, and counted — and a correctly behaving system
 * emits false discrepancies on every snapshot, which is how a metric stops being
 * read.
 *
 * One minute is two orders of magnitude above the skew NTP leaves on a
 * reasonably maintained host and comfortably above the production and delivery
 * of a snapshot, while being far below anything that matters at the other end:
 * docs/PLAN.md 2.8 alerts on snapshot lag above two hours, so a genuinely missed
 * release is hidden for a minute out of the hours it was going to take to notice
 * anyway. Too large a margin is not free — it is exactly the window in which a
 * real missed release goes unflagged — which is why this is a minute and not an
 * hour.
 *
 * It is a parameter rather than a constant because it is an operational
 * property of a *deployment*: a treasury whose snapshot is a five-minute batch
 * job needs a larger one, and finding that out should change a configuration
 * value rather than this file. A pure function must also be able to have it
 * varied by a test without touching the value every other test depends on.
 */
export const DEFAULT_CLOCK_SKEW_MARGIN_MS = 60_000;

/**
 * The largest clock-skew margin that may be configured: two hours.
 *
 * **Decision: the margin has a ceiling, and it is the alerting threshold.** The
 * margin is the width of the window in which this service says nothing, so a
 * margin large enough is a switch that turns every discrepancy off — and it does
 * so silently, since a plan with no discrepancies is exactly what a healthy
 * program produces. `1e300` is a finite number and would be accepted by a check
 * that asked only for finiteness: the cutoff becomes −1e300, every hold and every
 * release reads as in flight, and the service reconciles clean for ever while
 * `treasury_reconciliation_discrepancies_total` stays flat. A typo of three
 * zeroes in a configuration value is not a plausible mistake to leave
 * unguarded.
 *
 * Two hours because docs/PLAN.md 2.8 alerts on snapshot lag above two hours. A
 * margin at that threshold is the widest one that can still be reasoned about:
 * anything it hides for longer than two hours is hidden inside a window that is
 * already paging somebody about the lag itself, so the margin cannot become the
 * reason a missed release goes unnoticed. Beyond it the two mechanisms would
 * cover for each other and neither would fire.
 *
 * Exceeding it is an {@link InvalidReconciliationInputError} — a configuration
 * fault on this side of the boundary, not news from treasury. A deployment that
 * genuinely needs a wider window has a producer whose snapshots are hours stale,
 * which is a conversation rather than a setting.
 */
export const MAX_CLOCK_SKEW_MARGIN_MS = 2 * 60 * 60 * 1_000;

/**
 * Inputs that are this service's own fault rather than treasury's.
 *
 * The distinction is the reason this is an exception and not a
 * {@link SnapshotRejection}: a rejection blames the producer, goes to the DLQ
 * and is counted as a data fault on their side. A reservation from another
 * program, or a negative clock-skew margin, is a bug or a misconfiguration
 * *here*, and answering it with a rejection would file a perfectly good snapshot
 * as poison and quietly stop reconciling the program.
 *
 * Carries the same {@link DomainError} base as cycles 1 and 2 so one exception
 * filter still maps it (docs/PLAN.md 2.7). Error construction is real code
 * rather than a stub, as in the earlier cycles: an error has no behaviour to
 * implement, and the tests have to be able to name the class and assert the code.
 */
export class InvalidReconciliationInputError extends DomainError {
  readonly code = 'INVALID_RECONCILIATION_INPUT';

  constructor(readonly reason: string) {
    super(`Cannot reconcile: ${reason}`);
  }
}

/**
 * Why an entry could not become a hold, with the sentence that says so.
 *
 * The reason and its explanation are produced together because the explanation
 * is what distinguishes four different ways of contradicting yourself that share
 * one reason code — see {@link assessFxEvidence}.
 */
interface EvidenceFault {
  readonly reason: 'MISSING_FX_EVIDENCE' | 'INCONSISTENT_FX_EVIDENCE';
  readonly detail: string;
}

/**
 * The margin the in-flight rule is measured with, refused rather than defaulted
 * when it makes no sense.
 *
 * A negative margin would move the cutoff *past* `asOf` and flag holds taken
 * before a snapshot this service has not even caught up with; `NaN` or an
 * infinite one makes every comparison against the cutoff meaningless; and one
 * above {@link MAX_CLOCK_SKEW_MARGIN_MS} is a finite number that silences every
 * discrepancy for ever, which is the failure nobody would notice. All three are
 * misconfigurations on this side of the boundary, so they are an exception and
 * not a rejection — answering treasury's perfectly good snapshot with a
 * rejection would file it as poison and stop reconciling the program.
 */
function resolveClockSkewMargin(marginMs: number | undefined): number {
  const margin = marginMs ?? DEFAULT_CLOCK_SKEW_MARGIN_MS;

  if (!Number.isFinite(margin) || margin < 0) {
    throw new InvalidReconciliationInputError(
      `the clock-skew margin must be a non-negative finite number of milliseconds, got ${String(margin)}`,
    );
  }

  // Exactly the ceiling is accepted: it is a round number an operator would
  // configure on purpose, and refusing it would be an off-by-one against the
  // very value the documentation names.
  if (margin > MAX_CLOCK_SKEW_MARGIN_MS) {
    throw new InvalidReconciliationInputError(
      `the clock-skew margin may not exceed ${MAX_CLOCK_SKEW_MARGIN_MS} ms, the snapshot-lag alerting threshold, got ${margin}`,
    );
  }

  return margin;
}

/**
 * The program's reservations by trimmed invoice id, and the counter they are
 * supposed to sum to, all checked on the way in.
 *
 * Everything refused here is this service's own fault rather than treasury's: a
 * row from another program would move capacity on somebody else's limit, an
 * amount in another currency — the counter's, a hold's or the part of one already
 * given back — cannot be weighed against this program's exposure at all, and two
 * rows for one invoice contradict the unique constraint on
 * `(program_id, invoice_id)` that docs/PLAN.md 2.5 relies on — with no way to
 * choose which of the two the snapshot is talking about.
 *
 * Refusing every currency in one place is what lets everything downstream —
 * the drift gate, the diff, the projection — add and subtract these figures
 * without asking again, so no later `Money` operation can surface as a
 * `CurrencyMismatchError` from an operation nobody asked for.
 *
 * A `Map` rather than a scan per entry: the diff looks every snapshot entry up
 * once and then walks the reservations once, so a snapshot of 200 invoices
 * against 200 holds costs 400 lookups instead of 40,000 comparisons.
 *
 * The sum of the **active** holds is accumulated in the same walk, because it is
 * needed one gate later (`COUNTER_DRIFT`) and a second walk would be a second
 * place for the definition of "what the counter should say" to live. Released
 * holds contribute nothing: carrying nothing towards the total is what releasing
 * one means.
 */
function indexReservations(
  program: Program,
  reservations: readonly Reservation[],
): { holds: Map<string, Reservation>; activeTotal: Money } {
  const holds = new Map<string, Reservation>();
  let activeTotal = Money.zero(program.currency);

  // The counter is checked here rather than at the drift gate, and checked
  // first: a counter in another currency is a corrupt program row, not a drift,
  // and `Money.equals` would rightly call a EUR zero unequal to a USD zero, have
  // the gate conclude drift, and then throw a `CurrencyMismatchError` out of the
  // very sentence meant to explain it. Refusing it alongside the reservations is
  // what leaves the gate with two figures in one currency by construction.
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

    // The released half of the same sum, refused for the same reason and in the
    // same breath: `outstandingAmount` subtracts one from the other below, so a
    // row that mixes currencies would reach the accumulator as a
    // `CurrencyMismatchError` from an operation nobody asked for. Cycle 2's
    // `assertReleasedCurrency` states the rule; it is simply not on the
    // constructor-less hydration path (docs/PLAN.md 2.6).
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
 * Whether the denormalized counter still equals the holds it is supposed to sum
 * — the invariant of docs/PLAN.md 2.4 — as the sentence for the rejection, or
 * `null` when it does.
 *
 * Compared with `Money.equals` over `bigint`, so a single minor unit of drift is
 * noticed at any magnitude; an invariant holds or it does not, and there is no
 * tolerance to pick. Nothing is written back: healing the counter here would
 * erase the evidence of whatever wrote the wrong figure (docs/PLAN.md 2.1), and
 * the sentence is what sends somebody to look for it.
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
 * An instant as a discrepancy's sentence may state it, including the two shapes a
 * stored row can carry that no instant reads from.
 *
 * `Date.prototype.toISOString` throws `RangeError: Invalid time value` on an
 * unreadable instant, and a row can hold one: MikroORM hydrates without calling
 * the constructor (docs/PLAN.md 2.6), so cycle 2's `assertInstants` is not on the
 * path a stored row takes. Formatting it directly would therefore let one corrupt
 * timestamp throw a non-`DomainError` out of a pure function — a 500 with no code
 * for the exception filter to map (docs/PLAN.md 2.7) — and stop a whole program
 * reconciling over a single invoice. So the sentence *says* the instant cannot be
 * read, which is the fact a person resolving the discrepancy actually needs, and
 * the row is flagged rather than excused.
 *
 * `null` is the other shape, and it is not the same statement: nothing was ever
 * recorded, rather than something unreadable was. Both are named rather than
 * rendered, and neither is ever treated as in flight — being in flight is a claim
 * about a moment, and a row that cannot name one does not get the benefit of the
 * doubt.
 */
function describeInstant(instant: Date | null): string {
  if (instant === null) {
    return 'an unrecorded date';
  }

  return Number.isNaN(instant.getTime())
    ? 'an unreadable date'
    : instant.toISOString();
}

/**
 * Codepoint order, so the same set of invoice ids sorts the same way on every
 * host. `localeCompare` would make the plan depend on the runtime's collation
 * data, which is exactly the kind of hidden input the determinism the contract
 * promises rules out.
 */
function byInvoiceId(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}

/**
 * The first amount in the snapshot that is not in the program's currency, as the
 * sentence for the rejection, or `null` if every one of them is.
 *
 * Entry *originals* are deliberately not looked at: recording the currency an
 * invoice was issued in is the point of carrying them (docs/PLAN.md 2.2). Entry
 * `amount`s are, whatever their status — a repaid entry in another currency is
 * as unsummable as an outstanding one, and a snapshot nobody can verify is what
 * the checksum gate exists to discard.
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
 * The first entry reporting an amount below zero, as the sentence for the
 * rejection, or `null` if none does.
 *
 * A separate pass from {@link firstForeignAmount} and run after it, which is
 * what makes the currency the answer for an entry that is both: a producer
 * reading the rejection learns the more useful of the two things about that
 * entry, and the sign of an amount in the wrong currency is not the problem with
 * it.
 *
 * Every status is examined. A negative repaid entry is summed by the repaid pair
 * exactly as an outstanding one is summed by the outstanding pair, so it can
 * cancel a fabricated sibling just as well.
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
 *
 * Summed with `Money.add` over `bigint`, so a 10M-limit program's total is exact
 * where a `number` would already be losing minor units above 9e15
 * (docs/PLAN.md 2.3). One pass, two pairs: each status's entries are summed *and*
 * counted together, because a pair whose halves described different sets would
 * leave a gap where a dropped entry cancels a gained one (see
 * {@link TreasurySnapshot}).
 *
 * The repaid pair matters most, not least: it is the only integrity check in
 * front of the one path that frees capacity, and without it a single fabricated
 * `REPAID` line releases a whole hold while the outstanding pair agrees —
 * precisely because it ignores that line.
 *
 * Both halves of a failing pair are reported together rather than on first
 * failure: a total that adds up while its count does not is a more alarming
 * message than a plain truncation, and the operator reading the DLQ envelope
 * wants both. Both pairs are reported when both fail, for the same reason.
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
 * Judges a whole snapshot before a single invoice is looked at, and answers with
 * the **first** failing gate — the order is documented on
 * {@link reconcileProgram} and is itself a decision, not an implementation
 * detail.
 *
 * Returns `null` when the snapshot is fit to diff.
 *
 * `activeTotal` is the sum {@link indexReservations} already computed, handed in
 * rather than recomputed: the drift gate is about our own state, and the figure
 * it compares against has to be the same one the diff was built from.
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
    // Looked up rather than passed in: the origin is a property of the reason, so
    // no gate gets to state it, and no gate can state it wrongly.
    origin: REJECTION_ORIGIN[reason],
    detail,
    // Verbatim, including an unusable value: a log line that restated it as
    // something readable would hide the fault it is reporting.
    sequence: snapshot.sequence,
    appliedSequence,
  });

  if (snapshot.programId.trim() !== program.id) {
    return refuse(
      'WRONG_PROGRAM',
      `the snapshot describes program ${snapshot.programId}, not ${program.id}`,
    );
  }

  // Before the watermark comparison, which every unusable value would pass:
  // `NaN <= 6` is false, so the snapshot would read as newer than anything
  // applied and would then be stored as the watermark.
  if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) {
    return refuse(
      'UNUSABLE_SEQUENCE',
      `sequence ${String(snapshot.sequence)} is not a non-negative safe integer`,
    );
  }

  // Before every integrity gate: a snapshot a later one has already superseded
  // must not be able to raise a data-fault alarm about invoices that have since
  // been corrected.
  if (appliedSequence !== null && snapshot.sequence <= appliedSequence) {
    return refuse(
      'STALE_SEQUENCE',
      `sequence ${snapshot.sequence} is at or behind the applied watermark ${appliedSequence}`,
    );
  }

  // Our own state, and the only fault here the next message cannot fix. After
  // the watermark, so redelivery of snapshots we have already applied stays
  // routine and one bad counter cannot alarm once per redelivery; before every
  // gate about the message, so an operator is not sent to the producer over a
  // blocker on our side.
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

  // Two passes rather than one, so the gates stay in the documented order: an
  // entry that names no invoice is reported as such even when a later entry is
  // also a duplicate.
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
 * Whether an entry's own figures could open a reservation, asked only where it
 * matters — the path that creates one.
 *
 * Every rule here is one `Reservation.open` applies (cycle 2), restated so that
 * a snapshot which is wrong about one invoice and right about 199 produces a
 * discrepancy instead of an `InvalidReservationError` thrown inside cycle 8's
 * transaction. The non-positive original is checked before the reproduction,
 * for a second reason too: `applyRate` refuses a negative amount, so asking it
 * first would answer a contradictory entry with an exception rather than a flag.
 *
 * `applyRate` is what reproduces the amount — never an open-coded multiply. The
 * ceiling of docs/PLAN.md 2.3 is part of the answer, and a producer rounding to
 * nearest is meant to land here.
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
 * Decides what a treasury snapshot means for a program.
 *
 * Pure: no I/O, no clock, no randomness, and not one field of `program`,
 * `reservations` or `snapshot` is written. Every instant it compares arrives as
 * an argument, which is the only way the `asOf` rule below can be tested at its
 * boundary rather than around it.
 *
 * ## The gates, in order
 *
 * A snapshot is judged whole before any invoice is looked at, and the *first*
 * failing gate is the answer (see {@link SnapshotRejectionReason}):
 *
 * 1. `WRONG_PROGRAM` — identity first: a sequence from another program means
 *    nothing against this program's watermark, and neither do our holds.
 * 2. `UNUSABLE_SEQUENCE` — before the comparison that would silently pass it.
 * 3. `STALE_SEQUENCE` — `sequence <= appliedSequence`, and **before every
 *    integrity gate**. Deliberate: a superseded snapshot must not be able to
 *    raise a data-fault alarm about invoices a later snapshot has already
 *    corrected. Routine in, routine out.
 * 4. `COUNTER_DRIFT` — **our own state, before anything is judged against it.**
 *    The position is a decision: it sits *after* the watermark so that
 *    at-least-once redelivery of snapshots we have already applied stays routine
 *    and one bad counter cannot alarm once per redelivery; and *before* every gate
 *    about the message, because it is the only fault here that the next message
 *    cannot fix. Answering a drifted program with `CHECKSUM_MISMATCH` would send
 *    an operator to the producer while the blocker is on our side, and would fill
 *    the DLQ with messages that could never have been applied anyway.
 * 5. `UNREADABLE_AS_OF`, `UNUSABLE_LIMIT`, `FOREIGN_CURRENCY`, `NEGATIVE_AMOUNT`
 *    — the figures the diff and the checksums cannot run without. Currency before
 *    sign, since an amount in the wrong currency tells the producer the more
 *    useful thing about an entry that is both.
 * 6. `BLANK_INVOICE_ID`, `DUPLICATE_INVOICE` — the list has to name each invoice
 *    once.
 * 7. `CHECKSUM_MISMATCH` — last, because it is the only gate that needs the whole
 *    list summed, and summing it requires everything above to hold. All four
 *    figures are verified: `outstandingTotal`/`invoiceCount` over the outstanding
 *    entries, `repaidTotal`/`repaidCount` over the repaid ones.
 *
 * ## The per-invoice diff (docs/PLAN.md 2.1)
 *
 * Invoice ids are trimmed on both sides before matching, exactly as cycles 1 and
 * 2 trim them: `(programId, invoiceId)` is the natural key, and `" invoice-1"`
 * and `"invoice-1"` are one invoice, not two.
 *
 * | snapshot says | we say | outcome |
 * |---|---|---|
 * | `REPAID` | `ACTIVE` | `RELEASE` — the hold's own amount, not treasury's |
 * | `REPAID` | `RELEASED` | nothing at all: we agree. No step, no event, no discrepancy |
 * | `REPAID` | nothing | nothing: neither side carries exposure |
 * | `OUTSTANDING`, same amount | `ACTIVE` | nothing: a no-op produces no audit entry |
 * | `OUTSTANDING`, different amount | `ACTIVE` | `CORRECT` — treasury wins |
 * | `OUTSTANDING` | `RELEASED` before the cutoff | `REPORTED_AGAINST_RELEASED_HOLD` discrepancy |
 * | `OUTSTANDING` | `RELEASED` at or after the cutoff | nothing: the release is in flight |
 * | `OUTSTANDING`, evidence complete | nothing | `CREATE` |
 * | `OUTSTANDING`, no rate for a foreign invoice | nothing | `MISSING_FX_EVIDENCE` discrepancy |
 * | `OUTSTANDING`, self-contradicting evidence | nothing | `INCONSISTENT_FX_EVIDENCE` discrepancy |
 * | `OUTSTANDING`, amount of zero | anything | `UNUSABLE_AMOUNT` discrepancy |
 * | not mentioned, hold newer than the cutoff | `ACTIVE` | nothing: in flight |
 * | not mentioned, hold older than the cutoff | `ACTIVE` | `HELD_BUT_NOT_REPORTED` discrepancy — **not** a release |
 * | not mentioned | `RELEASED` | nothing |
 *
 * A correction is judged **only** on the amount in the program's currency. An
 * entry whose FX evidence contradicts itself still corrects a hold we already
 * have: the evidence is needed to *open* a reservation, never to restate one
 * (docs/PLAN.md 2.3 keeps the frozen quote), so refusing the correction would
 * discard a figure treasury is authoritative about because of a field nothing
 * reads.
 *
 * ## The in-flight rule and its boundary
 *
 * One cutoff, one comparison, **both directions of the race**:
 *
 * ```text
 * cutoff = asOf − clockSkewMarginMs
 *
 * a hold the snapshot omits      is in flight when reservedAt >= cutoff
 * a release treasury contradicts is in flight when releasedAt >= cutoff
 * ```
 *
 * An in-flight anything is left entirely alone: no step, and no discrepancy
 * either, because there is nothing to resolve. This service moved after treasury
 * took its picture, so treasury's view is not a disagreement but the expected
 * view of an event it had not seen yet, and the next snapshot carries it.
 *
 * The symmetry is the point of having a margin at all (docs/PLAN.md 2.1). A
 * reservation taken a second after `asOf` and a release performed a second after
 * `asOf` are the same race and equally routine; treating only the first as in
 * flight means a correctly behaving service reports a discrepancy every time a
 * snapshot crosses a REST release or an `InvoiceRepaid` — and a metric that fires
 * on correct behaviour stops being read, which costs exactly the discrepancies it
 * was built to surface.
 *
 * **Exactly at the cutoff, both count as in flight.** The comparison is `>=`, and
 * the tie goes to silence on purpose: at the boundary the margin is saying that
 * we cannot tell which clock was right, and both readings keep the capacity — so
 * the choice is not about safety but about noise. A false discrepancy costs
 * somebody an investigation and costs the metric its meaning; the true one, if it
 * is one, is reported by the next snapshot, seconds later.
 *
 * **An instant that cannot be read fails the test**, and is flagged rather than
 * excused. `NaN >= cutoff` is `false` and a missing `releasedAt` is not an instant
 * at all, so neither can claim to be in flight — being in flight is a claim about
 * a moment, and a row that cannot name one does not get the benefit of the doubt.
 * A corrupt row therefore costs its own invoice a discrepancy and costs the
 * program nothing: the diff finishes, the other 199 invoices are reconciled, and
 * the detail reports the unreadable instant instead of formatting it into a
 * `RangeError`. This is a planned-for input, not a curiosity — MikroORM hydrates
 * without the constructor (docs/PLAN.md 2.6), so cycle 2's instant guards are not
 * on the path a stored row takes.
 *
 * @throws {InvalidReconciliationInputError} if `clockSkewMarginMs` is negative,
 * not finite or above {@link MAX_CLOCK_SKEW_MARGIN_MS}; if the program's reserved
 * total is stated in a currency other than the program's; if any reservation
 * belongs to another program or holds an amount in another currency; or if two
 * reservations name the same invoice. All of them are faults on this side of the
 * boundary — see the class, and see `COUNTER_DRIFT` for the faults of ours that
 * are answered with a rejection instead.
 *
 * The reserved total is checked with the reservations rather than left to the
 * drift gate, which is the only other place it is read. A counter in the wrong
 * currency is a corrupt program row — `Program.rehydrate` refuses one, so only the
 * constructor-less hydration path can produce it (docs/PLAN.md 2.6) — and it is
 * not a drift: `Money.equals` rightly calls a EUR zero unequal to a USD zero, so
 * the gate would conclude "drift" over two figures it cannot subtract and would
 * throw a `CurrencyMismatchError` while writing its own message. Refusing it where
 * every other currency of our own state is refused keeps the gate's arithmetic on
 * one currency by construction, and keeps a corrupt row from being reported as a
 * drift that no amount of counter-fixing would resolve.
 */
export function reconcileProgram(
  input: ReconciliationInput,
): ReconciliationOutcome {
  const { program, reservations, snapshot, appliedSequence } = input;

  // Our own faults first, and as exceptions: a misconfigured margin or a
  // reservation from another program says nothing about the snapshot, and
  // answering either with a rejection would DLQ a good message and stop
  // reconciling the program.
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

  // One cutoff for both directions of the race, computed once and shared by the
  // two comparisons below. Deriving it twice would let a reservation taken at the
  // boundary and a release performed at the boundary be judged against two
  // figures that a later edit could pull apart, and the symmetry is the whole
  // point of having a margin (docs/PLAN.md 2.1). Safe to read as a number here:
  // `UNREADABLE_AS_OF` has passed and the margin is finite and bounded.
  const cutoff = snapshot.asOf.getTime() - clockSkewMarginMs;

  // One list per group rather than one list sorted afterwards: the groups *are*
  // the order (see `ReconciliationStep`), and appending to the group a decision
  // belongs to keeps snapshot order inside it for free.
  const releases: ReleaseHoldStep[] = [];
  const decreases: CorrectHoldStep[] = [];
  const increases: CorrectHoldStep[] = [];
  const creations: CreateHoldStep[] = [];
  const discrepancies: Discrepancy[] = [];
  const mentioned = new Set<string>();

  for (const entry of snapshot.invoices) {
    // Trimmed on both sides, as cycles 1 and 2 trim it: `(programId,
    // invoiceId)` is the natural key, so `" invoice-1"` is not a second
    // invoice.
    const invoiceId = entry.invoiceId.trim();
    const hold = holds.get(invoiceId) ?? null;

    mentioned.add(invoiceId);

    if (entry.status === 'REPAID') {
      // The one statement that may free a limit — and only where a hold is
      // still carrying something. An invoice we already released, or never
      // knew, needs nothing: both sides agree there is no exposure. The
      // reported amount is not consulted at all; a release frees exactly what
      // the hold carries (docs/PLAN.md 2.3).
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
      // The evidence is what it takes to *open* a reservation, so it is checked
      // here and nowhere else in the diff.
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
        // Assembled from the snapshot alone: the rate a reservation stores has
        // to be the one that produced its amount, and today's quote did not
        // (docs/PLAN.md 2.3).
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

      // The other direction of the race, measured against the same cutoff as a
      // hold the snapshot omits: we released after treasury took its picture, so
      // treasury reporting the invoice as outstanding is not a disagreement but
      // the view of an event it had not seen yet. A released hold with no
      // instant recorded cannot be shown to be in flight, and a discrepancy is
      // the safe answer — it changes no capacity either way.
      if (releasedAt !== null && releasedAt.getTime() >= cutoff) {
        continue;
      }

      // Correcting a released hold is an illegal transition (docs/PLAN.md 2.5),
      // and re-opening it is refused too, so the disagreement is recorded for a
      // person rather than settled by a rule. Flagged whatever the amounts say:
      // the argument is about the invoice being open at all.
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
    // Judged on the amount in the program's currency alone. An entry whose FX
    // evidence contradicts itself still corrects a hold we already have: the
    // evidence opens a reservation, it never restates one, so refusing would
    // discard a figure treasury is authoritative about over a field nothing
    // reads.
    const direction = entry.amount.compare(heldAmount);

    if (direction === 0) {
      // A correction to the amount already held produces no event
      // (docs/PLAN.md 2.8), so the step is left out rather than emitted and
      // ignored — a snapshot every minute must not fill the audit log.
      continue;
    }

    const correction: CorrectHoldStep = {
      action: 'CORRECT',
      invoiceId,
      reservation: hold,
      heldAmount,
      correctedAmount: entry.amount,
    };

    // The sign decides the group, not the caller: every step that frees
    // capacity has to precede every step that consumes it.
    (direction < 0 ? decreases : increases).push(correction);
  }

  const forgotten: Discrepancy[] = [];

  for (const reservation of reservations) {
    // Trimmed for the same reason the snapshot side is, even though cycle 2
    // stores it normalised: the two sides have to be matched as one string, and
    // that guarantee belongs where the match happens.
    const invoiceId = reservation.invoiceId.trim();

    // A released hold the snapshot omits is simply an invoice both sides
    // consider closed.
    if (!reservation.isActive() || mentioned.has(invoiceId)) {
      continue;
    }

    // At the cutoff the hold counts as in flight: the margin is saying we
    // cannot tell which clock was right, both readings keep the capacity, and
    // the tie therefore goes to silence rather than to a discrepancy somebody
    // would have to investigate. An unreadable instant fails this test — every
    // comparison against `NaN` is `false` — and is flagged rather than excused,
    // which is the outcome cycle 2 predicted for such a row.
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
      // `asOf` needs no such care: the `UNREADABLE_AS_OF` gate has already
      // refused a snapshot whose instant cannot be read, so the only unreadable
      // instant that can reach a sentence is one of our own rows'.
      detail: `this service holds ${reservation.reservedAmount.toString()} taken at ${describeInstant(reservation.reservedAt)}, which the snapshot as of ${snapshot.asOf.toISOString()} does not mention; the hold is kept`,
    });
  }

  // Sorted rather than left in the order the repository returned the rows: a
  // plan must not change because Postgres chose a different access path.
  forgotten.sort((left, right) => byInvoiceId(left.invoiceId, right.invoiceId));

  const steps: ReconciliationStep[] = [
    ...releases,
    ...decreases,
    ...increases,
    ...creations,
  ];

  // Last, so the plan reads as "reconcile the exposure, then adopt the limit it
  // was measured against". Emitted only when the limit actually moves: a
  // restatement of the current limit produces no event either.
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
 * The reserved total once every step has been applied: the current total plus
 * the signed sum of the steps, and **not** clamped.
 *
 * Each delta is the one the corresponding aggregate operation will apply, read
 * off the same property it will read — `outstandingAmount` for a release
 * (docs/PLAN.md 2.3: exactly what the hold carries, never a recomputed figure),
 * the difference between the corrected and the held amount for a correction, the
 * converted amount for a new hold, nothing for a limit change, whose `delta` is
 * zero by the rule of docs/PLAN.md 2.8. Accumulated over the steps in their
 * application order, so cycle 8 arrives at this figure by walking the plan it
 * was handed.
 *
 * A negative `available` is the legitimate outcome of a reduced limit or an
 * upward correction (docs/PLAN.md 2.1), so nothing here rounds the overrun away:
 * `creditLimit − projectedReserved` is how a reader sees by how much.
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

import { type Reservation } from '../../domain/reservation';

/**
 * The application layer's view of stored reservations.
 *
 * # Decision: three reads, each the exact question a use case asks
 *
 * ## `findForInvoice` — the idempotency lookup
 *
 * `Program.reserve` is *handed* the existing reservation for the invoice rather
 * than looking it up, because the aggregate deliberately does not hold its
 * reservations (availability is an O(1) read of one row, docs/PLAN.md 2.4). This is
 * that lookup, by the natural key, and it is the primary-key read the schema was
 * built for.
 *
 * ## `findForReconciliation` — bounded, and still exactly what the domain needs
 *
 * `reconcileProgram` documents its input as "**every** reservation this program has,
 * active and released alike", and warns that a filtered list would tell it capacity
 * is held by nothing. Taken literally that is an unbounded read: a program that has
 * been running for two years has every invoice it ever financed in that table, and
 * a snapshot arriving every minute would load all of them to decide about 200.
 *
 * Reading the domain's own use of the list shows what it actually needs, and it is
 * bounded:
 *
 * - the counter-drift gate sums **the active holds** — so every active hold must be
 *   present, or the sum is wrong and a healthy program is rejected as drifted;
 * - the `HELD_BUT_NOT_REPORTED` pass iterates the list and skips anything not
 *   active — so released rows contribute nothing there;
 * - the per-invoice diff needs the row for **an invoice the snapshot names**,
 *   whatever its status, because a released hold treasury still reports outstanding
 *   is `REPORTED_AGAINST_RELEASED_HOLD` and an invoice we never knew is a new hold.
 *
 * So the necessary and sufficient set is: **every active hold, plus every
 * reservation the snapshot names.** That is what this method returns, and it is
 * bounded by the snapshot's size (docs/PLAN.md 2.2 bounds that by the credit limit)
 * plus the number of open holds, which is bounded by the same limit. No released
 * row the snapshot is silent about is loaded, because no rule consults one.
 *
 * The union is computed in one query, not two: two `IN` reads would have to be
 * de-duplicated in memory — an invoice that is both active and named appears in both
 * — and `reconcileProgram` throws on a duplicated invoice id, so the de-duplication
 * would be load-bearing rather than tidy.
 *
 * This narrowing was a refinement of the domain's documented contract rather than a
 * departure from it, and it was reported as one: all ten of docs/PLAN.md 2.1's rules
 * were walked to confirm the narrower set is not merely cheaper but sufficient — no
 * rule consults a released hold the snapshot is silent about. `reconcile-program.ts`
 * now documents that set, and `ReconciliationInput.reservations` states the one
 * precondition it carries.
 *
 * ## The paged read is deliberately absent
 *
 * `GET /programs/:id/reservations` with cursor pagination and a status filter
 * (docs/PLAN.md 2.7) belongs to cycle 6, and so does its cursor. It was declared here
 * first, with a stub, on the reasoning that the cursor should be decided together with
 * the index that serves it — and the attempt showed why that ordering does not work:
 * the declaration ended up promising "newest first" while its cursor was the previous
 * page's `invoiceId`, which pages in lexicographic order of a client-supplied string,
 * against an index that does not exist. The one decision the early declaration was
 * supposed to pin down was the one it got wrong.
 *
 * A declared-but-unimplemented method is also the more expensive kind of gap: the
 * adapter type-checks as a complete `ReservationRepository`, so the hole surfaces as a
 * request failing in cycle 6 rather than as a compile error now. Leaving the method out
 * keeps it a compile error.
 *
 * What cycle 6 has to decide, recorded so it is not rediscovered: ordering by
 * `reserved_at` needs `(program_id, reserved_at)` plus a tie-break on `invoice_id`,
 * because two invoices funded in the same transaction share an instant; the cursor is
 * then that pair, not one column. Ordering by `invoice_id` alone needs no new index and
 * no tie-break, but "newest first" is then not on offer.
 */
export interface ReservationRepository {
  /**
   * The one reservation for `invoiceId` in `programId`, or `null`.
   *
   * The idempotency key of docs/PLAN.md 2.5 is `(program_id, invoice_id)`, so this
   * can return at most one row by construction rather than by convention.
   *
   * Takes no lock of its own: the caller holds the program row, which is what
   * serializes capacity changes (docs/PLAN.md 2.4). Locking the reservation would
   * add a second lock order for no gain — and there is nothing to lock for a new
   * invoice, which is why the unique constraint is the backstop.
   *
   * @throws {InvalidReservationError} if the stored row is not one the domain would
   * have written.
   */
  findForInvoice(
    programId: string,
    invoiceId: string,
  ): Promise<Reservation | null>;

  /**
   * Everything `reconcileProgram` needs about one program's holds: every active
   * hold, plus every reservation named by `reportedInvoiceIds` whatever its status.
   *
   * See the interface documentation for why that is the right set and why it is not
   * "all of them".
   *
   * Invoice ids are matched as stored — trimmed (the domain normalises on the way
   * in, and `reconcileProgram` trims both sides again before matching) — so a caller
   * may pass the snapshot's raw entries.
   *
   * @param reportedInvoiceIds every invoice the snapshot mentions, in either status.
   * The **outstanding** ones are the load-bearing half — omit one and reconciliation
   * opens a fresh hold for an invoice this service already released, because an
   * unselected row and an absent row are indistinguishable to it (see
   * `ReconciliationInput.reservations`). The repaid ones change no outcome today and
   * are passed as insurance against a later cycle where they would. An empty array is
   * legal and asks only for the active holds, which is a snapshot that reports nothing
   * outstanding.
   * @returns the rows in no guaranteed order; `reconcileProgram` sorts what it
   * reports, precisely so a plan does not change because Postgres chose a different
   * access path.
   */
  findForReconciliation(
    programId: string,
    reportedInvoiceIds: readonly string[],
  ): Promise<Reservation[]>;

  /**
   * Schedules a newly opened hold to be inserted when the caller's transaction
   * flushes.
   *
   * Also the moment the mapping's own columns are filled in — the two currency codes
   * and the six FX columns (see `reservation.mapping.ts`). They are insert-only
   * because no domain operation ever restates a stored rate, which is what lets them
   * be projected here rather than through a flush hook.
   *
   * @throws {UniqueConstraintViolationException} at flush time if the program already
   * holds that invoice. That is the race the program lock cannot cover — two
   * transactions that both found no existing hold — and docs/PLAN.md 2.6 maps it to
   * `409`.
   */
  add(reservation: Reservation): void;
}

/** Injection token for {@link ReservationRepository}. */
export const RESERVATION_REPOSITORY = Symbol('ReservationRepository');

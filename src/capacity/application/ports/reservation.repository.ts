import { type Reservation } from '../../domain/reservation';

/** The application layer's view of stored reservations. */
export interface ReservationRepository {
  /**
   * The one reservation for `invoiceId` in `programId`, or `null` — at most
   * one by construction of the `(program_id, invoice_id)` key (docs/PLAN.md 2.5).
   *
   * Takes no lock of its own: the caller holds the program row, which is
   * what serializes capacity changes (docs/PLAN.md 2.4).
   * @throws {InvalidReservationError} if the stored row is not one the
   * domain would have written.
   */
  findForInvoice(
    programId: string,
    invoiceId: string,
  ): Promise<Reservation | null>;

  /**
   * Every active hold on `programId`, plus every reservation named by
   * `reportedInvoiceIds` whatever its status — the exact set
   * `reconcileProgram` needs, not every reservation the program has ever had.
   *
   * @param reportedInvoiceIds every invoice the snapshot mentions. Omitting
   * an outstanding one is indistinguishable from that invoice never having
   * existed, and reconciliation opens a fresh hold for a release this
   * service already recorded.
   * @returns rows in no guaranteed order; `reconcileProgram` sorts what it reports.
   */
  findForReconciliation(
    programId: string,
    reportedInvoiceIds: readonly string[],
  ): Promise<Reservation[]>;

  /**
   * Schedules a newly opened hold for insert at flush, including its FX
   * columns — insert-only, since no domain operation ever restates a stored rate.
   * @throws {UniqueConstraintViolationException} at flush time if the
   * program already holds that invoice — the race the program lock does not
   * cover, mapped to `409`.
   */
  add(reservation: Reservation): void;
}

/** Injection token for {@link ReservationRepository}. */
export const RESERVATION_REPOSITORY = Symbol('ReservationRepository');

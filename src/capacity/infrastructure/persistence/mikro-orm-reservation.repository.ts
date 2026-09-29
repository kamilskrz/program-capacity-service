import { type FilterQuery, type EntityManager } from '@mikro-orm/postgresql';

import {
  asReservation,
  asStoredReservation,
  fxEvidenceColumns,
  reservationSchema,
  type StoredReservation,
} from './reservation.mapping';
import { type ReservationRepository } from '../../application/ports/reservation.repository';
import { type Reservation } from '../../domain/reservation';

/** `ReservationRepository` over MikroORM, bound to one `EntityManager` like `MikroOrmProgramRepository`. */
export class MikroOrmReservationRepository implements ReservationRepository {
  constructor(private readonly em: EntityManager) {}

  /** @throws {InvalidReservationError} if the row is corrupt (see `DomainHydrator`). */
  async findForInvoice(
    programId: string,
    invoiceId: string,
  ): Promise<Reservation | null> {
    const stored = await this.em.findOne(reservationSchema, {
      programId,
      invoiceId,
    });

    return stored === null ? null : asReservation(stored);
  }

  /**
   * One query for the union the port describes — every active hold, plus
   * every reservation named by `reportedInvoiceIds` — since the two sets
   * overlap and `reconcileProgram` throws on a duplicated invoice id.
   * @throws {InvalidReservationError} if any row is corrupt.
   */
  async findForReconciliation(
    programId: string,
    reportedInvoiceIds: readonly string[],
  ): Promise<Reservation[]> {
    // Trimmed and de-duplicated the same way the domain normalises an id.
    const reported = [
      ...new Set(
        reportedInvoiceIds
          .map((invoiceId) => invoiceId.trim())
          .filter((invoiceId) => invoiceId.length > 0),
      ),
    ];

    // An empty `reported` drops the `$or` rather than producing `invoice_id
    // in ()`, which would match nothing rather than every active hold.
    const where: FilterQuery<StoredReservation> =
      reported.length === 0
        ? { programId, _status: 'ACTIVE' }
        : {
            programId,
            $or: [{ _status: 'ACTIVE' }, { invoiceId: { $in: reported } }],
          };

    const rows = await this.em.find(reservationSchema, where);

    return rows.map(asReservation);
  }

  /**
   * Fills in the mapping's own columns before persisting: `originalCurrency`
   * and `heldCurrency` (not domain fields — the currency lives inside each
   * `Money`), then the six FX columns from `fxEvidenceColumns`. Insert-only,
   * safe because no domain operation ever restates a stored rate or moves a
   * hold between currencies; a future cycle that changes that would need to
   * move this projection into a flush hook.
   * @throws {UniqueConstraintViolationException} at flush time on a
   * duplicate `(program_id, invoice_id)`.
   */
  add(reservation: Reservation): void {
    const stored = asStoredReservation(reservation);

    stored.originalCurrency = reservation.originalAmount.currency;
    stored.heldCurrency = reservation.reservedAmount.currency;

    Object.assign(stored, fxEvidenceColumns(reservation.fxRate));

    this.em.persist(stored);
  }
}

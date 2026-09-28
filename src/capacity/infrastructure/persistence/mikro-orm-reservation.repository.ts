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

/**
 * `ReservationRepository` over MikroORM.
 *
 * Bound to an `EntityManager` for the same reason as
 * `MikroOrmProgramRepository` — the transactional fork, not the global instance.
 */
export class MikroOrmReservationRepository implements ReservationRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * `em.findOne(reservationSchema, { programId, invoiceId })` — the primary key.
   *
   * @throws {InvalidReservationError} if the row is corrupt (see `DomainHydrator`).
   */
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
   * One query for the union the port describes:
   *
   * ```sql
   * select … from reservations
   *  where program_id = ?
   *    and (status = 'ACTIVE' or invoice_id = any(?))
   * ```
   *
   * — every active hold, plus every reservation the snapshot names. One `or` rather
   * than two queries, because the two sets overlap and `reconcileProgram` throws on a
   * duplicated invoice id, so de-duplication would be load-bearing rather than tidy.
   *
   * In MikroORM: `em.find(reservationSchema, { programId, $or: [{ _status: 'ACTIVE'
   * }, { invoiceId: { $in: […] } }] })`. An empty `reportedInvoiceIds` must not
   * produce `invoice_id in ()` — the `$or` branch is omitted instead, leaving the
   * active holds, which is the correct reading of a snapshot that reports nothing
   * outstanding.
   *
   * @throws {InvalidReservationError} if any row is corrupt. One bad row therefore
   * costs the program its reconciliation — the trade `DomainHydrator` documents and
   * accepts.
   */
  async findForReconciliation(
    programId: string,
    reportedInvoiceIds: readonly string[],
  ): Promise<Reservation[]> {
    // Trimmed and de-duplicated: the domain normalises an invoice id on the way
    // in, so the stored value is the trimmed one, and a snapshot naming the same
    // invoice twice must not widen the `in` list for no reason.
    const reported = [
      ...new Set(
        reportedInvoiceIds
          .map((invoiceId) => invoiceId.trim())
          .filter((invoiceId) => invoiceId.length > 0),
      ),
    ];

    // One query for the union, because the two sets overlap and
    // `reconcileProgram` throws on a duplicated invoice id — de-duplicating two
    // result sets in memory would be load-bearing rather than tidy. An empty
    // `reported` drops the `$or` entirely rather than producing `invoice_id in
    // ()`, which is the correct reading of a snapshot that reports nothing
    // outstanding.
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
   * Fills in the mapping's own columns and persists the hold.
   *
   * Three steps, and the order matters only in that they all precede the flush:
   *
   * 1. `originalCurrency` and `heldCurrency` from the two amounts the aggregate
   *    holds. They are not domain fields — the domain keeps the currency inside
   *    `Money` — and they are `not null` columns, so a missing projection would
   *    surface as a constraint violation at flush rather than as a wrong value.
   * 2. the six FX columns from `fxEvidenceColumns(reservation.fxRate)`, all null for
   *    an unconverted hold.
   * 3. `em.persist`.
   *
   * Insert-only, and that is what makes this safe: no domain operation restates a
   * stored rate or moves a hold between currencies (docs/PLAN.md 2.3 freezes the rate;
   * `release` and `correctTo` both leave it alone), so these columns never need to be
   * re-projected on an update. If a future cycle makes any of them mutable, this
   * projection has to move into a flush hook — stated here because that is the change
   * that would silently stop writing them.
   *
   * @throws {UniqueConstraintViolationException} at flush time on a duplicate
   * `(program_id, invoice_id)`.
   */
  add(reservation: Reservation): void {
    const stored = asStoredReservation(reservation);

    // The mapping's own columns, which the domain does not carry as fields: the
    // currency of each amount lives inside its `Money`, and both columns are
    // `not null`, so a missing projection would surface as a constraint
    // violation at flush rather than as a wrong value.
    stored.originalCurrency = reservation.originalAmount.currency;
    stored.heldCurrency = reservation.reservedAmount.currency;

    // Insert-only, all six or none of them (docs/PLAN.md 2.3). Safe to project
    // here rather than in a flush hook precisely because no domain operation
    // ever restates a stored rate or moves a hold between currencies — if one
    // ever does, this is the projection that would silently stop being written.
    Object.assign(stored, fxEvidenceColumns(reservation.fxRate));

    this.em.persist(stored);
  }
}

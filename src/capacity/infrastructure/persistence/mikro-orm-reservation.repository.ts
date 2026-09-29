import { type FilterQuery, type EntityManager } from '@mikro-orm/postgresql';

import {
  asReservation,
  asStoredReservation,
  fxEvidenceColumns,
  reservationSchema,
  type StoredReservation,
} from './reservation.mapping';
import { InvalidCursorError } from '../../application/errors';
import {
  type ReservationPage,
  type ReservationPageRequest,
  type ReservationRepository,
} from '../../application/ports/reservation.repository';
import { type Reservation } from '../../domain/reservation';

/** The opaque cursor: base64 of `${reservedAt.toISOString()}|${invoiceId}`. */
function encodeCursor(reservedAt: Date, invoiceId: string): string {
  return Buffer.from(
    `${reservedAt.toISOString()}|${invoiceId}`,
    'utf8',
  ).toString('base64');
}

/** @throws {InvalidCursorError} if `cursor` doesn't decode to a usable position. */
function decodeCursor(cursor: string): { reservedAt: Date; invoiceId: string } {
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const separator = decoded.indexOf('|');

  if (separator === -1) {
    throw new InvalidCursorError(cursor);
  }

  const reservedAt = new Date(decoded.slice(0, separator));

  if (Number.isNaN(reservedAt.getTime())) {
    throw new InvalidCursorError(cursor);
  }

  return { reservedAt, invoiceId: decoded.slice(separator + 1) };
}

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

  /**
   * One query, ordered by `(reserved_at, invoice_id)` ascending — the same
   * page-of-`limit + 1` trick `CapacityEventLog.findByProgram` uses to answer
   * "is there a next page?" without a count query.
   * @throws {RangeError} if `options.limit` is not positive.
   */
  async listByProgram(
    programId: string,
    options: ReservationPageRequest,
  ): Promise<ReservationPage> {
    const { limit, after, status } = options;

    if (limit <= 0) {
      throw new RangeError(
        `ReservationRepository.listByProgram was asked for a page of ${limit} reservations of program ${programId}: a non-positive limit is not a request anybody can mean.`,
      );
    }

    const filters: FilterQuery<StoredReservation>[] = [{ programId }];

    if (status !== undefined) {
      filters.push({ _status: status });
    }

    if (after !== undefined) {
      const cursor = decodeCursor(after);

      filters.push({
        $or: [
          { _reservedAt: { $gt: cursor.reservedAt } },
          {
            _reservedAt: cursor.reservedAt,
            invoiceId: { $gt: cursor.invoiceId },
          },
        ],
      });
    }

    const where: FilterQuery<StoredReservation> =
      filters.length === 1 ? filters[0]! : { $and: filters };

    const rows = await this.em.find(reservationSchema, where, {
      orderBy: { _reservedAt: 'asc', invoiceId: 'asc' },
      // One row past the page, to answer "is there a next page?" without a count query.
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      reservations: page.map(asReservation),
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor(last._reservedAt, last.invoiceId)
          : null,
    };
  }
}

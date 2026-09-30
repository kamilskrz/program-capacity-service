import {
  type ReleaseReason,
  type ReservationStatus,
} from '../../../domain/reservation';

/** Wire shape of a `Reservation` — decimals and ISO strings, no `Money` instance leaks out. */
export interface ReservationResponse {
  readonly invoiceId: string;
  readonly status: ReservationStatus;
  readonly originalAmount: string;
  readonly originalCurrency: string;
  readonly reservedAmount: string;
  readonly reservedCurrency: string;
  readonly releasedAmount: string;
  readonly releasedCurrency: string;
  readonly reservedAt: string;
  readonly releasedAt: string | null;
  readonly releaseReason: ReleaseReason | null;
}

/** `GET /programs/:id/reservations`. */
export interface ReservationPageResponse {
  readonly reservations: readonly ReservationResponse[];
  readonly nextCursor: string | null;
}

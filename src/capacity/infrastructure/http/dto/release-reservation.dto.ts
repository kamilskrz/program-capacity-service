import { IsIn } from 'class-validator';

import { type ReleaseReason } from '../../../domain/reservation';

/** `POST /programs/:id/reservations/:invoiceId/release` (docs/PLAN.md 2.7). */
export class ReleaseReservationDto {
  @IsIn(['REPAID', 'CANCELLED'])
  reason!: ReleaseReason;
}

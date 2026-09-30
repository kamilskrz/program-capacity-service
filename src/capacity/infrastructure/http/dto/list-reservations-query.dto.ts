import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

import { type ReservationStatus } from '../../../domain/reservation';

/** `GET /programs/:id/reservations` (docs/PLAN.md 2.7). */
export class ListReservationsQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  limit?: number;

  /** Opaque cursor from a previous page's `nextCursor`. */
  @IsOptional()
  @IsString()
  after?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'RELEASED'])
  status?: ReservationStatus;
}

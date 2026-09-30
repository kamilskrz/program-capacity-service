import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Matches, Min } from 'class-validator';

/**
 * `GET /programs/:id/events`. `after` stays a string on the wire — it is a
 * decimal `bigint` row id, widened to `bigint` at the service boundary, not
 * here. `@Matches` rejects anything `BigInt(...)` can't parse (the controller
 * would otherwise throw a raw, uncaught `SyntaxError` on a hand-edited URL).
 */
export class ListEventsQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @Matches(/^\d+$/, { message: 'after must be a non-negative integer string' })
  after?: string;
}

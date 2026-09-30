import { IsIn, IsNotEmpty, IsString } from 'class-validator';

/**
 * `treasury.program-events`, `type: 'ProgramLimitChanged'` (docs/PLAN.md 2.2).
 * No currency field: a program's currency never changes, so the decimal
 * string is read in whatever currency `Program.changeCreditLimit` already
 * holds, the same way `ReleaseReservationDto`'s reason needs no invoice
 * amount repeated alongside it.
 */
export class ProgramLimitChangedMessage {
  @IsIn(['ProgramLimitChanged'])
  type!: 'ProgramLimitChanged';

  @IsString()
  @IsNotEmpty()
  programId!: string;

  @IsString()
  @IsNotEmpty()
  newLimit!: string;
}

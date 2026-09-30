import { IsNotEmpty, IsString } from 'class-validator';

/** `POST /programs`; shape only — `Program.create` checks the rest (docs/PLAN.md 2.7). */
export class CreateProgramDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsString()
  @IsNotEmpty()
  ownerOrgId!: string;

  @IsString()
  @IsNotEmpty()
  currency!: string;

  /** Decimal string; `Money.fromDecimalString`/`Program.create` validate it. */
  @IsString()
  @IsNotEmpty()
  creditLimit!: string;
}

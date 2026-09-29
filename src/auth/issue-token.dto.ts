import { IsNotEmpty, IsString } from 'class-validator';

/** What `POST /auth/token` accepts; shape only, no more (docs/PLAN.md 2.7). */
export class IssueTokenDto {
  @IsString()
  @IsNotEmpty()
  sub!: string;

  @IsString()
  @IsNotEmpty()
  org!: string;

  @IsString()
  @IsNotEmpty()
  scope!: string;
}

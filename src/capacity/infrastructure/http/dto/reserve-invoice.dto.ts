import { IsNotEmpty, IsString } from 'class-validator';

/** `POST /programs/:id/reservations`; shape only (docs/PLAN.md 2.7). */
export class ReserveInvoiceDto {
  @IsString()
  @IsNotEmpty()
  invoiceId!: string;

  /** Decimal string; `Money.fromDecimalString` validates it. */
  @IsString()
  @IsNotEmpty()
  amount!: string;

  @IsString()
  @IsNotEmpty()
  currency!: string;
}

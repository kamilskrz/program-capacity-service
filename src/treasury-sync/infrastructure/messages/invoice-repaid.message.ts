import { IsIn, IsNotEmpty, IsString } from 'class-validator';

/** `treasury.program-events`, `type: 'InvoiceRepaid'` (docs/PLAN.md 2.2). */
export class InvoiceRepaidMessage {
  @IsIn(['InvoiceRepaid'])
  type!: 'InvoiceRepaid';

  @IsString()
  @IsNotEmpty()
  programId!: string;

  @IsString()
  @IsNotEmpty()
  invoiceId!: string;
}

// `ValidateNested`/`@Type` read `design:type` metadata that `tsc`/`swc`'s
// `emitDecoratorMetadata` only emits calls for — `reflect-metadata` is what
// actually stores and answers them. `main.ts` imports it for the running
// app; this module's own decorated classes need it just as much wherever
// they're imported on their own (unit tests, in particular), so it is
// imported here too. Side-effect-only and idempotent.
import 'reflect-metadata';

import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/**
 * One invoice's FX evidence, exactly as `FxRateSnapshot` states it
 * (docs/PLAN.md 2.2, 2.3): `FxRate.fromSnapshot` is what actually validates
 * it, once mapped — this DTO checks shape only.
 */
export class FxRateMessage {
  @IsString()
  @IsNotEmpty()
  base!: string;

  @IsString()
  @IsNotEmpty()
  quote!: string;

  /** The rate multiplied by `10^scale`, as an integer string. */
  @IsString()
  @IsNotEmpty()
  scaledValue!: string;

  @IsNumber()
  scale!: number;

  @IsString()
  @IsNotEmpty()
  source!: string;

  /** ISO 8601. Not format-checked here — an unreadable instant is the domain's own error, not a DTO one. */
  @IsString()
  @IsNotEmpty()
  asOf!: string;
}

/**
 * One invoice as treasury reports it, mirroring `TreasuryInvoice` field for
 * field. `amount` is in the snapshot's own currency
 * (`ProgramSnapshotMessage.currency`); `originalAmount` is in
 * `originalCurrency`, the invoice's own.
 */
export class TreasuryInvoiceMessage {
  @IsString()
  @IsNotEmpty()
  invoiceId!: string;

  @IsIn(['OUTSTANDING', 'REPAID'])
  status!: 'OUTSTANDING' | 'REPAID';

  @IsString()
  @IsNotEmpty()
  amount!: string;

  @IsString()
  @IsNotEmpty()
  originalAmount!: string;

  @IsString()
  @IsNotEmpty()
  originalCurrency!: string;

  /** Absent iff no conversion was involved (docs/PLAN.md 2.2) — a foreign-currency entry with no rate is a discrepancy, not a DTO error. */
  @IsOptional()
  @ValidateNested()
  @Type(() => FxRateMessage)
  rate?: FxRateMessage;
}

/**
 * `treasury.program-events`, `type: 'ProgramSnapshot'` (docs/PLAN.md 2.2).
 * Mirrors `TreasurySnapshot` field for field, plus `currency`: the program's
 * currency, which the domain type carries inside every `Money` but the wire
 * form has to state once, since `creditLimit`/`outstandingTotal`/
 * `repaidTotal` and every entry's `amount` are decimal strings rather than
 * `{ amount, currency }` pairs repeated per field.
 */
export class ProgramSnapshotMessage {
  @IsIn(['ProgramSnapshot'])
  type!: 'ProgramSnapshot';

  @IsString()
  @IsNotEmpty()
  programId!: string;

  @IsString()
  @IsNotEmpty()
  currency!: string;

  @IsNumber()
  sequence!: number;

  @IsString()
  @IsNotEmpty()
  asOf!: string;

  @IsString()
  @IsNotEmpty()
  creditLimit!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TreasuryInvoiceMessage)
  invoices!: TreasuryInvoiceMessage[];

  @IsString()
  @IsNotEmpty()
  outstandingTotal!: string;

  @IsNumber()
  invoiceCount!: number;

  @IsString()
  @IsNotEmpty()
  repaidTotal!: string;

  @IsNumber()
  repaidCount!: number;
}

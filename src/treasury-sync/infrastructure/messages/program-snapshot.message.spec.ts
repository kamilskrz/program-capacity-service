import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  FxRateMessage,
  ProgramSnapshotMessage,
  TreasuryInvoiceMessage,
} from './program-snapshot.message';

const VALID_RATE = {
  base: 'USD',
  quote: 'EUR',
  scaledValue: '923500000000',
  scale: 12,
  source: 'seed',
  asOf: '2026-01-15T10:32:00.000Z',
};

const VALID_INVOICE = {
  invoiceId: 'inv-0001',
  status: 'OUTSTANDING',
  amount: '9235.00',
  originalAmount: '10000.00',
  originalCurrency: 'USD',
  rate: VALID_RATE,
};

const VALID_SNAPSHOT = {
  type: 'ProgramSnapshot',
  programId: 'prog-hanseatic',
  currency: 'EUR',
  sequence: 1,
  asOf: '2026-01-15T10:32:00.000Z',
  creditLimit: '1000000.00',
  invoices: [VALID_INVOICE],
  outstandingTotal: '9235.00',
  invoiceCount: 1,
  repaidTotal: '0.00',
  repaidCount: 0,
};

describe('ProgramSnapshotMessage', () => {
  it('accepts a fully-populated body, transforming nested invoices and rates', async () => {
    const dto = plainToInstance(ProgramSnapshotMessage, VALID_SNAPSHOT);

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.invoices[0]).toBeInstanceOf(TreasuryInvoiceMessage);
    expect(dto.invoices[0]?.rate).toBeInstanceOf(FxRateMessage);
  });

  it('accepts an invoice entry with no rate', async () => {
    const { rate: _rate, ...unconverted } = VALID_INVOICE;
    const dto = plainToInstance(ProgramSnapshotMessage, {
      ...VALID_SNAPSHOT,
      invoices: [unconverted],
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects the wrong type discriminator', async () => {
    const dto = plainToInstance(ProgramSnapshotMessage, {
      ...VALID_SNAPSHOT,
      type: 'ProgramLimitChanged',
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'type')).toBe(true);
  });

  it.each([
    'programId',
    'currency',
    'sequence',
    'asOf',
    'creditLimit',
    'outstandingTotal',
    'invoiceCount',
    'repaidTotal',
    'repaidCount',
  ])('rejects a missing %s', async (field) => {
    const body: Record<string, unknown> = { ...VALID_SNAPSHOT };

    delete body[field];

    const dto = plainToInstance(ProgramSnapshotMessage, body);
    const errors = await validate(dto);

    expect(errors.some((error) => error.property === field)).toBe(true);
  });

  it('rejects a missing invoices array', async () => {
    const body: Record<string, unknown> = { ...VALID_SNAPSHOT };

    delete body['invoices'];

    const dto = plainToInstance(ProgramSnapshotMessage, body);
    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'invoices')).toBe(true);
  });

  it('rejects a structurally wrong invoice entry (blank invoiceId)', async () => {
    const dto = plainToInstance(ProgramSnapshotMessage, {
      ...VALID_SNAPSHOT,
      invoices: [{ ...VALID_INVOICE, invoiceId: '' }],
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'invoices')).toBe(true);
  });

  it('rejects an invoice status outside the two allowed values', async () => {
    const dto = plainToInstance(ProgramSnapshotMessage, {
      ...VALID_SNAPSHOT,
      invoices: [{ ...VALID_INVOICE, status: 'PENDING' }],
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'invoices')).toBe(true);
  });

  it('rejects a structurally wrong nested rate (blank source)', async () => {
    const dto = plainToInstance(ProgramSnapshotMessage, {
      ...VALID_SNAPSHOT,
      invoices: [{ ...VALID_INVOICE, rate: { ...VALID_RATE, source: '' } }],
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'invoices')).toBe(true);
  });
});

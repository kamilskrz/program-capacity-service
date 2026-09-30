import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { InvoiceRepaidMessage } from './invoice-repaid.message';

const VALID = {
  type: 'InvoiceRepaid',
  programId: 'prog-northwind',
  invoiceId: 'inv-0001',
};

describe('InvoiceRepaidMessage', () => {
  it('accepts a fully-populated body', async () => {
    const dto = plainToInstance(InvoiceRepaidMessage, VALID);

    expect(await validate(dto)).toHaveLength(0);
  });

  it.each(['type', 'programId', 'invoiceId'])(
    'rejects a missing %s',
    async (field) => {
      const body: Record<string, string> = { ...VALID };

      delete body[field];

      const dto = plainToInstance(InvoiceRepaidMessage, body);
      const errors = await validate(dto);

      expect(errors.some((error) => error.property === field)).toBe(true);
    },
  );

  it('rejects the wrong type discriminator', async () => {
    const dto = plainToInstance(InvoiceRepaidMessage, {
      ...VALID,
      type: 'ProgramLimitChanged',
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'type')).toBe(true);
  });
});

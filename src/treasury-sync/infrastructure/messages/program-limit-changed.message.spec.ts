import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ProgramLimitChangedMessage } from './program-limit-changed.message';

const VALID = {
  type: 'ProgramLimitChanged',
  programId: 'prog-northwind',
  newLimit: '2000000.00',
};

describe('ProgramLimitChangedMessage', () => {
  it('accepts a fully-populated body', async () => {
    const dto = plainToInstance(ProgramLimitChangedMessage, VALID);

    expect(await validate(dto)).toHaveLength(0);
  });

  it.each(['type', 'programId', 'newLimit'])(
    'rejects a missing %s',
    async (field) => {
      const body: Record<string, string> = { ...VALID };

      delete body[field];

      const dto = plainToInstance(ProgramLimitChangedMessage, body);
      const errors = await validate(dto);

      expect(errors.some((error) => error.property === field)).toBe(true);
    },
  );

  it('rejects the wrong type discriminator', async () => {
    const dto = plainToInstance(ProgramLimitChangedMessage, {
      ...VALID,
      type: 'InvoiceRepaid',
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'type')).toBe(true);
  });
});

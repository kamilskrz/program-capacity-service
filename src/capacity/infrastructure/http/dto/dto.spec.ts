import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateProgramDto } from './create-program.dto';
import { ListEventsQueryDto } from './list-events-query.dto';
import { ListReservationsQueryDto } from './list-reservations-query.dto';
import { ReleaseReservationDto } from './release-reservation.dto';
import { ReserveInvoiceDto } from './reserve-invoice.dto';

describe('CreateProgramDto', () => {
  it('accepts a fully-populated body', async () => {
    const dto = plainToInstance(CreateProgramDto, {
      id: 'prog-1',
      ownerOrgId: 'org-1',
      currency: 'USD',
      creditLimit: '1000.00',
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it.each(['id', 'ownerOrgId', 'currency', 'creditLimit'])(
    'rejects a blank %s',
    async (field) => {
      const dto = plainToInstance(CreateProgramDto, {
        id: 'prog-1',
        ownerOrgId: 'org-1',
        currency: 'USD',
        creditLimit: '1000.00',
        [field]: '',
      });

      const errors = await validate(dto);

      expect(errors.some((error) => error.property === field)).toBe(true);
    },
  );
});

describe('ReserveInvoiceDto', () => {
  it('accepts a fully-populated body', async () => {
    const dto = plainToInstance(ReserveInvoiceDto, {
      invoiceId: 'inv-1',
      amount: '100.00',
      currency: 'USD',
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it.each(['invoiceId', 'amount', 'currency'])(
    'rejects a missing %s',
    async (field) => {
      const body: Record<string, string> = {
        invoiceId: 'inv-1',
        amount: '100.00',
        currency: 'USD',
      };

      delete body[field];

      const dto = plainToInstance(ReserveInvoiceDto, body);
      const errors = await validate(dto);

      expect(errors.some((error) => error.property === field)).toBe(true);
    },
  );
});

describe('ReleaseReservationDto', () => {
  it.each(['REPAID', 'CANCELLED'])('accepts reason %s', async (reason) => {
    const dto = plainToInstance(ReleaseReservationDto, { reason });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a reason outside the two allowed values', async () => {
    const dto = plainToInstance(ReleaseReservationDto, {
      reason: 'WRITTEN_OFF',
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'reason')).toBe(true);
  });

  it('rejects a missing reason', async () => {
    const dto = plainToInstance(ReleaseReservationDto, {});

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'reason')).toBe(true);
  });
});

describe('ListReservationsQueryDto', () => {
  it('coerces a query-string limit to a number', async () => {
    const dto = plainToInstance(ListReservationsQueryDto, { limit: '25' });

    expect(dto.limit).toBe(25);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts an entirely absent query', async () => {
    const dto = plainToInstance(ListReservationsQueryDto, {});

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a non-positive limit', async () => {
    const dto = plainToInstance(ListReservationsQueryDto, { limit: '0' });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });

  it('rejects a non-integer limit', async () => {
    const dto = plainToInstance(ListReservationsQueryDto, { limit: '1.5' });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });

  it.each(['ACTIVE', 'RELEASED'])('accepts status %s', async (status) => {
    const dto = plainToInstance(ListReservationsQueryDto, { status });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a status outside the two allowed values', async () => {
    const dto = plainToInstance(ListReservationsQueryDto, {
      status: 'PENDING',
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'status')).toBe(true);
  });
});

describe('ListEventsQueryDto', () => {
  it('coerces a query-string limit to a number and leaves after a string', async () => {
    const dto = plainToInstance(ListEventsQueryDto, {
      limit: '10',
      after: '9007199254740993',
    });

    expect(dto.limit).toBe(10);
    expect(dto.after).toBe('9007199254740993');
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a non-positive limit', async () => {
    const dto = plainToInstance(ListEventsQueryDto, { limit: '-1' });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });

  it('rejects an after that BigInt(...) cannot parse, before the controller ever sees it', async () => {
    const dto = plainToInstance(ListEventsQueryDto, { after: 'not-a-number' });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'after')).toBe(true);
  });
});

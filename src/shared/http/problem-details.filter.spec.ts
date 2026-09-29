import { type ArgumentsHost, UnauthorizedException } from '@nestjs/common';

import { ProblemDetailsFilter } from './problem-details.filter';
import { type ProblemDetails } from './problem-details';
import {
  InvalidCursorError,
  ProgramNotFoundError,
  ReservationNotFoundError,
} from '../../capacity/application/errors';
import {
  CapacityInvariantError,
  DuplicateInvoiceError,
  InsufficientCapacityError,
  InvalidCreditLimitError,
  ReservationStateError,
} from '../../capacity/domain/capacity-errors';
import {
  InvalidAmountError,
  UnknownCurrencyError,
} from '../../capacity/domain/errors';
import { Money } from '../../capacity/domain/money';
import { FxRateNotFoundError } from '../../fx/errors';

interface FakeResponse {
  status: jest.Mock<FakeResponse, [number]>;
  type: jest.Mock<FakeResponse, [string]>;
  json: jest.Mock<FakeResponse, [ProblemDetails]>;
}

function createResponse(): FakeResponse {
  const response = {} as FakeResponse;

  response.status = jest.fn().mockReturnValue(response);
  response.type = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);

  return response;
}

function createHost(traceId: string, response: FakeResponse): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ id: traceId }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

function body(response: FakeResponse): ProblemDetails {
  return response.json.mock.calls[0]![0];
}

const usd = (minorUnits: bigint) => Money.fromMinorUnits(minorUnits, 'USD');

describe('ProblemDetailsFilter', () => {
  const filter = new ProblemDetailsFilter();

  it.each([
    {
      error: new InsufficientCapacityError('prog-1', usd(100n), usd(50n)),
      status: 409,
    },
    {
      error: new DuplicateInvoiceError('prog-1', 'inv-1', 'replay mismatch'),
      status: 409,
    },
    {
      error: new ReservationStateError('inv-1', 'RELEASED', 'release'),
      status: 409,
    },
    { error: new ProgramNotFoundError('prog-1'), status: 404 },
    { error: new ReservationNotFoundError('prog-1', 'inv-1'), status: 404 },
    { error: new FxRateNotFoundError('USD', 'EUR'), status: 422 },
    { error: new UnknownCurrencyError('ZZZ'), status: 400 },
    { error: new InvalidAmountError('-1.00', 'must be positive'), status: 400 },
    { error: new InvalidCreditLimitError('must not be negative'), status: 400 },
    { error: new InvalidCursorError('not-base64'), status: 400 },
  ])(
    "maps $error.code to $status, with the error's own detail",
    ({ error, status }) => {
      const response = createResponse();

      filter.catch(error, createHost('trace-1', response));

      expect(response.status).toHaveBeenCalledWith(status);
      expect(response.type).toHaveBeenCalledWith('application/problem+json');
      const problem = body(response);

      expect(problem.status).toBe(status);
      expect(problem.code).toBe(error.code);
      expect(problem.detail).toBe(error.message);
      expect(problem.type).toEqual(expect.any(String));
      expect(problem.title).toEqual(expect.any(String));
    },
  );

  it('maps an unmapped DomainError to 500, keeping the code but hiding the raw message', () => {
    const error = new CapacityInvariantError(
      'reserved total drifted from the audit log',
    );
    const response = createResponse();

    filter.catch(error, createHost('trace-2', response));

    expect(response.status).toHaveBeenCalledWith(500);
    const problem = body(response);

    expect(problem.status).toBe(500);
    expect(problem.code).toBe('CAPACITY_INVARIANT_VIOLATED');
    expect(problem.detail).not.toBe(error.message);
  });

  it("keeps a Nest HttpException's own status", () => {
    const response = createResponse();

    filter.catch(new UnauthorizedException(), createHost('trace-3', response));

    expect(response.status).toHaveBeenCalledWith(401);
    expect(body(response).status).toBe(401);
  });

  it('maps a plain Error with no code to 500 and INTERNAL_ERROR, with a generic detail', () => {
    const response = createResponse();

    filter.catch(
      new Error('something the client must never see'),
      createHost('trace-4', response),
    );

    expect(response.status).toHaveBeenCalledWith(500);
    const problem = body(response);

    expect(problem.code).toBe('INTERNAL_ERROR');
    expect(problem.detail).not.toBe('something the client must never see');
  });

  it('takes traceId from request.id in every case', () => {
    const response = createResponse();

    filter.catch(
      new ProgramNotFoundError('prog-1'),
      createHost('trace-mine', response),
    );

    expect(body(response).traceId).toBe('trace-mine');
  });

  it('always answers application/problem+json', () => {
    const response = createResponse();

    filter.catch(new Error('anything'), createHost('trace-5', response));

    expect(response.type).toHaveBeenCalledWith('application/problem+json');
  });
});

import {
  classifyFailure,
  MessageValidationError,
  parseMessage,
  UnrecognisedMessageTypeError,
} from './message-dispatch';
import {
  SnapshotRejectedError,
  UnknownProgramError,
} from '../../application/errors';
import { type SnapshotRejection } from '../../domain/reconcile-program';

const REJECTION: SnapshotRejection = {
  verdict: 'REJECT',
  reason: 'STALE_SEQUENCE',
  origin: 'TREASURY',
  detail: 'sequence 3 is not ahead of the applied watermark 10',
  sequence: 3,
  appliedSequence: 10,
};

const VALID_INVOICE_REPAID = {
  type: 'InvoiceRepaid',
  programId: 'prog-northwind',
  invoiceId: 'inv-0001',
};

const VALID_LIMIT_CHANGED = {
  type: 'ProgramLimitChanged',
  programId: 'prog-northwind',
  newLimit: '2000000.00',
};

const VALID_SNAPSHOT = {
  type: 'ProgramSnapshot',
  programId: 'prog-hanseatic',
  currency: 'EUR',
  sequence: 1,
  asOf: '2026-01-15T10:32:00.000Z',
  creditLimit: '1000000.00',
  invoices: [
    {
      invoiceId: 'inv-0001',
      status: 'OUTSTANDING',
      amount: '9235.00',
      originalAmount: '10000.00',
      originalCurrency: 'USD',
      rate: {
        base: 'USD',
        quote: 'EUR',
        scaledValue: '923500000000',
        scale: 12,
        source: 'seed',
        asOf: '2026-01-15T10:32:00.000Z',
      },
    },
  ],
  outstandingTotal: '9235.00',
  invoiceCount: 1,
  repaidTotal: '0.00',
  repaidCount: 0,
};

describe('classifyFailure', () => {
  // The closed permanent set of docs/PLAN.md 2.2 — every named member.
  it.each([
    ['SnapshotRejectedError', new SnapshotRejectedError(REJECTION)],
    ['UnknownProgramError', new UnknownProgramError('prog-ghost')],
    [
      'MessageValidationError',
      new MessageValidationError('ProgramSnapshot', []),
    ],
    ['UnrecognisedMessageTypeError', new UnrecognisedMessageTypeError('Bogus')],
    ['SyntaxError', new SyntaxError('Unexpected token in JSON')],
  ])('classifies %s as permanent', (_name, error) => {
    expect(classifyFailure(error)).toBe('permanent');
  });

  // The safety property: every shape nobody named is transient, not just one example.
  it.each([
    ['a generic Error', new Error('boom')],
    ['a TypeError', new TypeError('not a function')],
    [
      'a MikroORM-shaped driver exception',
      Object.assign(new Error('connection terminated unexpectedly'), {
        name: 'DriverException',
        code: 'ECONNRESET',
      }),
    ],
    ['undefined', undefined],
    ['null', null],
    ['a plain object', { message: 'not an Error instance at all' }],
    ['a thrown string', 'something went wrong'],
  ])('classifies %s as transient', (_name, error) => {
    expect(classifyFailure(error)).toBe('transient');
  });
});

describe('parseMessage', () => {
  it('parses a valid ProgramSnapshot body into the matching, correctly-typed DTO', () => {
    const message = parseMessage(JSON.stringify(VALID_SNAPSHOT));

    expect(message.type).toBe('ProgramSnapshot');
    if (message.type !== 'ProgramSnapshot') {
      throw new Error('unreachable');
    }

    expect(message.programId).toBe('prog-hanseatic');
    expect(message.invoices[0]?.rate?.base).toBe('USD');
  });

  it('parses a valid ProgramLimitChanged body into the matching DTO', () => {
    const message = parseMessage(JSON.stringify(VALID_LIMIT_CHANGED));

    expect(message.type).toBe('ProgramLimitChanged');
    if (message.type !== 'ProgramLimitChanged') {
      throw new Error('unreachable');
    }

    expect(message.newLimit).toBe('2000000.00');
  });

  it('parses a valid InvoiceRepaid body into the matching DTO', () => {
    const message = parseMessage(JSON.stringify(VALID_INVOICE_REPAID));

    expect(message.type).toBe('InvoiceRepaid');
    if (message.type !== 'InvoiceRepaid') {
      throw new Error('unreachable');
    }

    expect(message.invoiceId).toBe('inv-0001');
  });

  it('throws the raw SyntaxError for text that is not valid JSON, unwrapped', () => {
    expect(() => parseMessage('{not valid json')).toThrow(SyntaxError);
  });

  it('throws UnrecognisedMessageTypeError for a missing type', () => {
    const { type: _type, ...withoutType } = VALID_INVOICE_REPAID;

    expect(() => parseMessage(JSON.stringify(withoutType))).toThrow(
      UnrecognisedMessageTypeError,
    );
  });

  it('throws UnrecognisedMessageTypeError for an unrecognised type', () => {
    expect(() =>
      parseMessage(JSON.stringify({ ...VALID_INVOICE_REPAID, type: 'Bogus' })),
    ).toThrow(UnrecognisedMessageTypeError);
  });

  it('throws UnrecognisedMessageTypeError for valid JSON that is not an object at all', () => {
    expect(() => parseMessage(JSON.stringify(['not', 'a', 'record']))).toThrow(
      UnrecognisedMessageTypeError,
    );
    expect(() => parseMessage(JSON.stringify(42))).toThrow(
      UnrecognisedMessageTypeError,
    );
  });

  it('throws MessageValidationError for a recognised type whose body fails class-validator, naming the field and constraint', () => {
    const { programId: _programId, ...withoutProgramId } = VALID_SNAPSHOT;

    try {
      parseMessage(JSON.stringify(withoutProgramId));
      throw new Error('expected parseMessage to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MessageValidationError);

      const validationError = error as MessageValidationError;

      expect(
        validationError.errors.some((e) => e.property === 'programId'),
      ).toBe(true);
      expect(validationError.message).toContain('programId');
      expect(classifyFailure(error)).toBe('permanent');
    }
  });

  it('MessageValidationError names a failing field nested inside the invoices array', () => {
    const invalid = {
      ...VALID_SNAPSHOT,
      invoices: [{ ...VALID_SNAPSHOT.invoices[0], invoiceId: '' }],
    };

    try {
      parseMessage(JSON.stringify(invalid));
      throw new Error('expected parseMessage to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MessageValidationError);
      expect((error as MessageValidationError).message).toContain('invoiceId');
    }
  });
});

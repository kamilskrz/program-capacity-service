import {
  toFxRate,
  toTreasuryInvoice,
  toTreasurySnapshot,
} from './treasury-message-mapper';
import {
  type FxRateMessage,
  type ProgramSnapshotMessage,
  type TreasuryInvoiceMessage,
} from './program-snapshot.message';
import {
  InvalidAmountError,
  UnknownCurrencyError,
} from '../../../capacity/domain/errors';
import { InvalidFxRateError } from '../../../fx/errors';

const RATE: FxRateMessage = {
  base: 'USD',
  quote: 'EUR',
  scaledValue: '923500000000',
  scale: 12,
  source: 'seed',
  asOf: '2026-01-15T10:32:00.000Z',
};

function invoiceMessage(
  overrides: Partial<TreasuryInvoiceMessage> = {},
): TreasuryInvoiceMessage {
  return {
    invoiceId: 'inv-0001',
    status: 'OUTSTANDING',
    amount: '9235.00',
    originalAmount: '10000.00',
    originalCurrency: 'USD',
    rate: RATE,
    ...overrides,
  };
}

function snapshotMessage(
  overrides: Partial<ProgramSnapshotMessage> = {},
): ProgramSnapshotMessage {
  return {
    type: 'ProgramSnapshot',
    programId: 'prog-hanseatic',
    currency: 'EUR',
    sequence: 1,
    asOf: '2026-01-15T10:32:00.000Z',
    creditLimit: '1000000.00',
    invoices: [invoiceMessage()],
    outstandingTotal: '9235.00',
    invoiceCount: 1,
    repaidTotal: '0.00',
    repaidCount: 0,
    ...overrides,
  };
}

describe('toFxRate', () => {
  it('builds a real FxRate from the wire shape', () => {
    const rate = toFxRate(RATE);

    expect(rate.base).toBe('USD');
    expect(rate.quote).toBe('EUR');
    expect(rate.toDecimalString()).toBe('0.9235');
  });

  it('throws the domain error for an unsupported currency', () => {
    expect(() => toFxRate({ ...RATE, base: 'XXX' })).toThrow(
      UnknownCurrencyError,
    );
  });

  it('throws the domain error for a rate stated at the wrong scale', () => {
    expect(() => toFxRate({ ...RATE, scale: 6 })).toThrow(InvalidFxRateError);
  });
});

describe('toTreasuryInvoice', () => {
  it('maps a converted entry, carrying the rate that priced it', () => {
    const invoice = toTreasuryInvoice(invoiceMessage(), 'EUR');

    expect(invoice.originalAmount.toString()).toBe('10000.00 USD');
    expect(invoice.amount.toString()).toBe('9235.00 EUR');
    expect(invoice.rate).not.toBeNull();
    expect(invoice.rate?.toDecimalString()).toBe('0.9235');
  });

  it('maps an unconverted entry with no rate', () => {
    const invoice = toTreasuryInvoice(
      invoiceMessage({
        amount: '10000.00',
        originalAmount: '10000.00',
        originalCurrency: 'EUR',
        rate: undefined,
      }),
      'EUR',
    );

    expect(invoice.rate).toBeNull();
    expect(invoice.amount.equals(invoice.originalAmount)).toBe(true);
  });

  it('throws InvalidAmountError for a malformed amount', () => {
    expect(() =>
      toTreasuryInvoice(invoiceMessage({ amount: 'not-a-number' }), 'EUR'),
    ).toThrow(InvalidAmountError);
  });

  it('throws InvalidAmountError for an amount with more fraction digits than the currency has', () => {
    expect(() =>
      toTreasuryInvoice(invoiceMessage({ amount: '9235.001' }), 'EUR'),
    ).toThrow(InvalidAmountError);
  });

  it('throws UnknownCurrencyError for an unsupported originalCurrency', () => {
    expect(() =>
      toTreasuryInvoice(invoiceMessage({ originalCurrency: 'XXX' }), 'EUR'),
    ).toThrow(UnknownCurrencyError);
  });
});

describe('toTreasurySnapshot', () => {
  it('round-trips a valid snapshot message', () => {
    const snapshot = toTreasurySnapshot(snapshotMessage());

    expect(snapshot.programId).toBe('prog-hanseatic');
    expect(snapshot.sequence).toBe(1);
    expect(snapshot.creditLimit.toString()).toBe('1000000.00 EUR');
    expect(snapshot.invoices).toHaveLength(1);
    expect(snapshot.invoices[0]?.amount.toString()).toBe('9235.00 EUR');
    expect(snapshot.invoices[0]?.rate?.toDecimalString()).toBe('0.9235');
    expect(snapshot.outstandingTotal.toString()).toBe('9235.00 EUR');
    expect(snapshot.repaidTotal.toString()).toBe('0.00 EUR');
    expect(snapshot.asOf.toISOString()).toBe('2026-01-15T10:32:00.000Z');
  });

  it('maps an invoice entry with no rate, already in the program currency', () => {
    const snapshot = toTreasurySnapshot(
      snapshotMessage({
        invoices: [
          invoiceMessage({
            amount: '10000.00',
            originalAmount: '10000.00',
            originalCurrency: 'EUR',
            rate: undefined,
          }),
        ],
        outstandingTotal: '10000.00',
      }),
    );

    expect(snapshot.invoices[0]?.rate).toBeNull();
    expect(
      snapshot.invoices[0]?.amount.equals(snapshot.invoices[0].originalAmount),
    ).toBe(true);
  });

  it('leaves asOf unreadable rather than throwing, for reconcileProgram to reject as UNREADABLE_AS_OF', () => {
    const snapshot = toTreasurySnapshot(
      snapshotMessage({ asOf: 'not-a-date' }),
    );

    expect(Number.isNaN(snapshot.asOf.getTime())).toBe(true);
  });

  it('throws InvalidAmountError for a malformed creditLimit', () => {
    expect(() =>
      toTreasurySnapshot(snapshotMessage({ creditLimit: 'garbage' })),
    ).toThrow(InvalidAmountError);
  });

  it('throws UnknownCurrencyError for an unsupported snapshot currency', () => {
    expect(() =>
      toTreasurySnapshot(snapshotMessage({ currency: 'XXX' })),
    ).toThrow(UnknownCurrencyError);
  });

  it('throws for a malformed amount nested inside an invoice entry', () => {
    expect(() =>
      toTreasurySnapshot(
        snapshotMessage({ invoices: [invoiceMessage({ amount: 'garbage' })] }),
      ),
    ).toThrow(InvalidAmountError);
  });
});

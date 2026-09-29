import {
  type ReserveInvoiceCommand,
  ReserveInvoiceUseCase,
} from './reserve-invoice.use-case';
import {
  InMemoryCapacityRepositories,
  InMemoryTransactionRunner,
} from './testing/in-memory-capacity-repositories';
import {
  FixedClock,
  OCCURRED_AT,
  aProgram,
  aReservation,
  unconverted,
} from './testing/factories';
import {
  DuplicateInvoiceError,
  InsufficientCapacityError,
} from '../domain/capacity-errors';
import { InvalidAmountError, UnknownCurrencyError } from '../domain/errors';
import { Money } from '../domain/money';
import { ProgramNotFoundError } from './errors';
import { FxRateNotFoundError } from '../../fx/errors';
import { FxRate } from '../../fx/fx-rate';

// Pins `ReserveInvoiceUseCase.execute`'s behaviour (docs/PLAN.md 2.4).
describe('ReserveInvoiceUseCase', () => {
  function setup(clock: FixedClock = new FixedClock()) {
    const repos = new InMemoryCapacityRepositories();
    const runner = new InMemoryTransactionRunner(repos);
    const useCase = new ReserveInvoiceUseCase(runner, clock);

    return { repos, useCase };
  }

  function aCommand(
    overrides: Partial<ReserveInvoiceCommand> = {},
  ): ReserveInvoiceCommand {
    return {
      programId: 'prog-northwind',
      invoiceId: 'inv-0001',
      amount: '100.00',
      currency: 'USD',
      actor: 'user-42',
      correlationId: 'corr-0001',
      ...overrides,
    };
  }

  it('rejects a program that does not exist, and persists nothing', async () => {
    const { repos, useCase } = setup();

    await expect(useCase.execute(aCommand())).rejects.toThrow(
      ProgramNotFoundError,
    );

    expect(repos.events.appended).toHaveLength(0);
    expect(
      await repos.reservations.findForInvoice('prog-northwind', 'inv-0001'),
    ).toBeNull();
  });

  it('creates a new reservation when the program has capacity', async () => {
    const { repos, useCase } = setup();

    repos.programs.seed(aProgram());

    const result = await useCase.execute(aCommand({ amount: '100.00' }));

    expect(result.status).toBe('CREATED');
    expect(result.reservation.invoiceId).toBe('inv-0001');
    expect(result.reservation.reservedAmount.toString()).toBe('100.00 USD');

    expect(repos.events.appended).toHaveLength(1);
    expect(repos.events.appended[0]?.type).toBe('RESERVED');

    await expect(
      repos.reservations.findForInvoice('prog-northwind', 'inv-0001'),
    ).resolves.toBe(result.reservation);
  });

  it('throws InsufficientCapacityError and persists nothing when capacity is exhausted', async () => {
    const { repos, useCase } = setup();

    repos.programs.seed(
      aProgram({ creditLimit: Money.fromDecimalString('50.00', 'USD') }),
    );

    await expect(
      useCase.execute(aCommand({ amount: '100.00' })),
    ).rejects.toThrow(InsufficientCapacityError);

    expect(repos.events.appended).toHaveLength(0);
    expect(
      await repos.reservations.findForInvoice('prog-northwind', 'inv-0001'),
    ).toBeNull();
  });

  it('replays an identical active reservation, adding and appending nothing', async () => {
    const { repos, useCase } = setup();
    const program = aProgram();
    const existing = aReservation(
      program,
      'inv-0001',
      unconverted(Money.fromDecimalString('100.00', 'USD')),
    );

    repos.programs.seed(program);
    repos.reservations.seed(existing);

    const result = await useCase.execute(aCommand({ amount: '100.00' }));

    expect(result.status).toBe('REPLAYED');
    expect(result.reservation).toBe(existing);
    expect(repos.events.appended).toHaveLength(0);
  });

  it('rejects a replay stating a different original amount', async () => {
    const { repos, useCase } = setup();
    const program = aProgram();
    const existing = aReservation(
      program,
      'inv-0001',
      unconverted(Money.fromDecimalString('100.00', 'USD')),
    );

    repos.programs.seed(program);
    repos.reservations.seed(existing);

    await expect(
      useCase.execute(aCommand({ amount: '200.00' })),
    ).rejects.toThrow(DuplicateInvoiceError);
  });

  it('rejects re-reserving an invoice that was already released', async () => {
    const { repos, useCase } = setup();
    const program = aProgram();
    const existing = aReservation(
      program,
      'inv-0001',
      unconverted(Money.fromDecimalString('100.00', 'USD')),
    );

    existing.release('REPAID', OCCURRED_AT);
    repos.programs.seed(program);
    repos.reservations.seed(existing);

    await expect(
      useCase.execute(aCommand({ amount: '100.00' })),
    ).rejects.toThrow(DuplicateInvoiceError);
  });

  it('carries the FX evidence when conversion is needed and a rate exists', async () => {
    const { repos, useCase } = setup();

    repos.programs.seed(aProgram({ id: 'prog-hanseatic', currency: 'EUR' }));
    repos.rates.seed(
      FxRate.fromDecimalString({
        base: 'USD',
        quote: 'EUR',
        value: '0.9235',
        source: 'seed',
        asOf: OCCURRED_AT,
      }),
    );

    const result = await useCase.execute(
      aCommand({
        programId: 'prog-hanseatic',
        amount: '100.00',
        currency: 'USD',
      }),
    );

    expect(result.reservation.originalAmount.toString()).toBe('100.00 USD');
    expect(result.reservation.fxRate?.toDecimalString()).toBe('0.9235');
  });

  it('replays a converted reservation even if its rate is no longer quoted', async () => {
    const { repos, useCase } = setup();
    const program = aProgram({ id: 'prog-hanseatic', currency: 'EUR' });
    const rate = FxRate.fromDecimalString({
      base: 'USD',
      quote: 'EUR',
      value: '0.9235',
      source: 'seed',
      asOf: OCCURRED_AT,
    });
    const existing = aReservation(program, 'inv-0001', {
      original: Money.fromDecimalString('100.00', 'USD'),
      converted: Money.fromDecimalString('92.35', 'EUR'),
      rate,
    });

    repos.programs.seed(program);
    repos.reservations.seed(existing);
    // repos.rates is deliberately left empty: the pair that priced `existing`
    // is no longer quoted, and a replay must not need it (docs/PLAN.md 2.3 —
    // fx_rates holds only the current quote, so this is a real, reachable gap).

    const result = await useCase.execute(
      aCommand({
        programId: 'prog-hanseatic',
        amount: '100.00',
        currency: 'USD',
      }),
    );

    expect(result.status).toBe('REPLAYED');
    expect(result.reservation).toBe(existing);
  });

  it('throws FxRateNotFoundError when conversion is needed and no rate exists', async () => {
    const { repos, useCase } = setup();

    repos.programs.seed(aProgram({ id: 'prog-hanseatic', currency: 'EUR' }));

    await expect(
      useCase.execute(
        aCommand({
          programId: 'prog-hanseatic',
          amount: '100.00',
          currency: 'USD',
        }),
      ),
    ).rejects.toThrow(FxRateNotFoundError);
  });

  it('rejects a malformed amount before anything is persisted', async () => {
    const { repos, useCase } = setup();

    repos.programs.seed(aProgram());

    await expect(
      useCase.execute(aCommand({ amount: 'not-a-number' })),
    ).rejects.toThrow(InvalidAmountError);

    expect(repos.events.appended).toHaveLength(0);
  });

  it('rejects an unsupported currency before anything is persisted', async () => {
    const { repos, useCase } = setup();

    repos.programs.seed(aProgram());

    await expect(
      useCase.execute(aCommand({ currency: 'XXX' })),
    ).rejects.toThrow(UnknownCurrencyError);

    expect(repos.events.appended).toHaveLength(0);
  });

  it('fails to parse a malformed amount even where a replay would otherwise apply', async () => {
    const { repos, useCase } = setup();
    const program = aProgram();
    const existing = aReservation(
      program,
      'inv-0001',
      unconverted(Money.fromDecimalString('100.00', 'USD')),
    );

    repos.programs.seed(program);
    repos.reservations.seed(existing);

    await expect(
      useCase.execute(aCommand({ amount: 'garbage' })),
    ).rejects.toThrow(InvalidAmountError);
  });

  it('maps the flush-time unique-constraint backstop to DuplicateInvoiceError', async () => {
    const { repos, useCase } = setup();

    repos.programs.seed(aProgram());
    repos.reservations.forceUniqueViolationOnNextAdd();

    await expect(useCase.execute(aCommand())).rejects.toThrow(
      DuplicateInvoiceError,
    );
  });

  it('takes occurredAt from the injected clock, not the wall clock', async () => {
    const fixed = new Date('2030-06-01T00:00:00.000Z');
    const { repos, useCase } = setup(new FixedClock(fixed));

    repos.programs.seed(aProgram());

    const result = await useCase.execute(aCommand());

    expect(result.reservation.reservedAt.toISOString()).toBe(
      fixed.toISOString(),
    );
    expect(repos.events.appended[0]?.occurredAt.toISOString()).toBe(
      fixed.toISOString(),
    );
  });

  it('wires actor, correlationId and source into the capacity change context', async () => {
    const { repos, useCase } = setup();

    repos.programs.seed(aProgram());

    await useCase.execute(
      aCommand({ actor: 'user-99', correlationId: 'corr-xyz' }),
    );

    const event = repos.events.appended[0]!;

    expect(event.actor).toBe('user-99');
    expect(event.correlationId).toBe('corr-xyz');
    expect(event.source).toBe('API');
  });
});

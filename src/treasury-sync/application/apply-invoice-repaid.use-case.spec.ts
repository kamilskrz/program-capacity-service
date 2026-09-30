import { ApplyInvoiceRepaidUseCase } from './apply-invoice-repaid.use-case';
import { UnknownProgramError } from './errors';
import { anInvoiceRepaidMessage } from './testing/factories';
import {
  FixedClock,
  aProgram,
  aReservation,
  unconverted,
} from '../../capacity/application/testing/factories';
import {
  InMemoryCapacityRepositories,
  InMemoryTransactionRunner,
} from '../../capacity/application/testing/in-memory-capacity-repositories';
import { Money } from '../../capacity/domain/money';

describe('ApplyInvoiceRepaidUseCase', () => {
  function setUp() {
    const repos = new InMemoryCapacityRepositories();
    const runner = new InMemoryTransactionRunner(repos);
    const useCase = new ApplyInvoiceRepaidUseCase(runner, new FixedClock());

    return { repos, useCase };
  }

  it('releases the reservation and reports RELEASED, with a RELEASED event attributed to treasury:kafka', async () => {
    const { repos, useCase } = setUp();
    const program = aProgram();
    const reservation = aReservation(
      program,
      'inv-0001',
      unconverted(Money.fromMinorUnits(1_000_000n, 'USD')),
    );

    repos.programs.seed(program);
    repos.reservations.seed(reservation);

    const result = await useCase.execute(
      anInvoiceRepaidMessage(program, 'inv-0001'),
    );

    expect(result.status).toBe('RELEASED');

    if (result.status === 'RELEASED') {
      expect(result.change.event?.type).toBe('RELEASED');
      expect(result.change.event?.source).toBe('TREASURY_EVENT');
      expect(result.change.event?.actor).toBe('treasury:kafka');
    }
  });

  it('is a documented no-op, not an error, for an invoice this service holds no reservation for', async () => {
    const { repos, useCase } = setUp();
    const program = aProgram();

    repos.programs.seed(program);

    const result = await useCase.execute(
      anInvoiceRepaidMessage(program, 'inv-unknown'),
    );

    expect(result.status).toBe('UNKNOWN_INVOICE');
  });

  it('throws the transport-facing error for an unknown program', async () => {
    const { useCase } = setUp();
    const message = anInvoiceRepaidMessage(
      aProgram({ id: 'prog-ghost' }),
      'inv-0001',
    );

    await expect(useCase.execute(message)).rejects.toThrow(UnknownProgramError);
  });
});

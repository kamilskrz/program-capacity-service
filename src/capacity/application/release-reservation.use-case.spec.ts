import {
  type ReleaseReservationCommand,
  ReleaseReservationUseCase,
} from './release-reservation.use-case';
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
import { Money } from '../domain/money';
import { ProgramNotFoundError, ReservationNotFoundError } from './errors';

// Pins `ReleaseReservationUseCase.execute`'s behaviour (docs/PLAN.md 2.4, 2.5).
describe('ReleaseReservationUseCase', () => {
  function setup() {
    const repos = new InMemoryCapacityRepositories();
    const runner = new InMemoryTransactionRunner(repos);
    const useCase = new ReleaseReservationUseCase(runner, new FixedClock());

    return { repos, useCase };
  }

  function aCommand(
    overrides: Partial<ReleaseReservationCommand> = {},
  ): ReleaseReservationCommand {
    return {
      programId: 'prog-northwind',
      invoiceId: 'inv-0001',
      reason: 'REPAID',
      actor: 'user-42',
      correlationId: 'corr-0001',
      ...overrides,
    };
  }

  function seedActiveReservation(repos: InMemoryCapacityRepositories) {
    const program = aProgram();
    const reservation = aReservation(
      program,
      'inv-0001',
      unconverted(Money.fromDecimalString('100.00', 'USD')),
    );

    repos.programs.seed(program);
    repos.reservations.seed(reservation);

    return reservation;
  }

  it('rejects a program that does not exist', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(aCommand())).rejects.toThrow(
      ProgramNotFoundError,
    );
  });

  it('rejects an invoice with no reservation', async () => {
    const { repos, useCase } = setup();

    repos.programs.seed(aProgram());

    await expect(useCase.execute(aCommand())).rejects.toThrow(
      ReservationNotFoundError,
    );
  });

  it('releases an active reservation, freeing capacity and appending one event', async () => {
    const { repos, useCase } = setup();

    seedActiveReservation(repos);

    const result = await useCase.execute(aCommand());

    expect(result.reservation.status).toBe('RELEASED');
    expect(result.reservation.releaseReason).toBe('REPAID');
    expect(repos.events.appended).toHaveLength(1);
    expect(repos.events.appended[0]?.type).toBe('RELEASED');
  });

  it('is a no-op for an already-released reservation: no event, no throw', async () => {
    const { repos, useCase } = setup();
    const reservation = seedActiveReservation(repos);

    reservation.release('REPAID', OCCURRED_AT);

    const result = await useCase.execute(aCommand());

    expect(result.reservation.status).toBe('RELEASED');
    expect(repos.events.appended).toHaveLength(0);
  });

  it('wires actor, correlationId and source into the capacity change context', async () => {
    const { repos, useCase } = setup();

    seedActiveReservation(repos);

    await useCase.execute(
      aCommand({ actor: 'user-99', correlationId: 'corr-xyz' }),
    );

    const event = repos.events.appended[0]!;

    expect(event.actor).toBe('user-99');
    expect(event.correlationId).toBe('corr-xyz');
    expect(event.source).toBe('API');
  });
});

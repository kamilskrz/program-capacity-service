import { ApplyLimitChangeUseCase } from './apply-limit-change.use-case';
import { UnknownProgramError } from './errors';
import { aLimitChangedMessage } from './testing/factories';
import {
  FixedClock,
  aProgram,
} from '../../capacity/application/testing/factories';
import {
  InMemoryCapacityRepositories,
  InMemoryTransactionRunner,
} from '../../capacity/application/testing/in-memory-capacity-repositories';

describe('ApplyLimitChangeUseCase', () => {
  function setUp() {
    const repos = new InMemoryCapacityRepositories();
    const runner = new InMemoryTransactionRunner(repos);
    const useCase = new ApplyLimitChangeUseCase(runner, new FixedClock());

    return { repos, useCase };
  }

  it('locks the program, changes the limit, and appends a LIMIT_CHANGED event attributed to treasury:kafka', async () => {
    const { repos, useCase } = setUp();
    const program = aProgram();

    repos.programs.seed(program);

    const message = aLimitChangedMessage(program, '2000000.00');
    const result = await useCase.execute(message);

    expect(result.event?.type).toBe('LIMIT_CHANGED');
    expect(result.event?.source).toBe('TREASURY_EVENT');
    expect(result.event?.actor).toBe('treasury:kafka');
  });

  it('is a no-op, with no event, for a limit identical to the current one — the redelivery case', async () => {
    const { repos, useCase } = setUp();
    const program = aProgram();

    repos.programs.seed(program);

    const message = aLimitChangedMessage(
      program,
      program.creditLimit.toDecimalString(),
    );
    const result = await useCase.execute(message);

    expect(result.event).toBeNull();
  });

  it('throws the transport-facing error for an unknown program', async () => {
    const { useCase } = setUp();
    const message = aLimitChangedMessage(
      aProgram({ id: 'prog-ghost' }),
      '2000000.00',
    );

    await expect(useCase.execute(message)).rejects.toThrow(UnknownProgramError);
  });
});

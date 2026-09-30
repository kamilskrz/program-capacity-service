import {
  type CreateProgramCommand,
  CreateProgramUseCase,
} from './create-program.use-case';
import {
  InMemoryCapacityRepositories,
  InMemoryTransactionRunner,
} from './testing/in-memory-capacity-repositories';
import { DuplicateProgramError } from './errors';
import { InvalidProgramError } from '../domain/capacity-errors';

// Pins `CreateProgramUseCase.execute`'s behaviour (docs/PLAN.md 2.7): parse the
// command through `Program.create`, persist it, and touch nothing else — no
// clock, no FX, no capacity event (creating a program is not a capacity change).
describe('CreateProgramUseCase', () => {
  function setup() {
    const repos = new InMemoryCapacityRepositories();
    const runner = new InMemoryTransactionRunner(repos);
    const useCase = new CreateProgramUseCase(runner);

    return { repos, useCase };
  }

  function aCommand(
    overrides: Partial<CreateProgramCommand> = {},
  ): CreateProgramCommand {
    return {
      id: 'prog-northwind',
      ownerOrgId: 'org-northwind',
      currency: 'USD',
      creditLimit: '1000000.00',
      ...overrides,
    };
  }

  it('creates and persists a program with the given fields', async () => {
    const { repos, useCase } = setup();

    const program = await useCase.execute(aCommand());

    expect(program.id).toBe('prog-northwind');
    expect(program.ownerOrgId).toBe('org-northwind');
    expect(program.currency).toBe('USD');
    expect(program.creditLimit.toString()).toBe('1000000.00 USD');
    expect(program.reserved.toString()).toBe('0.00 USD');

    await expect(repos.programs.findById('prog-northwind')).resolves.toBe(
      program,
    );
  });

  it('appends no capacity event: creating a program is not a capacity change', async () => {
    const { repos, useCase } = setup();

    await useCase.execute(aCommand());

    expect(repos.events.appended).toHaveLength(0);
  });

  it("surfaces Program.create's own validation, e.g. a blank id", async () => {
    const { useCase } = setup();

    await expect(useCase.execute(aCommand({ id: '   ' }))).rejects.toThrow(
      InvalidProgramError,
    );
  });

  it("surfaces Program.create's own validation, e.g. a negative credit limit", async () => {
    const { useCase } = setup();

    await expect(
      useCase.execute(aCommand({ creditLimit: '-1.00' })),
    ).rejects.toThrow();
  });

  it('maps a taken id to DuplicateProgramError, not the raw driver exception', async () => {
    const { repos, useCase } = setup();

    await useCase.execute(aCommand());

    await expect(useCase.execute(aCommand())).rejects.toThrow(
      DuplicateProgramError,
    );
    expect(await repos.programs.findById('prog-northwind')).not.toBeNull();
  });
});

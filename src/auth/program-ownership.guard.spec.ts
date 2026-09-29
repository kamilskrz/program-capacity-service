import { type ExecutionContext, NotFoundException } from '@nestjs/common';
import { type EntityManager } from '@mikro-orm/postgresql';

import { ProgramOwnershipGuard } from './program-ownership.guard';

// A fake at the `EntityManager` seam `MikroOrmProgramRepository.findById` reads
// through (docs/PLAN.md 2.6) — the in-memory-fake pattern block 3 established,
// applied one layer down since the guard's constructor is pinned to `EntityManager`.
function createEntityManager(
  row: { id: string; ownerOrgId: string } | null,
): EntityManager {
  return {
    isInTransaction: () => false,
    findOne: jest.fn().mockResolvedValue(row),
  } as unknown as EntityManager;
}

function createContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const requestFor = (
  programId: string,
  org: string,
): Record<string, unknown> => ({
  params: { id: programId },
  user: { sub: 'user-1', org, scope: 'capacity:write' },
});

/** The rejection a `canActivate` call is expected to produce, typed as one. */
async function captureRejection(
  outcome: boolean | Promise<boolean>,
): Promise<NotFoundException> {
  try {
    await outcome;
  } catch (error) {
    return error as NotFoundException;
  }

  throw new Error('expected canActivate to reject, but it resolved');
}

describe('ProgramOwnershipGuard', () => {
  it("passes when the program exists and belongs to the caller's organisation", async () => {
    const guard = new ProgramOwnershipGuard(
      createEntityManager({
        id: 'prog-northwind',
        ownerOrgId: 'org-northwind',
      }),
    );

    await expect(
      guard.canActivate(
        createContext(requestFor('prog-northwind', 'org-northwind')),
      ),
    ).resolves.toBe(true);
  });

  it('refuses with NotFoundException, not ForbiddenException, when the program belongs to another organisation', async () => {
    const guard = new ProgramOwnershipGuard(
      createEntityManager({ id: 'prog-northwind', ownerOrgId: 'org-other' }),
    );

    await expect(
      guard.canActivate(
        createContext(requestFor('prog-northwind', 'org-northwind')),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses with NotFoundException when the program does not exist at all', async () => {
    const guard = new ProgramOwnershipGuard(createEntityManager(null));

    await expect(
      guard.canActivate(
        createContext(requestFor('prog-unknown', 'org-northwind')),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cannot be told apart, in status or message, from a program that does not exist', async () => {
    const request = requestFor('prog-northwind', 'org-northwind');
    const mismatch = await captureRejection(
      new ProgramOwnershipGuard(
        createEntityManager({ id: 'prog-northwind', ownerOrgId: 'org-other' }),
      ).canActivate(createContext(request)),
    );
    const missing = await captureRejection(
      new ProgramOwnershipGuard(createEntityManager(null)).canActivate(
        createContext(request),
      ),
    );

    expect(mismatch).toBeInstanceOf(NotFoundException);
    expect(missing).toBeInstanceOf(NotFoundException);
    expect(mismatch.getStatus()).toBe(missing.getStatus());
    expect(mismatch.message).toBe(missing.message);
  });
});

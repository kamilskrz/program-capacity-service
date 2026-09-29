import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { type AuthenticatedUser } from './claims';
import { MikroOrmProgramRepository } from '../capacity/infrastructure/persistence/mikro-orm-program.repository';

interface RequestWithProgramParam {
  params: { id: string };
  user: AuthenticatedUser;
}

const NOT_FOUND_MESSAGE = 'Program not found.';

/**
 * Per-route, applied after `JwtAuthGuard` so `request.user` already exists
 * (docs/PLAN.md 2.7). Reads `:id`, does one unlocked `ProgramRepository.findById`,
 * and refuses with the same `NotFoundException` whether the program does not
 * exist or belongs to another organisation — the two must be indistinguishable
 * to a caller.
 */
@Injectable()
export class ProgramOwnershipGuard implements CanActivate {
  constructor(private readonly em: EntityManager) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<RequestWithProgramParam>();
    const programId = request.params.id;
    const org = request.user.org;

    const repository = new MikroOrmProgramRepository(this.em);
    const program = await repository.findById(programId);

    if (program === null || program.ownerOrgId !== org) {
      throw new NotFoundException(NOT_FOUND_MESSAGE);
    }

    return true;
  }
}

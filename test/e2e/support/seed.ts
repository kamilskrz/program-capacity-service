import { type MikroORM } from '@mikro-orm/postgresql';

import { type Program } from '../../../src/capacity/domain/program';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';

/**
 * Writes a program directly through the real repository, bypassing HTTP —
 * `POST /programs` is still a stub, and several of these suites (ownership,
 * problem details, pagination) exercise routes that do not depend on it
 * (docs/PLAN.md 2.7's second half).
 */
export async function seedProgram(
  orm: MikroORM,
  program: Program,
): Promise<void> {
  const em = orm.em.fork();

  await em.transactional(async (tx) => {
    new MikroOrmProgramRepository(tx).add(program);
    await tx.flush();
  });
}

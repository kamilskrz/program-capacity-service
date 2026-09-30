import { type MikroORM } from '@mikro-orm/postgresql';

import { type Program } from '../../../src/capacity/domain/program';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';

/**
 * Writes a program directly through the real repository, bypassing HTTP, so a
 * suite that exercises other routes (ownership, problem details, pagination)
 * does not depend on `POST /programs` for its own setup.
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

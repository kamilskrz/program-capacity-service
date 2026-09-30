import { type INestApplication } from '@nestjs/common';
import { type MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';

import { createE2eApp, httpServer } from './support/bootstrap';
import { seedProgram } from './support/seed';
import { mintToken } from './support/tokens';
import { aProgram } from '../integration/support/factories';
import { initTestOrm, resetDatabase } from '../integration/support/orm';

// `ProgramOwnershipGuard` is real, existing code (docs/PLAN.md 2.7): it runs
// before the (stubbed) `CapacityQueryService`, so this whole file is expected
// to pass now.
describe('program ownership', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let tokenForOrgA: string;

  beforeAll(async () => {
    app = await createE2eApp();
    orm = await initTestOrm();
    tokenForOrgA = await mintToken(app, {
      sub: 'user-a',
      org: 'org-a',
      scope: 'capacity:write',
    });
  });

  afterAll(async () => {
    await orm.close(true);
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(orm);
  });

  it("404s org A's token against a program owned by org B — identical status and body to a genuinely nonexistent program", async () => {
    await seedProgram(
      orm,
      aProgram({ id: 'prog-owned-by-b', ownerOrgId: 'org-b' }),
    );

    const headers = {
      Authorization: `Bearer ${tokenForOrgA}`,
      // Fixed, so both responses share one `traceId` and can be compared whole.
      'X-Request-Id': 'trace-ownership-test',
    };

    const forOtherOrg = await request(httpServer(app))
      .get('/api/v1/programs/prog-owned-by-b/capacity')
      .set(headers);
    const forMissingProgram = await request(httpServer(app))
      .get('/api/v1/programs/prog-does-not-exist/capacity')
      .set(headers);

    expect(forOtherOrg.status).toBe(404);
    expect(forOtherOrg.status).toBe(forMissingProgram.status);
    expect(forOtherOrg.body).toEqual(forMissingProgram.body);
  });
});

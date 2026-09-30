import { type INestApplication } from '@nestjs/common';
import { type MikroORM } from '@mikro-orm/postgresql';
import request, { type Response } from 'supertest';

import { createE2eApp, httpServer } from './support/bootstrap';
import { seedProgram } from './support/seed';
import { mintToken } from './support/tokens';
import { aProgram } from '../integration/support/factories';
import { initTestOrm, resetDatabase } from '../integration/support/orm';
import { Money } from '../../src/capacity/domain/money';

/** Every field `ProblemDetailsFilter` promises, plus the media type (docs/PLAN.md 2.7). */
function expectProblemDetails(response: Response, status: number): void {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toContain(
    'application/problem+json',
  );
  expect(response.body).toMatchObject({
    type: expect.any(String),
    title: expect.any(String),
    status,
    detail: expect.any(String),
    code: expect.any(String),
    traceId: expect.any(String),
  });
}

describe('RFC 7807 problem details', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let adminToken: string;
  let writeToken: string;

  beforeAll(async () => {
    app = await createE2eApp();
    orm = await initTestOrm();
    adminToken = await mintToken(app, {
      sub: 'admin-1',
      org: 'org-a',
      scope: 'programs:admin',
    });
    writeToken = await mintToken(app, {
      sub: 'user-1',
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

  it('400s an invalid POST /programs body', async () => {
    const response = await request(httpServer(app))
      .post('/api/v1/programs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expectProblemDetails(response, 400);
  });

  it('404s an unknown program', async () => {
    const response = await request(httpServer(app))
      .get('/api/v1/programs/prog-does-not-exist/capacity')
      .set('Authorization', `Bearer ${writeToken}`);

    expectProblemDetails(response, 404);
  });

  it('409s a reservation that exceeds available capacity', async () => {
    await seedProgram(
      orm,
      aProgram({
        id: 'prog-thin',
        ownerOrgId: 'org-a',
        creditLimit: Money.fromDecimalString('50.00', 'USD'),
      }),
    );

    const response = await request(httpServer(app))
      .post('/api/v1/programs/prog-thin/reservations')
      .set('Authorization', `Bearer ${writeToken}`)
      .send({ invoiceId: 'inv-1', amount: '100.00', currency: 'USD' });

    expectProblemDetails(response, 409);
    expect((response.body as { code: string }).code).toBe(
      'INSUFFICIENT_CAPACITY',
    );
  });

  it('422s a reservation whose currency has no quoted FX rate', async () => {
    await seedProgram(
      orm,
      aProgram({ id: 'prog-fx', ownerOrgId: 'org-a', currency: 'USD' }),
    );

    const response = await request(httpServer(app))
      .post('/api/v1/programs/prog-fx/reservations')
      .set('Authorization', `Bearer ${writeToken}`)
      .send({ invoiceId: 'inv-1', amount: '10.00', currency: 'GBP' });

    expectProblemDetails(response, 422);
    expect((response.body as { code: string }).code).toBe('FX_RATE_NOT_FOUND');
  });

  it('400s a hand-edited events cursor instead of crashing on it', async () => {
    await seedProgram(
      orm,
      aProgram({ id: 'prog-cursor', ownerOrgId: 'org-a' }),
    );

    const response = await request(httpServer(app))
      .get('/api/v1/programs/prog-cursor/events?after=not-a-number')
      .set('Authorization', `Bearer ${writeToken}`);

    expectProblemDetails(response, 400);
  });
});

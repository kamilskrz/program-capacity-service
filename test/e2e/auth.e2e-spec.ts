import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createE2eApp, httpServer } from './support/bootstrap';
import { mintToken } from './support/tokens';

// `JwtAuthGuard` and `@Public()` are real, existing code (docs/PLAN.md 2.7) —
// none of this depends on block 4's second-half stubs, so every test here is
// expected to pass now, not just once the controllers are filled in.
describe('authentication and scopes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a protected route with no Authorization header', async () => {
    const response = await request(httpServer(app)).get(
      '/api/v1/programs/prog-any/capacity',
    );

    expect(response.status).toBe(401);
  });

  it('rejects a garbage bearer token', async () => {
    const response = await request(httpServer(app))
      .get('/api/v1/programs/prog-any/capacity')
      .set('Authorization', 'Bearer not-a-real-token');

    expect(response.status).toBe(401);
  });

  it('rejects a valid token missing the required scope with 403', async () => {
    const token = await mintToken(app, {
      sub: 'user-1',
      org: 'org-northwind',
      scope: 'nothing:useful',
    });

    const response = await request(httpServer(app))
      .post('/api/v1/programs')
      .set('Authorization', `Bearer ${token}`)
      .send({
        id: 'prog-should-not-be-created',
        ownerOrgId: 'org-northwind',
        currency: 'USD',
        creditLimit: '100.00',
      });

    expect(response.status).toBe(403);
  });

  it('reaches the @Public() dev token endpoint with no token at all', async () => {
    const response = await request(httpServer(app))
      .post('/api/v1/auth/token')
      .send({ sub: 'user-1', org: 'org-northwind', scope: 'capacity:write' });

    expect(response.status).toBe(201);
    expect(
      typeof (response.body as { accessToken?: unknown }).accessToken,
    ).toBe('string');
  });

  it.each(['/health', '/health/ready'])(
    'reaches %s with no token: an orchestrator probe carries none',
    async (path) => {
      const response = await request(httpServer(app)).get(path);

      expect(response.status).not.toBe(401);
    },
  );
});

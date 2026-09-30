import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createE2eApp, httpServer } from './support/bootstrap';
import { mintToken } from './support/tokens';

/**
 * The full contract of docs/PLAN.md 2.7's second half, through one real,
 * signed token: create → reserve → replay → release → capacity/reservations/
 * events read back.
 */
describe('the reserve/release happy path through real HTTP', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await createE2eApp();
    token = await mintToken(app, {
      sub: 'user-1',
      org: 'org-a',
      scope: 'programs:admin capacity:write',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates, reserves, replays, releases, and reads capacity/reservations/events back', async () => {
    const createResponse = await request(httpServer(app))
      .post('/api/v1/programs')
      .set('Authorization', `Bearer ${token}`)
      .send({
        id: 'prog-e2e-happy',
        ownerOrgId: 'org-a',
        currency: 'USD',
        creditLimit: '1000.00',
      });

    expect(createResponse.status).toBe(201);

    const reserveResponse = await request(httpServer(app))
      .post('/api/v1/programs/prog-e2e-happy/reservations')
      .set('Authorization', `Bearer ${token}`)
      .send({ invoiceId: 'inv-1', amount: '100.00', currency: 'USD' });

    expect(reserveResponse.status).toBe(201);

    const replayResponse = await request(httpServer(app))
      .post('/api/v1/programs/prog-e2e-happy/reservations')
      .set('Authorization', `Bearer ${token}`)
      .send({ invoiceId: 'inv-1', amount: '100.00', currency: 'USD' });

    expect(replayResponse.status).toBe(200);
    expect(replayResponse.body).toEqual(reserveResponse.body);

    const releaseResponse = await request(httpServer(app))
      .post('/api/v1/programs/prog-e2e-happy/reservations/inv-1/release')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'REPAID' });

    expect(releaseResponse.status).toBe(200);

    const capacityResponse = await request(httpServer(app))
      .get('/api/v1/programs/prog-e2e-happy/capacity')
      .set('Authorization', `Bearer ${token}`);

    expect(capacityResponse.status).toBe(200);
    expect((capacityResponse.body as { reserved: string }).reserved).toBe(
      '0.00',
    );

    const reservationsResponse = await request(httpServer(app))
      .get('/api/v1/programs/prog-e2e-happy/reservations')
      .set('Authorization', `Bearer ${token}`);

    expect(reservationsResponse.status).toBe(200);
    expect(
      (reservationsResponse.body as { reservations: unknown[] }).reservations,
    ).toHaveLength(1);

    const eventsResponse = await request(httpServer(app))
      .get('/api/v1/programs/prog-e2e-happy/events')
      .set('Authorization', `Bearer ${token}`);

    expect(eventsResponse.status).toBe(200);

    for (const event of (eventsResponse.body as { events: { id: unknown }[] })
      .events) {
      expect(typeof event.id).toBe('string');
    }
  });
});

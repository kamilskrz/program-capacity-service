import { type INestApplication } from '@nestjs/common';
import { type MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';

import { createE2eApp, httpServer } from './support/bootstrap';
import { seedProgram } from './support/seed';
import { mintToken } from './support/tokens';
import { aProgram } from '../integration/support/factories';
import { initTestOrm, resetDatabase } from '../integration/support/orm';

// `/metrics` (docs/PLAN.md 2.8): outside `/api/v1`, public, Prometheus text.
describe('the metrics endpoint', () => {
  let app: INestApplication;
  let orm: MikroORM;

  beforeAll(async () => {
    app = await createE2eApp();
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close(true);
    await app.close();
  }, 30_000);

  it('is reachable with no token: a scraper carries none', async () => {
    const response = await request(httpServer(app)).get('/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
  });

  it('exposes every business metric docs/PLAN.md 2.8 names', async () => {
    const { text } = await request(httpServer(app)).get('/metrics');

    for (const metric of [
      'capacity_reservations_total',
      'capacity_utilization_ratio',
      'treasury_snapshot_lag_seconds',
      'treasury_reconciliation_discrepancies_total',
      'kafka_messages_total',
      'kafka_dlq_total',
    ]) {
      expect(text).toContain(metric);
    }
  });

  it('counts a reservation it serves, and reports that program’s utilisation', async () => {
    await resetDatabase(orm);
    await seedProgram(
      orm,
      aProgram({ id: 'prog-metrics', ownerOrgId: 'org-a' }),
    );

    const token = await mintToken(app, {
      sub: 'user-1',
      org: 'org-a',
      scope: 'capacity:write',
    });

    await request(httpServer(app))
      .post('/api/v1/programs/prog-metrics/reservations')
      .set('Authorization', `Bearer ${token}`)
      .send({ invoiceId: 'inv-metrics-1', amount: '100.00', currency: 'USD' })
      .expect(201);

    const { text } = await request(httpServer(app)).get('/metrics');

    expect(text).toMatch(
      /capacity_reservations_total\{result="created"\} [1-9]/,
    );
    expect(text).toContain(
      'capacity_utilization_ratio{programId="prog-metrics"}',
    );
  }, 30_000);
});

import { type INestApplication } from '@nestjs/common';
import { type MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';

import { createE2eApp, httpServer } from './support/bootstrap';
import { seedProgram } from './support/seed';
import { mintToken } from './support/tokens';
import { aProgram } from '../integration/support/factories';
import { initTestOrm, resetDatabase } from '../integration/support/orm';

const RESERVATION_COUNT = 5;
const PAGE_SIZE = 2;

/**
 * Both listing endpoints, through real HTTP (docs/PLAN.md 2.7's second half).
 * Programs are seeded directly (`seedProgram`) rather than through
 * `POST /programs`, to keep this file's setup independent of that endpoint.
 */
describe('pagination', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let token: string;

  beforeAll(async () => {
    app = await createE2eApp();
    orm = await initTestOrm();
    token = await mintToken(app, {
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

  async function reserve(programId: string, invoiceId: string): Promise<void> {
    const response = await request(httpServer(app))
      .post(`/api/v1/programs/${programId}/reservations`)
      .set('Authorization', `Bearer ${token}`)
      .send({ invoiceId, amount: '10.00', currency: 'USD' });

    expect(response.status).toBe(201);
  }

  it('paginates GET /:id/reservations to the end with no gaps or duplicates', async () => {
    const programId = 'prog-page-reservations';

    await seedProgram(orm, aProgram({ id: programId, ownerOrgId: 'org-a' }));

    for (let i = 0; i < RESERVATION_COUNT; i += 1) {
      await reserve(programId, `inv-${i}`);
    }

    const seenInvoiceIds: string[] = [];
    let cursor: string | null = null;

    do {
      const response = await request(httpServer(app))
        .get(`/api/v1/programs/${programId}/reservations`)
        .query({ limit: PAGE_SIZE, ...(cursor ? { after: cursor } : {}) })
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);

      const body = response.body as {
        reservations: { invoiceId: string }[];
        nextCursor: string | null;
      };

      seenInvoiceIds.push(...body.reservations.map((r) => r.invoiceId));
      cursor = body.nextCursor;
    } while (cursor !== null);

    expect(seenInvoiceIds).toHaveLength(RESERVATION_COUNT);
    expect(new Set(seenInvoiceIds).size).toBe(RESERVATION_COUNT);
  });

  it('paginates GET /:id/events to the end, with every id a decimal string', async () => {
    const programId = 'prog-page-events';

    await seedProgram(orm, aProgram({ id: programId, ownerOrgId: 'org-a' }));

    for (let i = 0; i < RESERVATION_COUNT; i += 1) {
      await reserve(programId, `inv-${i}`);
    }

    const seenIds: string[] = [];
    let cursor: string | null = null;

    do {
      const response = await request(httpServer(app))
        .get(`/api/v1/programs/${programId}/events`)
        .query({ limit: PAGE_SIZE, ...(cursor ? { after: cursor } : {}) })
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);

      const body = response.body as {
        events: { id: unknown }[];
        nextCursor: string | null;
      };

      for (const event of body.events) {
        expect(typeof event.id).toBe('string');
      }

      seenIds.push(...body.events.map((event) => event.id as string));
      cursor = body.nextCursor;
    } while (cursor !== null);

    expect(seenIds).toHaveLength(RESERVATION_COUNT);
    expect(new Set(seenIds).size).toBe(RESERVATION_COUNT);
  });
});

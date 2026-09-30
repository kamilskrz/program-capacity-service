import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { httpServer } from './bootstrap';

export interface TokenClaims {
  readonly sub: string;
  readonly org: string;
  readonly scope: string;
}

/** Mints a real, signed token through the dev-only `POST /auth/token` (docs/PLAN.md 2.7) — never a hand-rolled JWT. */
export async function mintToken(
  app: INestApplication,
  claims: TokenClaims,
): Promise<string> {
  const response = await request(httpServer(app))
    .post('/api/v1/auth/token')
    .send(claims)
    .expect(201);

  return (response.body as { accessToken: string }).accessToken;
}

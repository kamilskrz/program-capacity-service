import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';

/** The one shape this middleware needs of a request, so no express types are pulled in. */
export interface RequestWithId {
  readonly headers: Record<string, string | string[] | undefined>;
  id?: string;
}

/**
 * `traceId`'s source: reuses `x-request-id` if the caller sent one, else mints
 * a uuid.
 *
 * Leaves an id that is already there alone. `pino-http` assigns its own
 * `req.id` before this middleware runs, and overwriting it put two different
 * identifiers on one request — pino's in `req.id`, this one in
 * `correlationId` — which is worse than either alone.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: RequestWithId, _res: unknown, next: () => void): void {
    if (req.id === undefined || req.id === '') {
      const header = req.headers['x-request-id'];

      req.id =
        typeof header === 'string' && header.length > 0 ? header : randomUUID();
    }

    next();
  }
}

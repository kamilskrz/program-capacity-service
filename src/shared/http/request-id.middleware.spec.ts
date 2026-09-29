import {
  RequestIdMiddleware,
  type RequestWithId,
} from './request-id.middleware';

describe('RequestIdMiddleware', () => {
  const middleware = new RequestIdMiddleware();

  it('reuses x-request-id when the caller sent one', () => {
    const request: RequestWithId = {
      headers: { 'x-request-id': 'caller-supplied-id' },
    };
    const next = jest.fn();

    middleware.use(request, {}, next);

    expect(request.id).toBe('caller-supplied-id');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('generates a uuid when no x-request-id header is present', () => {
    const request: RequestWithId = { headers: {} };

    middleware.use(request, {}, jest.fn());

    expect(request.id).toEqual(
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    );
  });

  it('generates a different id on each call', () => {
    const first: RequestWithId = { headers: {} };
    const second: RequestWithId = { headers: {} };

    middleware.use(first, {}, jest.fn());
    middleware.use(second, {}, jest.fn());

    expect(first.id).not.toBe(second.id);
  });
});

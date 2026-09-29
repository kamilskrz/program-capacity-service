import {
  type ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { type Reflector } from '@nestjs/core';
import { type JwtService } from '@nestjs/jwt';

import { JwtAuthGuard } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from './public.decorator';
import { SCOPES_KEY } from './scopes.decorator';
import { type AppConfigService } from '../shared/config/app-config.service';

// The guard never reads config directly in these cases; a bare cast stands in for it.
const fakeConfig = {} as AppConfigService;

function createReflector(metadata: {
  isPublic?: boolean;
  scopes?: string[];
}): Reflector {
  return {
    getAllAndOverride: (key: string) => {
      if (key === IS_PUBLIC_KEY) return metadata.isPublic;
      if (key === SCOPES_KEY) return metadata.scopes;

      return undefined;
    },
  } as unknown as Reflector;
}

function createContext(request: Record<string, unknown>): ExecutionContext {
  function routeHandler(): void {}
  class RouteController {}

  return {
    getHandler: () => routeHandler,
    getClass: () => RouteController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function createJwtService(verifyAsync: jest.Mock): JwtService {
  return { verifyAsync } as unknown as JwtService;
}

describe('JwtAuthGuard', () => {
  it('lets a @Public() route through without touching JwtService', async () => {
    const verifyAsync = jest.fn();
    const guard = new JwtAuthGuard(
      createJwtService(verifyAsync),
      fakeConfig,
      createReflector({ isPublic: true }),
    );

    await expect(
      guard.canActivate(createContext({ headers: {} })),
    ).resolves.toBe(true);
    expect(verifyAsync).not.toHaveBeenCalled();
  });

  it('refuses a request with no Authorization header', async () => {
    const guard = new JwtAuthGuard(
      createJwtService(jest.fn()),
      fakeConfig,
      createReflector({}),
    );

    await expect(
      guard.canActivate(createContext({ headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a header that is not "Bearer <token>"', async () => {
    const guard = new JwtAuthGuard(
      createJwtService(jest.fn()),
      fakeConfig,
      createReflector({}),
    );
    const context = createContext({
      headers: { authorization: 'Basic abc123' },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses a token JwtService cannot verify', async () => {
    const verifyAsync = jest
      .fn()
      .mockRejectedValue(new Error('invalid signature'));
    const guard = new JwtAuthGuard(
      createJwtService(verifyAsync),
      fakeConfig,
      createReflector({}),
    );
    const context = createContext({
      headers: { authorization: 'Bearer bad-token' },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('attaches the verified payload to request.user and passes when no scope is required', async () => {
    const payload = {
      sub: 'user-1',
      org: 'org-northwind',
      scope: 'capacity:write',
    };
    const verifyAsync = jest.fn().mockResolvedValue(payload);
    const guard = new JwtAuthGuard(
      createJwtService(verifyAsync),
      fakeConfig,
      createReflector({}),
    );
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer good-token' },
    };

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toEqual(payload);
  });

  it('passes when the payload carries the one required scope', async () => {
    const payload = {
      sub: 'user-1',
      org: 'org-northwind',
      scope: 'capacity:read capacity:write',
    };
    const verifyAsync = jest.fn().mockResolvedValue(payload);
    const guard = new JwtAuthGuard(
      createJwtService(verifyAsync),
      fakeConfig,
      createReflector({ scopes: ['capacity:write'] }),
    );
    const context = createContext({
      headers: { authorization: 'Bearer good-token' },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('refuses with ForbiddenException when the required scope is missing', async () => {
    const payload = {
      sub: 'user-1',
      org: 'org-northwind',
      scope: 'capacity:read',
    };
    const verifyAsync = jest.fn().mockResolvedValue(payload);
    const guard = new JwtAuthGuard(
      createJwtService(verifyAsync),
      fakeConfig,
      createReflector({ scopes: ['capacity:write'] }),
    );
    const context = createContext({
      headers: { authorization: 'Bearer good-token' },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses with ForbiddenException when only some of several required scopes are present', async () => {
    const payload = {
      sub: 'user-1',
      org: 'org-northwind',
      scope: 'capacity:write',
    };
    const verifyAsync = jest.fn().mockResolvedValue(payload);
    const guard = new JwtAuthGuard(
      createJwtService(verifyAsync),
      fakeConfig,
      createReflector({ scopes: ['capacity:write', 'programs:admin'] }),
    );
    const context = createContext({
      headers: { authorization: 'Bearer good-token' },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

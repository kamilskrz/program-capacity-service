import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { JWT_AUDIENCE, JWT_ISSUER, type AuthenticatedUser } from './claims';
import { IS_PUBLIC_KEY } from './public.decorator';
import { SCOPES_KEY } from './scopes.decorator';
import { AppConfigService } from '../shared/config/app-config.service';

interface RequestWithAuth {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
}

/**
 * Global (`APP_GUARD`): `@Public()` bypasses it entirely; otherwise it
 * verifies `Authorization: Bearer <token>` and checks `@Scopes(...)` against
 * the payload's `scope` claim (docs/PLAN.md 2.7).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: AppConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const token = this.extractToken(request);
    const payload = await this.verify(token);

    request.user = payload;

    const requiredScopes = this.reflector.getAllAndOverride<string[]>(
      SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredScopes && requiredScopes.length > 0) {
      const grantedScopes = new Set(payload.scope.split(/\s+/).filter(Boolean));

      if (!requiredScopes.every((scope) => grantedScopes.has(scope))) {
        throw new ForbiddenException('Missing required scope.');
      }
    }

    return true;
  }

  private extractToken(request: RequestWithAuth): string {
    const header = request.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    const [scheme, token] = (value ?? '').split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Missing or malformed bearer token.');
    }

    return token;
  }

  private async verify(token: string): Promise<AuthenticatedUser> {
    try {
      return await this.jwtService.verifyAsync<AuthenticatedUser>(token, {
        secret: this.config.jwtSecret,
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token.');
    }
  }
}

import { SetMetadata } from '@nestjs/common';

export const SCOPES_KEY = 'scopes';

/** Required scopes, checked by `JwtAuthGuard` against the token's `scope` claim. */
export const Scopes = (...scopes: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(SCOPES_KEY, scopes);

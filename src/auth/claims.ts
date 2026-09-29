/** The verified payload `JwtAuthGuard` attaches to `request.user` (docs/PLAN.md 2.7). */
export interface AuthenticatedUser {
  readonly sub: string;
  readonly org: string;
  /** Space-separated, OAuth2-style. */
  readonly scope: string;
}

/** Fixed, not configurable: one service, no federation. */
export const JWT_ISSUER = 'program-capacity';
export const JWT_AUDIENCE = 'program-capacity-api';

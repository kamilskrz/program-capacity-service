/** RFC 7807 response body every error response carries (docs/PLAN.md 2.7). */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly traceId: string;
}

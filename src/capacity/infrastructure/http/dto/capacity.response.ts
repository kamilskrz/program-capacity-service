/** `GET /programs/:id/capacity` (docs/PLAN.md 2.7). Amounts are decimal strings, never minor units. */
export interface CapacityResponse {
  readonly limit: string;
  readonly reserved: string;
  readonly available: string;
  readonly currency: string;
  /** ISO string; `null` if the program has never been reconciled. */
  readonly lastReconciledAt: string | null;
  readonly overUtilized: boolean;
}

import { type CurrencyCode } from '../../../capacity/domain/currency';
import { type StoredDiscrepancy } from '../../infrastructure/persistence/discrepancy.mapping';
import {
  type Discrepancy,
  type DiscrepancyReason,
} from '../../domain/reconcile-program';

/**
 * What one upsert writes. Extends {@link Discrepancy} with the program it
 * belongs to, the currency both amounts are stated in (not carried on
 * {@link Discrepancy} itself — `held`/`reported` may be present, absent, or
 * only one of the two, so there is no single amount to always read it off),
 * and the instant this upsert is happening at (`plan.reconciledAt`):
 * `firstSeen` is seeded from it on an insert and left alone by a refresh;
 * `lastSeen` always moves to it; `resolvedAt` is always cleared, so a
 * discrepancy that reappears after being resolved reopens rather than
 * staying resolved.
 */
export interface UpsertDiscrepancyInput extends Discrepancy {
  readonly programId: string;
  readonly currency: CurrencyCode;
  readonly seenAt: Date;
}

/**
 * `treasury-sync`'s own repository port, over the `discrepancyFromRow`/
 * `discrepancySchema` cycle 4 already built (docs/PLAN.md 2.2). `capacity`
 * never depends on this — the dependency direction §3 draws is one way.
 *
 * `upsert`/`resolve` return `Promise<void>` rather than staying synchronous
 * like the capacity repositories' `add`: those stage a row for the caller's
 * later `flush`, but an upsert's whole point is to issue one
 * `insert … on conflict do update` immediately (the key decides insert vs
 * refresh), and a nativeUpdate for `resolve` is the same shape — both are
 * still inside the caller's transaction, just not deferred to its flush.
 */
export interface DiscrepancyRepository {
  /** Every currently-unresolved discrepancy of one program. */
  findOpenByProgram(programId: string): Promise<readonly StoredDiscrepancy[]>;

  /** Inserts a new row, or refreshes an existing one, keyed by `(programId, invoiceId, reason)`. */
  upsert(discrepancy: UpsertDiscrepancyInput): Promise<void>;

  /** Marks one discrepancy resolved; a no-op if no such row is open. */
  resolve(
    programId: string,
    invoiceId: string,
    reason: DiscrepancyReason,
    resolvedAt: Date,
  ): Promise<void>;
}

/** Injection token for {@link DiscrepancyRepository}. */
export const DISCREPANCY_REPOSITORY = Symbol('DiscrepancyRepository');

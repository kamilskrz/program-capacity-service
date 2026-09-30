import {
  type DiscrepancyRepository,
  type UpsertDiscrepancyInput,
} from '../ports/discrepancy.repository';
import { type DiscrepancyReason } from '../../domain/reconcile-program';
import { type StoredDiscrepancy } from '../../infrastructure/persistence/discrepancy.mapping';

function rowKey(
  programId: string,
  invoiceId: string,
  reason: DiscrepancyReason,
): string {
  return `${programId}\u0000${invoiceId}\u0000${reason}`;
}

/**
 * Single-threaded, like `InMemoryCapacityRepositories`'s fakes: `upsert` and
 * `resolve` write straight through rather than staging for a later flush,
 * mirroring `MikroOrmDiscrepancyRepository`'s own one-statement writes (there
 * is no flush to stage them against).
 */
export class InMemoryDiscrepancyRepository implements DiscrepancyRepository {
  private readonly rows = new Map<string, StoredDiscrepancy>();

  /** For arranging a test's "already open before this snapshot" state directly. */
  seed(row: StoredDiscrepancy): void {
    this.rows.set(rowKey(row.programId, row.invoiceId, row.reason), row);
  }

  findOpenByProgram(programId: string): Promise<readonly StoredDiscrepancy[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (row) => row.programId === programId && row.resolvedAt === null,
      ),
    );
  }

  upsert(discrepancy: UpsertDiscrepancyInput): Promise<void> {
    const key = rowKey(
      discrepancy.programId,
      discrepancy.invoiceId,
      discrepancy.reason,
    );
    const existing = this.rows.get(key);

    this.rows.set(key, {
      programId: discrepancy.programId,
      invoiceId: discrepancy.invoiceId,
      reason: discrepancy.reason,
      detail: discrepancy.detail,
      held: discrepancy.held,
      localStatus: discrepancy.localStatus,
      reported: discrepancy.reported,
      reportedStatus: discrepancy.reportedStatus,
      // Seeded on insert, left alone on a refresh.
      firstSeen: existing?.firstSeen ?? discrepancy.seenAt,
      lastSeen: discrepancy.seenAt,
      resolvedAt: null,
    });

    return Promise.resolve();
  }

  resolve(
    programId: string,
    invoiceId: string,
    reason: DiscrepancyReason,
    resolvedAt: Date,
  ): Promise<void> {
    const key = rowKey(programId, invoiceId, reason);
    const existing = this.rows.get(key);

    if (existing !== undefined) {
      this.rows.set(key, { ...existing, resolvedAt });
    }

    return Promise.resolve();
  }

  /** Everything ever written, resolved or not — for asserting on the full history in a test. */
  all(): readonly StoredDiscrepancy[] {
    return [...this.rows.values()];
  }
}

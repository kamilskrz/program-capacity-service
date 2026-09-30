import { type EntityManager } from '@mikro-orm/postgresql';

import {
  discrepancyFromRow,
  discrepancySchema,
  type StoredDiscrepancy,
} from './discrepancy.mapping';
import {
  type DiscrepancyRepository,
  type UpsertDiscrepancyInput,
} from '../../application/ports/discrepancy.repository';
import { type DiscrepancyReason } from '../../domain/reconcile-program';

/**
 * `DiscrepancyRepository` over MikroORM, bound to one `EntityManager` like
 * the capacity repositories it sits alongside. `upsert` is one statement, not
 * a load-then-mutate: the `(program_id, invoice_id, reason)` key already
 * decides insert vs refresh, so `firstSeen` is written on every call but
 * excluded from the merge — an insert seeds it, a refresh leaves the
 * database's value alone.
 */
export class MikroOrmDiscrepancyRepository implements DiscrepancyRepository {
  constructor(private readonly em: EntityManager) {}

  async findOpenByProgram(
    programId: string,
  ): Promise<readonly StoredDiscrepancy[]> {
    const rows = await this.em.find(discrepancySchema, {
      programId,
      resolvedAt: null,
    });

    return rows.map(discrepancyFromRow);
  }

  async upsert(discrepancy: UpsertDiscrepancyInput): Promise<void> {
    await this.em.upsert(
      discrepancySchema,
      {
        programId: discrepancy.programId,
        invoiceId: discrepancy.invoiceId,
        reason: discrepancy.reason,
        detail: discrepancy.detail,
        heldAmount: discrepancy.held,
        reportedAmount: discrepancy.reported,
        currency: discrepancy.currency,
        localStatus: discrepancy.localStatus,
        reportedStatus: discrepancy.reportedStatus,
        firstSeen: discrepancy.seenAt,
        lastSeen: discrepancy.seenAt,
        resolvedAt: null,
      },
      {
        onConflictFields: ['programId', 'invoiceId', 'reason'],
        onConflictAction: 'merge',
        // `firstSeen` is the one column a refresh must never move.
        onConflictExcludeFields: ['firstSeen'],
      },
    );
  }

  async resolve(
    programId: string,
    invoiceId: string,
    reason: DiscrepancyReason,
    resolvedAt: Date,
  ): Promise<void> {
    await this.em.nativeUpdate(
      discrepancySchema,
      { programId, invoiceId, reason },
      { resolvedAt },
    );
  }
}

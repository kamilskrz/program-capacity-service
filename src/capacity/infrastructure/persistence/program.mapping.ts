import { BigIntType, EntitySchema, type EntityClass } from '@mikro-orm/core';

import { moneyAmount } from './money-amount.type';
import { type CurrencyCode } from '../../domain/currency';
import { type Money } from '../../domain/money';
import { Program } from '../../domain/program';

/**
 * The shape of one `programs` row, as MikroORM sees the aggregate.
 * `_creditLimit`/`_reserved` are the aggregate's TypeScript-`private` fields
 * (named here because a `private` member is an ordinary own property at
 * runtime — docs/PLAN.md 2.6). `lastSnapshotSequence`/`lastReconciledAt` are
 * the reconciliation watermark: columns the row has and the aggregate does not.
 */
export interface StoredProgram {
  id: string;
  ownerOrgId: string;
  currency: CurrencyCode;
  _creditLimit: Money;
  _reserved: Money;
  /** `null` if never reconciled — distinct from "reconciled at sequence zero". */
  lastSnapshotSequence: bigint | null;
  /** The `asOf` of the snapshot that {@link lastSnapshotSequence} names. */
  lastReconciledAt: Date | null;
}

/**
 * `programs`. No `CHECK (credit_limit >= reserved_amount)` and no `available
 * >= 0`: reconciliation can legitimately push availability negative
 * (docs/PLAN.md 2.4), and a constraint here would fail the very transaction
 * that is trying to record that.
 */
export const programSchema = new EntitySchema<StoredProgram>({
  // The cast is the price of mapping an aggregate whose state is `private`:
  // `keyof Program` cannot see `_creditLimit`.
  class: Program as unknown as EntityClass<StoredProgram>,
  tableName: 'programs',
  forceConstructor: false,
  properties: {
    id: { type: 'string', length: 64, primary: true, fieldName: 'id' },
    ownerOrgId: { type: 'string', length: 64, fieldName: 'owner_org_id' },
    currency: { type: 'string', length: 3, fieldName: 'currency' },
    _creditLimit: { type: moneyAmount, fieldName: 'credit_limit' },
    _reserved: { type: moneyAmount, fieldName: 'reserved_amount' },
    lastSnapshotSequence: {
      // `bigint` mode: the column holds a producer's 64-bit counter exactly,
      // which staleness is decided against (docs/PLAN.md 2.1).
      type: new BigIntType('bigint'),
      nullable: true,
      fieldName: 'last_snapshot_sequence',
    },
    lastReconciledAt: {
      type: 'datetime',
      nullable: true,
      fieldName: 'last_reconciled_at',
    },
  },
  indexes: [
    { name: 'programs_owner_org_id_index', properties: ['ownerOrgId'] },
  ],
  checks: [
    {
      name: 'programs_reserved_amount_non_negative',
      expression: 'reserved_amount >= 0',
    },
    {
      name: 'programs_credit_limit_non_negative',
      expression: 'credit_limit >= 0',
    },
  ],
});

/** The same object, seen as the aggregate — a change of view, not a conversion. */
export function asProgram(stored: StoredProgram): Program {
  return stored as unknown as Program;
}

/** The inverse view of {@link asProgram}. */
export function asStoredProgram(program: Program): StoredProgram {
  return program as unknown as StoredProgram;
}

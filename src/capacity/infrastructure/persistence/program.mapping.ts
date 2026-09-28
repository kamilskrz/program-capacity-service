import { BigIntType, EntitySchema, type EntityClass } from '@mikro-orm/core';

import { moneyAmount } from './money-amount.type';
import { type CurrencyCode } from '../../domain/currency';
import { type Money } from '../../domain/money';
import { Program } from '../../domain/program';

/**
 * The shape of one `programs` row, as MikroORM sees the aggregate.
 *
 * Three groups of fields, and the difference matters:
 *
 * 1. `id`, `ownerOrgId`, `currency` — public, readonly fields of `Program`.
 * 2. `_creditLimit`, `_reserved` — the aggregate's TypeScript-`private` fields.
 *    They are named here because that is the only way to map them: a `private`
 *    member is a compile-time restriction and a perfectly ordinary own property
 *    at runtime, which is exactly why docs/PLAN.md 2.6 requires `private` rather
 *    than `#private` for tracked aggregates. Reaching into them from this file is
 *    deliberate and contained: the mapping is the one place allowed to know how
 *    the aggregate stores its state, and the type below makes the coupling
 *    visible instead of hiding it behind `any`.
 * 3. `lastSnapshotSequence`, `lastReconciledAt` — columns the **row** has and the
 *    aggregate does not. Cycle 3's reconciliation takes `appliedSequence` as an
 *    argument precisely because `Program` has no such field (see
 *    `ReconciliationInput.appliedSequence`, which asks this cycle for the two
 *    columns), and docs/PLAN.md 2.7 puts `lastReconciledAt` in the capacity
 *    response. They are the watermark, they belong to the row, and adding them to
 *    the aggregate would mean changing committed domain code for something the
 *    domain never decides with.
 *
 * Nothing derived is stored: `available` and `overUtilized` are `creditLimit −
 * reserved` and its sign, and a column for either would be a second answer to a
 * question that already has one (docs/PLAN.md 2.8 keeps availability a
 * primary-key read, not a cached figure).
 */
export interface StoredProgram {
  id: string;
  ownerOrgId: string;
  currency: CurrencyCode;
  _creditLimit: Money;
  _reserved: Money;
  /**
   * The highest treasury `sequence` applied to this program, or `null` if it has
   * never been reconciled — a distinct statement from "reconciled at sequence
   * zero", which is why the column is nullable rather than defaulted to 0.
   */
  lastSnapshotSequence: bigint | null;
  /** The `asOf` of the snapshot that {@link lastSnapshotSequence} names. */
  lastReconciledAt: Date | null;
}

/**
 * `programs`.
 *
 * ## The row, column by column
 *
 * | column | type | why |
 * |---|---|---|
 * | `id` | `varchar(64)` | client-supplied, a closed set (docs/PLAN.md 2.9) |
 * | `owner_org_id` | `varchar(64)` | the `org` claim tenancy is checked against |
 * | `currency` | `varchar(3)` | **once per row**: one program, one currency |
 * | `credit_limit` | `bigint` | minor units; see {@link MoneyAmountType} |
 * | `reserved_amount` | `bigint` | the denormalized counter of docs/PLAN.md 2.4 |
 * | `last_snapshot_sequence` | `bigint null` | the reconciliation watermark |
 * | `last_reconciled_at` | `timestamptz null` | the `asOf` it was taken from |
 *
 * ## The constraints, and the one that is deliberately absent
 *
 * - `CHECK (reserved_amount >= 0)` — required by docs/PLAN.md 2.4 and mirrored by
 *   `Program.rehydrate`. The counter is a sum of holds; a negative sum is
 *   corruption, not a business state.
 * - `CHECK (credit_limit >= 0)` — `assertCreditLimit` refuses a negative limit on
 *   every path into the aggregate, including a treasury snapshot, so a negative
 *   limit in the column could only come from outside this service's code.
 * - **No `CHECK (credit_limit >= reserved_amount)`, and no `available >= 0` in any
 *   spelling.** Reconciliation may legitimately push availability negative — a
 *   reduced limit, an upward correction — and the program then has to store, load,
 *   report and release (docs/PLAN.md 2.1, 2.4). A constraint here would turn the
 *   one state this service is required to survive into a failed transaction, and
 *   it would fail it in the middle of the reconciliation that was trying to record
 *   the truth.
 *
 ## What the DDL cannot say
 *
 * That a hold's `held_currency` is its program's `currency` would be a composite
 * foreign key on `(program_id, held_currency)` referencing `(id, currency)` — a
 * unique index away, and rejected. MikroORM derives foreign keys from relations
 * and has no way to express a composite reference alongside two separately mapped
 * scalar columns, so the constraint would exist in the migration and nowhere in
 * the metadata: `getUpdateSchemaSQL()` then reports it as drift on every run and
 * the schema test that catches a real mapping mistake has to be taught to ignore
 * it. A drift test with exceptions is a drift test nobody trusts. The agreement is
 * enforced where the domain already enforces it — `Program.assertProgramCurrency`
 * on every operation, and `reconcileProgram` refusing a hold in another currency
 * outright — and the gap is reported rather than papered over.
 *
 * ## `forceConstructor` is off — see `DomainHydrator`
 *
 * Set explicitly rather than left to the default, because docs/PLAN.md 2.6 asks
 * this cycle to decide it: turning it on would call `Program`'s constructor,
 * which is a bare assignment list. Every invariant lives in `create` and
 * `rehydrate`, so the flag would buy a constructor call and no validation at all,
 * while costing the ORM's ability to hydrate an entity whose constructor
 * parameters it cannot name. The hydrator calls `Program.rehydrate` instead,
 * which is the factory that actually refuses a corrupt row.
 */
export const programSchema = new EntitySchema<StoredProgram>({
  // The cast is the price of mapping an aggregate whose state is `private`:
  // `keyof Program` cannot see `_creditLimit`, so the schema is typed over
  // {@link StoredProgram} and the runtime class is attached here. It is the same
  // object either way — see {@link asProgram}.
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
      // `bigint` mode, not `number` mode. The column is `bigint` so a producer's
      // 64-bit counter fits it, and this is the figure staleness is decided
      // against — read through `number` it would stop being exact at 2^53, and a
      // sequence read back one short of what was written makes the snapshot that
      // wrote it look newer than itself, after which every snapshot at that
      // sequence is judged stale and the program stops reconciling silently. The
      // domain models a snapshot's `sequence` as a `number` because that is what a
      // JSON message carries; the widening happens at the comparison, which
      // `ReconciliationWatermark` documents.
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

/**
 * The same object, seen as the aggregate.
 *
 * MikroORM hands back a `StoredProgram` because that is what the schema is typed
 * over; the instance is a real `Program` with a real prototype, so this is a
 * change of view and not a conversion. Kept as a named function so the cast
 * appears once, here, instead of in every repository method.
 */
export function asProgram(stored: StoredProgram): Program {
  return stored as unknown as Program;
}

/** The inverse view of {@link asProgram}. */
export function asStoredProgram(program: Program): StoredProgram {
  return program as unknown as StoredProgram;
}

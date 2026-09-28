import {
  ObjectHydrator,
  type EntityData,
  type EntityFactory,
  type EntityMetadata,
} from '@mikro-orm/core';

import { moneyAmount, moneyFromColumns } from './money-amount.type';
import { type StoredProgram } from './program.mapping';
import {
  fxRateFromColumns,
  type StoredReservation,
} from './reservation.mapping';
import { DomainError } from '../../domain/errors';
import { type Money } from '../../domain/money';
import { Program } from '../../domain/program';
import { Reservation } from '../../domain/reservation';
import { type FxRate } from '../../../fx/fx-rate';

/**
 * The aggregates this hydrator assembles, by the class name their schema is
 * registered under. Everything else is mapped as a row and converted by its own
 * function.
 */
const PROGRAM = 'Program';
const RESERVATION = 'Reservation';

/** The amount properties of a `programs` row: what makes assembly *necessary*. */
const PROGRAM_AMOUNTS = ['_creditLimit', '_reserved'] as const;

/**
 * What a `programs` projection must carry beside an amount, over and above the
 * primary key MikroORM adds to every explicit field list of its own accord.
 */
const PROGRAM_COLUMNS = ['ownerOrgId', 'currency', ...PROGRAM_AMOUNTS] as const;

/** The amount properties of a `reservations` row. */
const RESERVATION_AMOUNTS = [
  'originalAmount',
  '_reservedAmount',
  '_releasedAmount',
] as const;

/**
 * What a `reservations` projection must carry beside an amount. The six `fx_*`
 * columns and the lifecycle pair are listed because a read cannot tell "null in
 * the row" from "left out of the select".
 */
const RESERVATION_COLUMNS = [
  '_status',
  'originalCurrency',
  'heldCurrency',
  '_reservedAt',
  '_releasedAt',
  '_releaseReason',
  'fxBase',
  'fxQuote',
  'fxScaledValue',
  'fxScale',
  'fxSource',
  'fxAsOf',
  ...RESERVATION_AMOUNTS,
] as const;

/**
 * The aggregate's own FX field, which is **not** a mapped column — the six
 * `fx_*` columns are (see `reservation.mapping.ts`). MikroORM neither tracks nor
 * writes it, so assembly is what makes `reservation.fxRate` answer.
 */
interface ReservationFxField {
  _fxRate: FxRate | null;
}

/**
 * A projection that asked for an aggregate's amounts but not for the columns that
 * make them sound. The message names the omitted columns, so it points at the
 * projection to widen rather than at the row to investigate.
 */
export class IncompleteProjectionError extends DomainError {
  readonly code = 'INCOMPLETE_PROJECTION';

  constructor(entity: string, columns: readonly string[]) {
    super(
      `a partial select of ${entity} asked for its amounts but left out ${columns.join(', ')}: those are the columns that decide whether the amounts it did select are sound, so there is nothing to validate the row against and nothing honest to hand back. Widen the projection, or select no amount at all.`,
    );
  }
}

/** What a column is called in the database, for a message a reader can act on. */
function columnOf<T extends object>(
  meta: EntityMetadata<T>,
  property: string,
): string {
  // `meta.properties` is keyed by `EntityKey<T>`, which a plain `string` cannot
  // index; the list of properties is this file's own, so the lookup is total in
  // practice and the fallback is the property name itself.
  const properties = meta.properties as unknown as Record<
    string,
    { fieldNames?: string[] } | undefined
  >;

  return properties[property]?.fieldNames?.[0] ?? property;
}

/**
 * Whether a **freshly hydrated entity** carries enough to assemble — asked of the
 * entity and never of the incoming `data`, which on a second read of the same row
 * is only the diff (docs/PLAN.md 2.6).
 *
 * @throws {IncompleteProjectionError} if some amount is present and something the
 * assembly reads is not.
 */
function assemblyOf<T extends object>(
  entity: T,
  meta: EntityMetadata<T>,
  amounts: readonly string[],
  columns: readonly string[],
): 'assemble' | 'nothing to assemble' {
  const values = entity as Record<string, unknown>;

  // Not one amount in hand: a watermark read, or any projection that asked for no
  // figure at all. Nothing to pair, so nothing to refuse either.
  if (amounts.every((property) => values[property] === undefined)) {
    return 'nothing to assemble';
  }

  const missing = columns.filter((property) => values[property] === undefined);

  if (missing.length > 0) {
    throw new IncompleteProjectionError(
      meta.className,
      missing.map((property) => columnOf(meta, property)),
    );
  }

  return 'assemble';
}

/**
 * Pairs one stored amount with the currency its row states, whatever shape the
 * amount is currently wearing — the `bigint` of a first read, or the `Money` an
 * earlier assembly left for every amount a later diff did not touch.
 *
 * @throws {UnknownCurrencyError} if `currency` is not a code this build supports.
 * @throws {TypeError} if the value is not one a bigint amount column can hold.
 */
function amountFromState(value: unknown, currency: string): Money {
  return moneyFromColumns(moneyAmount.convertToJSValue(value), currency);
}

/**
 * Turns the columns MikroORM hydrated into the value objects the domain works
 * with, and refuses a row the domain would not have produced.
 *
 * Each amount is paired with the currency its row states, the FX evidence is
 * rebuilt, and the result goes through the domain's own `rehydrate` factory purely
 * as a gate: the validated instance is discarded and the tracked entity kept, so
 * hydration has no side effects (docs/PLAN.md 2.6).
 */
export class DomainHydrator extends ObjectHydrator {
  /**
   * Hydrates as MikroORM normally would, then assembles and validates the
   * aggregates this service maps.
   *
   * Dispatch is on `meta.className`, so entities with no value objects
   * (`CapacityEvent`, `FxRate`, `Discrepancy`) pass straight through.
   *
   * @throws {IncompleteProjectionError} if a partial select asked for an aggregate's
   * amounts but not for the columns that decide whether they are sound.
   * @throws {InvalidProgramError} if a `programs` row is one `Program.rehydrate`
   * refuses.
   * @throws {InvalidReservationError} if a `reservations` row is one
   * `Reservation.rehydrate` refuses.
   * @throws {InvalidFxRateError} if its FX evidence is not a rate this build can
   * state — a stale `scale`, most importantly.
   * @throws {UnknownCurrencyError} if a currency column holds a code this build
   * does not support.
   */
  override hydrate<T extends object>(
    entity: T,
    meta: EntityMetadata<T>,
    data: EntityData<T>,
    factory: EntityFactory,
    type: 'full' | 'reference',
    newEntity?: boolean,
    convertCustomTypes?: boolean,
    schema?: string,
    parentSchema?: string,
  ): void {
    super.hydrate(
      entity,
      meta,
      data,
      factory,
      type,
      newEntity,
      convertCustomTypes,
      schema,
      parentSchema,
    );

    // A reference carries the primary key and nothing else, so there is nothing
    // to assemble and no invariant that could be judged.
    if (type !== 'full') {
      return;
    }

    // The gate is a question about the entity's resulting state, never about
    // which keys arrived — see `assemblyOf`.
    if (meta.className === PROGRAM) {
      if (
        assemblyOf(entity, meta, PROGRAM_AMOUNTS, PROGRAM_COLUMNS) ===
        'assemble'
      ) {
        assembleProgram(entity as unknown as StoredProgram);
      }

      return;
    }

    if (meta.className === RESERVATION) {
      if (
        assemblyOf(entity, meta, RESERVATION_AMOUNTS, RESERVATION_COLUMNS) ===
        'assemble'
      ) {
        assembleReservation(entity as unknown as StoredReservation);
      }
    }
  }
}

/**
 * Replaces the raw amounts of a freshly hydrated `programs` row with `Money`, and
 * puts the row through `Program.rehydrate`.
 *
 * Exported for the mapping's own tests and for the hydrator; not for repositories,
 * which never see a half-assembled entity.
 *
 * @throws {InvalidProgramError} if the stored program is not one the domain would
 * have written.
 * @throws {UnknownCurrencyError} if `currency` is not a supported code.
 */
export function assembleProgram(stored: StoredProgram): void {
  // Both amounts are re-paired even when a read changed only one of them,
  // because the column that changed may be `currency`.
  const creditLimit = amountFromState(stored._creditLimit, stored.currency);
  const reserved = amountFromState(stored._reserved, stored.currency);

  Program.rehydrate({
    id: stored.id,
    ownerOrgId: stored.ownerOrgId,
    // The narrowed code rather than the raw column: `moneyFromColumns` has
    // already turned the `varchar` into a `CurrencyCode` or thrown.
    currency: creditLimit.currency,
    creditLimit,
    reserved,
  });

  stored._creditLimit = creditLimit;
  stored._reserved = reserved;
}

/**
 * The same for a `reservations` row: both amounts paired with `held_currency`, the
 * invoiced amount with `original_currency`, the six FX columns folded back into an
 * `FxRate` (or `null`), and the whole row put through `Reservation.rehydrate`.
 *
 * @throws {InvalidReservationError} if the stored reservation is not one the domain
 * would have written.
 * @throws {InvalidFxRateError} if the FX evidence is not a rate this build can
 * state.
 * @throws {UnknownCurrencyError} if either currency column holds an unsupported
 * code.
 */
export function assembleReservation(stored: StoredReservation): void {
  // Two currencies, and neither is redundant: the invoice states an amount in
  // its own, the hold consumes the program's, and `released_amount` is part of
  // the same held sum as `reserved_amount` (see `reservation.mapping.ts`).
  const originalAmount = amountFromState(
    stored.originalAmount,
    stored.originalCurrency,
  );
  const reservedAmount = amountFromState(
    stored._reservedAmount,
    stored.heldCurrency,
  );
  const releasedAmount = amountFromState(
    stored._releasedAmount,
    stored.heldCurrency,
  );
  const fxRate = fxRateFromColumns(stored);

  // The gate, and not the source of the values kept — see `assembleProgram`.
  Reservation.rehydrate({
    programId: stored.programId,
    invoiceId: stored.invoiceId,
    status: stored._status,
    originalAmount,
    reservedAmount,
    releasedAmount,
    fxRate,
    reservedAt: stored._reservedAt,
    releasedAt: stored._releasedAt,
    releaseReason: stored._releaseReason,
  });

  stored.originalAmount = originalAmount;
  stored._reservedAmount = reservedAmount;
  stored._releasedAmount = releasedAmount;
  (stored as unknown as ReservationFxField)._fxRate = fxRate;
}

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

const PROGRAM = 'Program';
const RESERVATION = 'Reservation';

/** Amount properties of a `programs` row. */
const PROGRAM_AMOUNTS = ['_creditLimit', '_reserved'] as const;

/** Everything else a `programs` projection must carry if it selects an amount. */
const PROGRAM_COLUMNS = ['ownerOrgId', 'currency', ...PROGRAM_AMOUNTS] as const;

/** Amount properties of a `reservations` row. */
const RESERVATION_AMOUNTS = [
  'originalAmount',
  '_reservedAmount',
  '_releasedAmount',
] as const;

/**
 * Everything else a `reservations` projection must carry if it selects an
 * amount, including the six nullable `fx_*` columns — absent and `null`
 * look alike to a partial select.
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

/** The aggregate's `fxRate`: assembled here, never a mapped column. */
interface ReservationFxField {
  _fxRate: FxRate | null;
}

/** A projection that selected an aggregate's amounts but not the columns that make them sound. */
export class IncompleteProjectionError extends DomainError {
  readonly code = 'INCOMPLETE_PROJECTION';

  constructor(entity: string, columns: readonly string[]) {
    super(
      `a partial select of ${entity} asked for its amounts but left out ${columns.join(', ')}: those are the columns that decide whether the amounts it did select are sound, so there is nothing to validate the row against and nothing honest to hand back. Widen the projection, or select no amount at all.`,
    );
  }
}

function columnOf<T extends object>(
  meta: EntityMetadata<T>,
  property: string,
): string {
  const properties = meta.properties as unknown as Record<
    string,
    { fieldNames?: string[] } | undefined
  >;

  return properties[property]?.fieldNames?.[0] ?? property;
}

/**
 * Whether a hydrated entity carries enough to assemble. Asked of the entity
 * itself, never of the incoming `data` — a second hydration of an
 * already-tracked row carries only the diff (docs/PLAN.md 2.6).
 * @throws {IncompleteProjectionError} if some amount is present and a
 * column its assembly reads is not.
 */
function assemblyOf<T extends object>(
  entity: T,
  meta: EntityMetadata<T>,
  amounts: readonly string[],
  columns: readonly string[],
): 'assemble' | 'nothing to assemble' {
  const values = entity as Record<string, unknown>;

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
 * @throws {UnknownCurrencyError} if `currency` is unsupported.
 * @throws {TypeError} if the value is not one a bigint amount column can hold.
 */
function amountFromState(value: unknown, currency: string): Money {
  return moneyFromColumns(moneyAmount.convertToJSValue(value), currency);
}

/**
 * Assembles the value objects for the aggregates this service maps, and
 * gates a stored row through the domain's own `rehydrate` (docs/PLAN.md 2.6).
 */
export class DomainHydrator extends ObjectHydrator {
  /**
   * @throws {IncompleteProjectionError} if a partial select asked for an
   * amount but not the columns that decide whether it is sound.
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

    if (type !== 'full') {
      return;
    }

    // Gated on the entity's resulting state, never on which keys arrived in `data`.
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
 * Replaces a hydrated `programs` row's raw amounts with `Money` and runs it
 * through `Program.rehydrate` as a validation gate.
 * @throws {InvalidProgramError} if the row is not one the domain would have written.
 */
export function assembleProgram(stored: StoredProgram): void {
  const creditLimit = amountFromState(stored._creditLimit, stored.currency);
  const reserved = amountFromState(stored._reserved, stored.currency);

  Program.rehydrate({
    id: stored.id,
    ownerOrgId: stored.ownerOrgId,
    currency: creditLimit.currency,
    creditLimit,
    reserved,
  });

  stored._creditLimit = creditLimit;
  stored._reserved = reserved;
}

/**
 * The same for a `reservations` row: `_reservedAmount` and
 * `_releasedAmount` share `heldCurrency`, `originalAmount` keeps its own,
 * and the six `fx_*` columns fold back into an `FxRate` (or `null`).
 * @throws {InvalidReservationError} if the row is not one the domain would have written.
 * @throws {InvalidFxRateError} if the FX evidence is not a rate this build can state.
 */
export function assembleReservation(stored: StoredReservation): void {
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

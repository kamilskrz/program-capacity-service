import {
  type EntityManager,
  type FilterQuery,
  type RequiredEntityData,
} from '@mikro-orm/postgresql';

import {
  capacityEventFromRow,
  capacityEventSchema,
  toCapacityEventRow,
  type CapacityEventRow,
} from './capacity-event.mapping';
import { moneyFromColumns } from './money-amount.type';
import {
  type CapacityEventEntry,
  type CapacityEventLog,
  type CapacityEventPage,
  type CapacityEventPageRequest,
} from '../../application/ports/capacity-event.log';
import { type CapacityEvent } from '../../domain/capacity-event';
import { type Money } from '../../domain/money';

/** One row of the `sum(delta) … group by currency` read behind `sumDeltas`. */
interface DeltaSumRow {
  readonly currency: string;
  /** `sum(bigint)` is `numeric` in Postgres; kept as `text` so nothing rounds it. */
  readonly total: string;
}

/**
 * `CapacityEventLog` over MikroORM, bound to the caller's `EntityManager` so
 * the event row joins the same unit of work — and the same flush — as the
 * program and reservation it explains.
 */
export class MikroOrmCapacityEventLog implements CapacityEventLog {
  constructor(private readonly em: EntityManager) {}

  /**
   * @throws {TypeError} if handed a `null` event.
   * @throws {CurrencyMismatchError} if the event's two amounts disagree
   * about currency.
   */
  append(event: CapacityEvent): void {
    if (event === null || event === undefined) {
      throw new TypeError(
        'CapacityEventLog.append was handed no event: the domain returns null when nothing changed, and the caller has to branch on that rather than forward it',
      );
    }

    // `em.create`, not a bare literal, so the row is assigned to this
    // context and its `bigserial` id is read back after the insert.
    this.em.persist(
      this.em.create(
        capacityEventSchema,
        toCapacityEventRow(event) as RequiredEntityData<CapacityEventRow>,
      ),
    );
  }

  /**
   * One page, oldest first, ordered by `id` and filtered with `id > after`.
   * @throws {RangeError} if `options.limit` is present and not positive.
   */
  async findByProgram(
    programId: string,
    options?: CapacityEventPageRequest,
  ): Promise<CapacityEventPage> {
    const { limit, after } = options ?? {};

    if (limit !== undefined && limit <= 0) {
      throw new RangeError(
        `CapacityEventLog.findByProgram was asked for a page of ${limit} events of program ${programId}: a non-positive limit is not a request anybody can mean, and an empty page is indistinguishable from an empty audit log. Omit the limit to read the whole log.`,
      );
    }

    const where: FilterQuery<CapacityEventRow> =
      after === undefined ? { programId } : { programId, id: { $gt: after } };

    const rows = await this.em.find(capacityEventSchema, where, {
      // By the `bigserial`, not `occurred_at`: events written in one
      // transaction can share a timestamp to the microsecond.
      orderBy: { id: 'asc' },
      // One row past the page, to answer "is there a next page?" without a count query.
      limit: limit === undefined ? undefined : limit + 1,
    });

    const hasMore = limit !== undefined && rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const entries: CapacityEventEntry[] = page.map((row) => ({
      id: BigInt(row.id),
      event: capacityEventFromRow(row),
      recordedAt: row.recordedAt,
    }));

    return {
      entries,
      nextCursor: hasMore ? (entries.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * `select sum(delta), currency … group by currency`, aggregated in the
   * database rather than summed in JavaScript over every event a program
   * has ever recorded.
   * @returns `null` for a program with no events.
   * @throws {Error} if the rows are not all in one currency.
   */
  async sumDeltas(programId: string): Promise<Money | null> {
    const result: unknown = await this.em.getConnection().execute(
      `select "currency", sum("delta")::text as total
           from "capacity_events"
          where "program_id" = ?
          group by "currency"`,
      [programId],
      'all',
      this.em.getTransactionContext(),
    );
    const rows = result as DeltaSumRow[];

    if (rows.length === 0) {
      return null;
    }

    if (rows.length > 1) {
      const currencies = rows.map((row) => row.currency).join(', ');

      throw new Error(
        `the capacity event log of program ${programId} states deltas in more than one currency (${currencies}), so their sum has no meaning`,
      );
    }

    const [row] = rows;

    // `BigInt`, never `Number`: `numeric` arrives as a string and the
    // figure is routinely past 2^53 (docs/PLAN.md 2.3).
    return moneyFromColumns(BigInt(row!.total), row!.currency);
  }
}

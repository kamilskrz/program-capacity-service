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
  /** `sum(bigint)` is `numeric` in Postgres, cast to `text` so nothing rounds it. */
  readonly total: string;
}

/**
 * `CapacityEventLog` over MikroORM.
 *
 * Bound to the caller's `EntityManager`, which is the whole mechanism behind the
 * port's atomicity promise: the event row joins the same unit of work as the program
 * and the reservation, and one flush inside one `em.transactional()` writes them
 * together or not at all.
 */
export class MikroOrmCapacityEventLog implements CapacityEventLog {
  constructor(private readonly em: EntityManager) {}

  /**
   * `em.persist(em.create(capacityEventSchema, toCapacityEventRow(event)))`.
   *
   * `em.create` rather than a bare object literal, so MikroORM assigns the row to
   * this context and the `bigserial` primary key is read back into it after the
   * insert. Nothing else in the service ever loads an event to change it, so the row
   * is written once and never tracked for updates — and the trigger installed by the
   * migration makes sure that stays true even for something that is not MikroORM.
   *
   * @throws {TypeError} if handed a `null` event — the domain's way of saying nothing
   * changed, which a caller must branch on rather than forward.
   * @throws {CurrencyMismatchError} if the event's two amounts disagree about
   * currency.
   */
  append(event: CapacityEvent): void {
    // The domain returns `null` for a no-op, which a caller branches on; a
    // silent no-op here would turn "somebody forgot" into "nothing changed".
    if (event === null || event === undefined) {
      throw new TypeError(
        'CapacityEventLog.append was handed no event: the domain returns null when nothing changed, and the caller has to branch on that rather than forward it',
      );
    }

    // `em.create` rather than a bare literal, so the row is assigned to this
    // context and the `bigserial` primary key is read back into it after the
    // insert. It joins the very unit of work that carries the program and the
    // reservation, which is the whole mechanism behind the port's atomicity
    // promise: one flush, one transaction, all three rows or none.
    this.em.persist(
      this.em.create(
        capacityEventSchema,
        // `id` and `recorded_at` are the database's to assign; the row type
        // declares both because a *read* has them, which is what this cast says.
        toCapacityEventRow(event) as RequiredEntityData<CapacityEventRow>,
      ),
    );
  }

  /**
   * One page, oldest first, ordered by `id` and filtered with `id > after`.
   *
   * Reads the row rather than the aggregate, so the cursor and `recorded_at` come
   * back with the fact (see `CapacityEventEntry`); `capacityEventFromRow` is what
   * turns each row into the domain event, pairing both amounts with the row's
   * currency.
   *
   * @throws {RangeError} if `options.limit` is present and not positive — see the
   * body for why that is refused rather than clamped.
   */
  async findByProgram(
    programId: string,
    options?: CapacityEventPageRequest,
  ): Promise<CapacityEventPage> {
    const { limit, after } = options ?? {};

    // A page of nothing is refused rather than clamped. `{ entries: [],
    // nextCursor: null }` is byte for byte the answer for a program that has never
    // recorded anything, and "there is nothing to explain why capacity moved" is a
    // sentence somebody acts on (docs/PLAN.md 2.8). Clamping to one would be worse
    // than answering: a clamped page returns an entry *and* a cursor, so a caller
    // looping on the cursor with its own limit of zero would page the whole log a
    // row at a time and never notice. An **absent** limit still means the whole log.
    if (limit !== undefined && limit <= 0) {
      throw new RangeError(
        `CapacityEventLog.findByProgram was asked for a page of ${limit} events of program ${programId}: a non-positive limit is not a request anybody can mean, and an empty page is indistinguishable from an empty audit log. Omit the limit to read the whole log.`,
      );
    }

    const where: FilterQuery<CapacityEventRow> =
      after === undefined ? { programId } : { programId, id: { $gt: after } };

    const rows = await this.em.find(capacityEventSchema, where, {
      // By the `bigserial`, not by `occurred_at`: two events written in one
      // transaction share the timestamp to the microsecond, so only the sequence
      // is a cursor that pages deterministically.
      orderBy: { id: 'asc' },
      // One row past the page, which is how "is there a next page?" is answered
      // without a second count query — and what keeps `nextCursor` null on the
      // last page rather than pointing at an empty one.
      limit: limit === undefined ? undefined : limit + 1,
    });

    const hasMore = limit !== undefined && rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const entries: CapacityEventEntry[] = page.map((row) => ({
      // `BigInt` rather than a cast: the cursor is the one identifier a caller
      // pages by, and a `bigserial` past 2^53 must not become a rounded number.
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
   * `select sum(delta), currency … group by currency` for one program.
   *
   * Aggregated in the database rather than in JavaScript: the sum is taken over every
   * event a program ever recorded, and loading them to add them up would make the
   * invariant check the slowest thing in the suite. `sum(bigint)` returns `numeric`
   * in Postgres, which `pg` hands over as a string — parsed with `BigInt`, never
   * `Number`, for the reason docs/PLAN.md 2.3 gives.
   *
   * Grouping by currency rather than assuming one: a program has exactly one
   * currency, so more than one group means the log contradicts itself, and that is
   * worth an error rather than a silently partial sum.
   *
   * @returns `null` for a program with no events.
   * @throws {Error} if the rows are not all in one currency.
   */
  async sumDeltas(programId: string): Promise<Money | null> {
    // Aggregated in the database: the sum is taken over every event a program
    // ever recorded, and loading them to add them up would make the invariant
    // check the slowest thing in the suite. Issued on the caller's transaction
    // context, so a sum taken inside a capacity change sees that change.
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

    // Grouped rather than assumed: a program has exactly one currency, so more
    // than one group means the log contradicts itself, and a silently partial sum
    // would be read as an invariant holding.
    if (rows.length > 1) {
      const currencies = rows.map((row) => row.currency).join(', ');

      throw new Error(
        `the capacity event log of program ${programId} states deltas in more than one currency (${currencies}), so their sum has no meaning`,
      );
    }

    const [row] = rows;

    // `BigInt`, never `Number`: `numeric` arrives as a string and the figure is
    // routinely past 2^53 (docs/PLAN.md 2.3).
    return moneyFromColumns(BigInt(row!.total), row!.currency);
  }
}

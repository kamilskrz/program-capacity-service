import { type MikroORM } from '@mikro-orm/postgresql';

import { expectSameMoney } from '../support/expect-domain';
import {
  BEYOND_SAFE_INTEGER,
  OCCURRED_AT,
  eur,
  jpy,
  usd,
} from '../support/factories';
import { initTestOrm, resetDatabase } from '../support/orm';
import { insertProgramRow, selectRow } from '../support/rows';
import { type CurrencyCode } from '../../../src/capacity/domain/currency';
import { Money } from '../../../src/capacity/domain/money';
import {
  discrepancyFromRow,
  discrepancySchema,
  type StoredDiscrepancy,
} from '../../../src/treasury-sync/infrastructure/persistence/discrepancy.mapping';

/**
 * A `treasury_discrepancies` row, written and read back **through its mapping**.
 *
 * # What this file covers, and what `schema.spec.ts` deliberately does not
 *
 * `schema.spec.ts` proves the upsert key works, with `insert … on conflict` in raw
 * SQL, and says why it stops there: "cycle 8 writes this table; cycle 4 only creates
 * it", so the suite exercises the key "and nothing else". That was the right scope for
 * the key. It left the mapping itself — two `moneyAmount` columns and the one
 * `currency` column they are both stated in — with no coverage at all, and raw SQL is
 * the one way of using the table that cannot notice a mapping fault. That is the gap
 * the tests below fill.
 *
 * # The convention, and the gap this table used to be in it
 *
 * A `moneyAmount` column hands back the minor units and cannot hand back the currency
 * — a MikroORM `Type` spans exactly one column — so every table that stores an amount
 * needs a named function to rejoin the two on the way out. `CapacityEventRow` has
 * `capacityEventFromRow` for `delta` and `resultingReserved`, `FxRateRow` has
 * `fxRateFromRow`, and `moneyFromColumns` is underneath both. `DomainHydrator` states
 * the same division of labour from the other side: it assembles `Program` and
 * `Reservation`, and "everything else is mapped as a row and converted by its own
 * function".
 *
 * `treasury_discrepancies` was the one table where nothing did. `DiscrepancyRow`
 * declared `heldAmount: Money | null`, so `row.heldAmount.toString()` type-checked and
 * returned `"9007199254740993"` — bare minor units — where `Money.toString()` gives
 * `"90071992547409.93 USD"`.
 *
 * Two honest fixes existed and they were not equivalent: a `Discrepancy` branch in
 * `DomainHydrator`, or a `discrepancyFromRow` beside `capacityEventFromRow`. The second
 * was taken, because a `Discrepancy` is a **row and not an aggregate** — it has no
 * invariants of its own to gate, the hydrator exists to assemble the two that do, and
 * its docblock already claimed this convention was in place here. The fix made an
 * existing statement true rather than inventing a second one.
 *
 * So `discrepancyFromRow` exists, and both amounts are now declared `Money | bigint |
 * null` rather than narrowed to the `bigint` a read produces: the write side goes
 * through the same property, and `em.create(discrepancySchema, …)` hands over a
 * `Money`. The union is honest about both arms and cannot enforce which one a reader
 * gets — `bigint` has a `toString` too — so the guarantee is held by the tests below
 * rather than by the type. That guarantee is what did not move when the fix did: both
 * amounts come back as `Money` stating the row's `currency`, exact past 2^53, and a
 * null column stays `null` rather than becoming a zero amount.
 *
 * # Why the amounts are past `Number.MAX_SAFE_INTEGER`
 *
 * Because that is where a missing pairing stops being a type complaint and becomes a
 * wrong figure. A `bigint` that reaches code expecting `Money` will be formatted,
 * added or compared by *something* eventually, and the first thing that coerces it to
 * a number loses the last digits — of a discrepancy amount, which is the figure
 * `treasury_reconciliation_discrepancies_total` alerts on and the one a human reads
 * when deciding whether this service or treasury is wrong. The two amounts are also
 * the two sides of the same disagreement, so both are asserted: a pairing that
 * remembered one column and forgot the other would report a difference that does not
 * exist.
 */
describe('a stored treasury discrepancy', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await resetDatabase(orm);
    await insertProgramRow(orm.em);
  });

  const KEY = {
    programId: 'prog-northwind',
    invoiceId: 'inv-0001',
    reason: 'UNUSABLE_AMOUNT',
  } as const;

  /** One discrepancy, written through the mapping rather than through raw SQL. */
  async function store(): Promise<void> {
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      tx.persist(
        tx.create(discrepancySchema, {
          ...KEY,
          detail:
            'treasury reports an amount this service cannot reconcile with the hold it stores',
          heldAmount: usd(BEYOND_SAFE_INTEGER),
          reportedAmount: usd(BEYOND_SAFE_INTEGER + 2n),
          currency: 'USD',
          localStatus: 'ACTIVE',
          reportedStatus: 'OUTSTANDING',
          firstSeen: OCCURRED_AT,
          lastSeen: OCCURRED_AT,
          resolvedAt: null,
        }),
      );

      await tx.flush();
    });
  }

  it('writes both amounts into their columns as minor units, exactly', async () => {
    // The premise of the test below, and a fact worth having on its own: the write
    // side of `MoneyAmountType` is what keeps a discrepancy amount a `BIGINT` rather
    // than something a driver rounded on the way in.
    await store();

    const row = await selectRow<{
      held_amount: string;
      reported_amount: string;
      currency: string;
    }>(
      orm.em,
      `select "held_amount", "reported_amount", "currency" from "treasury_discrepancies"
        where "program_id" = ? and "invoice_id" = ? and "reason" = ?`,
      [KEY.programId, KEY.invoiceId, KEY.reason],
    );

    expect(row?.held_amount).toBe('9007199254740993');
    expect(row?.reported_amount).toBe('9007199254740995');
    expect(row?.currency).toBe('USD');
  });

  it('comes back with both amounts as Money in the currency the row states', async () => {
    // D4. `MoneyAmountType` hands back the minor units and cannot hand back the
    // currency — a MikroORM `Type` spans one column — so `discrepancyFromRow` is
    // what rejoins them. Asserting `instanceof Money` rather than trusting the
    // declared type is the point: the fault this pins was a row type that *said*
    // `Money` while nothing converted one.
    await store();

    const stored = await orm.em.fork().findOne(discrepancySchema, KEY);

    expect(stored).not.toBeNull();

    const { held, reported } = discrepancyFromRow(stored!);

    expect(held).toBeInstanceOf(Money);
    expect(reported).toBeInstanceOf(Money);
    expectSameMoney(held!, usd(BEYOND_SAFE_INTEGER));
    expectSameMoney(reported!, usd(BEYOND_SAFE_INTEGER + 2n));
    // The currency both amounts are stated in is one column, and this row states
    // `USD` — which a pairing that hardcoded `'USD'` would also satisfy. The
    // non-USD tests below are what actually establishes that the column is read
    // (docs/PLAN.md 2.3).
    expect(held!.currency).toBe('USD');
    expect(reported!.currency).toBe('USD');
  });

  it('comes back with nothing where the disagreement has only one side', async () => {
    // `HELD_BUT_NOT_REPORTED` is the reason that states one amount and no other —
    // treasury reports nothing, so there is nothing to state. A pairing that turned
    // a null column into a zero `Money` would erase the difference between "treasury
    // reports nothing" and "treasury reports zero", which is precisely the
    // distinction docs/PLAN.md 2.1's governing rule turns on: absent data never
    // releases capacity.
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      tx.persist(
        tx.create(discrepancySchema, {
          programId: 'prog-northwind',
          invoiceId: 'inv-0002',
          reason: 'HELD_BUT_NOT_REPORTED',
          detail: 'held locally but never reported by treasury',
          heldAmount: usd(1_800_000n),
          reportedAmount: null,
          currency: 'USD',
          localStatus: 'ACTIVE',
          reportedStatus: null,
          firstSeen: OCCURRED_AT,
          lastSeen: OCCURRED_AT,
          resolvedAt: null,
        }),
      );

      await tx.flush();
    });

    const stored = await orm.em.fork().findOne(discrepancySchema, {
      programId: 'prog-northwind',
      invoiceId: 'inv-0002',
      reason: 'HELD_BUT_NOT_REPORTED',
    });

    const { held, reported } = discrepancyFromRow(stored!);

    expect(held).toBeInstanceOf(Money);
    expectSameMoney(held!, usd(1_800_000n));
    expect(reported).toBeNull();
  });

  /**
   * # Why a currency other than USD earns two tests of its own
   *
   * Every row the tests above write states `USD`, so all three of them would pass
   * against a `discrepancyFromRow` that ignored the column and handed back `'USD'`.
   * The claim that the pairing *reads* the currency is true of the code and was
   * unpinned by this file — these two close that gap rather than catch a defect.
   *
   * The two codes are not interchangeable. `EUR` shows the column being read at all;
   * `JPY` shows it being read for what it decides, because a currency's exponent is
   * what turns minor units into a figure a person reads (docs/PLAN.md 2.3). JPY has
   * **no** subdivision, so a pairing that assumed the two decimals of the currencies
   * it was written against renders every yen amount a hundredfold small — and a
   * discrepancy amount is exactly the figure somebody reads when deciding whether
   * this service or treasury is wrong.
   */
  describe('in the currency its program is denominated in', () => {
    /**
     * One discrepancy of a program in `currency`, written through the mapping and
     * read back through `discrepancyFromRow`.
     *
     * Both amounts are stated in the program's own currency because that is the only
     * shape reconciliation can produce — treasury's figures reach it already
     * converted and a `FOREIGN_CURRENCY` snapshot is rejected whole (docs/PLAN.md
     * 2.3) — so a row mixing currencies would be asserting a round trip of something
     * the service cannot write.
     */
    async function roundTrip(
      programId: string,
      currency: CurrencyCode,
      held: Money,
      reported: Money,
    ): Promise<StoredDiscrepancy> {
      await insertProgramRow(orm.em, { id: programId, currency });

      const key = {
        programId,
        invoiceId: 'inv-0007',
        reason: 'UNUSABLE_AMOUNT',
      } as const;

      await orm.em.fork().transactional(async (tx) => {
        tx.persist(
          tx.create(discrepancySchema, {
            ...key,
            detail:
              'treasury reports an amount this service cannot reconcile with the hold it stores',
            heldAmount: held,
            reportedAmount: reported,
            currency,
            localStatus: 'ACTIVE',
            reportedStatus: 'OUTSTANDING',
            firstSeen: OCCURRED_AT,
            lastSeen: OCCURRED_AT,
            resolvedAt: null,
          }),
        );

        await tx.flush();
      });

      const stored = await orm.em.fork().findOne(discrepancySchema, key);

      expect(stored).not.toBeNull();

      return discrepancyFromRow(stored!);
    }

    it('comes back in EUR, so the currency is read off the row and not assumed', async () => {
      const { held, reported } = await roundTrip(
        'prog-hanseatic',
        'EUR',
        eur(9_235_000n),
        eur(9_300_000n),
      );

      expect(held!.currency).toBe('EUR');
      expect(reported!.currency).toBe('EUR');
      expectSameMoney(held!, eur(9_235_000n));
      expectSameMoney(reported!, eur(9_300_000n));
    });

    it('comes back in JPY with no decimals, because the currency has none', async () => {
      const { held, reported } = await roundTrip(
        'prog-sakura',
        'JPY',
        jpy(1_234_567n),
        jpy(1_234_600n),
      );

      expect(held!.currency).toBe('JPY');
      expectSameMoney(held!, jpy(1_234_567n));
      expectSameMoney(reported!, jpy(1_234_600n));
      // Stated as the decimal string as well as through `expectSameMoney`, because
      // this is the assertion a hardcoded two-decimal currency fails: 1,234,567 yen
      // rendered as USD would read as `12345.67`, a hundredth of the disagreement.
      expect(held!.toDecimalString()).toBe('1234567');
      expect(held!.toString()).toBe('1234567 JPY');
    });
  });
});

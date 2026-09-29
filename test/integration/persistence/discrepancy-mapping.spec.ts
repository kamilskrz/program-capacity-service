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

// A `treasury_discrepancies` row, written and read back through its mapping.
// `schema.spec.ts` covers the upsert key in raw SQL only, which can't notice a
// mapping fault; `discrepancyFromRow` is what rejoins the two `moneyAmount`
// columns with the row's `currency` (a MikroORM `Type` spans one column), the
// same convention `capacityEventFromRow` and `fxRateFromRow` use. The type
// declares `Money | bigint | null`, so the guarantee that a reader always gets
// `Money` is held by these tests, not by the compiler. Amounts are past
// `Number.MAX_SAFE_INTEGER` because that's where an unpaired `bigint` stops
// being a type complaint and starts being a wrong figure on the page a human
// reads to judge who's wrong.
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
    // Asserts `instanceof Money` rather than trusting the declared type: the
    // type alone doesn't guarantee a real conversion ran.
    await store();

    const stored = await orm.em.fork().findOne(discrepancySchema, KEY);

    expect(stored).not.toBeNull();

    const { held, reported } = discrepancyFromRow(stored!);

    expect(held).toBeInstanceOf(Money);
    expect(reported).toBeInstanceOf(Money);
    expectSameMoney(held!, usd(BEYOND_SAFE_INTEGER));
    expectSameMoney(reported!, usd(BEYOND_SAFE_INTEGER + 2n));
    // This alone would also pass a pairing that hardcoded 'USD'; the non-USD
    // tests below are what actually proves the column is read.
    expect(held!.currency).toBe('USD');
    expect(reported!.currency).toBe('USD');
  });

  it('comes back with nothing where the disagreement has only one side', async () => {
    // A null column must stay null, not become a zero Money: "treasury reports
    // nothing" and "treasury reports zero" are different facts, and absent
    // data must never release capacity (docs/PLAN.md §2.1).
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

  // EUR shows the currency column is read at all; JPY (no subdivision) shows
  // it's read for what it decides — a pairing that assumed two decimals would
  // render every yen amount a hundredfold small.
  describe('in the currency its program is denominated in', () => {
    // Both amounts in the program's own currency: the only shape reconciliation
    // can produce, since a mixed-currency snapshot is rejected whole.
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
      // A hardcoded two-decimal currency would render this as "12345.67".
      expect(held!.toDecimalString()).toBe('1234567');
      expect(held!.toString()).toBe('1234567 JPY');
    });
  });
});

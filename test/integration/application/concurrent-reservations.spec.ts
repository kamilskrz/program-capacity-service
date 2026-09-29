import { type MikroORM } from '@mikro-orm/postgresql';

import { aProgram } from '../support/factories';
import { expectCapacityInvariant } from '../support/invariant';
import { initTestOrm, resetDatabase } from '../support/orm';
import { countRows, selectRow } from '../support/rows';
import { ReserveInvoiceUseCase } from '../../../src/capacity/application/reserve-invoice.use-case';
import { InsufficientCapacityError } from '../../../src/capacity/domain/capacity-errors';
import { Money } from '../../../src/capacity/domain/money';
import { type Program } from '../../../src/capacity/domain/program';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmTransactionRunner } from '../../../src/capacity/infrastructure/persistence/mikro-orm-transaction-runner';
import { SystemClock } from '../../../src/shared/system-clock';

// The block's centerpiece (docs/PLAN.md 2.4): the program row lock has to
// serialize every concurrent reserve so exactly the invoices the limit can
// hold succeed — never more, never fewer.
//
// The limit is an exact multiple of the per-invoice amount, and the attempt
// count deliberately overshoots it, so both outcomes (success and
// InsufficientCapacityError) are exercised in one run.
const PER_INVOICE_AMOUNT_MINOR_UNITS = 1_000_000n; // 10,000.00 USD
const INVOICES_THE_LIMIT_HOLDS = 30;
const CONCURRENT_ATTEMPTS = 50;
const CREDIT_LIMIT_MINOR_UNITS =
  PER_INVOICE_AMOUNT_MINOR_UNITS * BigInt(INVOICES_THE_LIMIT_HOLDS);

function isFulfilled<T>(
  outcome: PromiseSettledResult<T>,
): outcome is PromiseFulfilledResult<T> {
  return outcome.status === 'fulfilled';
}

function isRejected<T>(
  outcome: PromiseSettledResult<T>,
): outcome is PromiseRejectedResult {
  return outcome.status === 'rejected';
}

describe('50 concurrent reserves against one program', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await initTestOrm();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await resetDatabase(orm);
  });

  async function createProgram(program: Program): Promise<Program> {
    const em = orm.em.fork();

    await em.transactional((tx) => {
      new MikroOrmProgramRepository(tx).add(program);
    });

    return program;
  }

  it('lets exactly the invoices the limit holds succeed, and no more', async () => {
    await createProgram(
      aProgram({
        creditLimit: Money.fromMinorUnits(CREDIT_LIMIT_MINOR_UNITS, 'USD'),
      }),
    );

    const attempts = Array.from({ length: CONCURRENT_ATTEMPTS }, (_, i) => {
      const useCase = new ReserveInvoiceUseCase(
        new MikroOrmTransactionRunner(orm.em),
        new SystemClock(),
      );

      return useCase.execute({
        programId: 'prog-northwind',
        invoiceId: `inv-${String(i).padStart(4, '0')}`,
        amount: '10000.00',
        currency: 'USD',
        actor: 'user-42',
        correlationId: `corr-${i}`,
      });
    });

    const settled = await Promise.allSettled(attempts);

    const fulfilled = settled.filter(isFulfilled);
    const rejected = settled.filter(isRejected);

    expect(fulfilled).toHaveLength(INVOICES_THE_LIMIT_HOLDS);
    expect(
      fulfilled.every((outcome) => outcome.value.status === 'CREATED'),
    ).toBe(true);

    expect(rejected).toHaveLength(
      CONCURRENT_ATTEMPTS - INVOICES_THE_LIMIT_HOLDS,
    );
    expect(
      rejected.every(
        (outcome) => outcome.reason instanceof InsufficientCapacityError,
      ),
    ).toBe(true);

    const program = await new MikroOrmProgramRepository(orm.em.fork()).findById(
      'prog-northwind',
    );

    expect(program!.reserved.toString()).toBe(
      Money.fromMinorUnits(CREDIT_LIMIT_MINOR_UNITS, 'USD').toString(),
    );

    expect(await countRows(orm.em, 'reservations')).toBe(
      INVOICES_THE_LIMIT_HOLDS,
    );

    const reservedEvents = await selectRow<{ count: string }>(
      orm.em,
      `select count(*) as count from "capacity_events" where "type" = 'RESERVED'`,
    );

    expect(Number(reservedEvents?.count)).toBe(INVOICES_THE_LIMIT_HOLDS);

    await expectCapacityInvariant(orm, 'prog-northwind');
  });
});

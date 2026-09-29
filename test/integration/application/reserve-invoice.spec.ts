import { type MikroORM } from '@mikro-orm/postgresql';

import { LIMIT, aProgram, usd } from '../support/factories';
import { expectCapacityInvariant } from '../support/invariant';
import { initTestOrm, resetDatabase } from '../support/orm';
import { countRows } from '../support/rows';
import {
  type ReserveInvoiceCommand,
  ReserveInvoiceUseCase,
} from '../../../src/capacity/application/reserve-invoice.use-case';
import {
  DuplicateInvoiceError,
  InsufficientCapacityError,
} from '../../../src/capacity/domain/capacity-errors';
import { Money } from '../../../src/capacity/domain/money';
import { type Program } from '../../../src/capacity/domain/program';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmTransactionRunner } from '../../../src/capacity/infrastructure/persistence/mikro-orm-transaction-runner';
import { SystemClock } from '../../../src/shared/system-clock';

// End to end against real Postgres, through the real MikroOrmTransactionRunner.
describe('ReserveInvoiceUseCase, end to end', () => {
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

  function buildUseCase(): ReserveInvoiceUseCase {
    return new ReserveInvoiceUseCase(
      new MikroOrmTransactionRunner(orm.em),
      new SystemClock(),
    );
  }

  function aCommand(
    overrides: Partial<ReserveInvoiceCommand> = {},
  ): ReserveInvoiceCommand {
    return {
      programId: 'prog-northwind',
      invoiceId: 'inv-0001',
      amount: '100.00',
      currency: 'USD',
      actor: 'user-42',
      correlationId: 'corr-0001',
      ...overrides,
    };
  }

  it('creates a reservation row, moves the counter, and records an audit event', async () => {
    await createProgram(aProgram({ creditLimit: usd(LIMIT) }));

    const result = await buildUseCase().execute(aCommand());

    expect(result.status).toBe('CREATED');
    expect(await countRows(orm.em, 'reservations')).toBe(1);
    expect(await countRows(orm.em, 'capacity_events')).toBe(1);
    await expectCapacityInvariant(orm, 'prog-northwind');
  });

  it('replays an identical request with no new row or event', async () => {
    await createProgram(aProgram({ creditLimit: usd(LIMIT) }));

    const useCase = buildUseCase();

    const first = await useCase.execute(aCommand());
    const replay = await useCase.execute(aCommand());

    expect(replay.status).toBe('REPLAYED');
    expect(replay.reservation.invoiceId).toBe(first.reservation.invoiceId);
    expect(await countRows(orm.em, 'reservations')).toBe(1);
    expect(await countRows(orm.em, 'capacity_events')).toBe(1);
  });

  it('returns a 409-mapped DuplicateInvoiceError for a conflicting replay', async () => {
    await createProgram(aProgram({ creditLimit: usd(LIMIT) }));

    const useCase = buildUseCase();

    await useCase.execute(aCommand());

    await expect(
      useCase.execute(aCommand({ amount: '200.00' })),
    ).rejects.toThrow(DuplicateInvoiceError);
  });

  it('leaves the database untouched when capacity is insufficient', async () => {
    await createProgram(
      aProgram({ creditLimit: Money.fromDecimalString('50.00', 'USD') }),
    );

    await expect(
      buildUseCase().execute(aCommand({ amount: '100.00' })),
    ).rejects.toThrow(InsufficientCapacityError);

    expect(await countRows(orm.em, 'reservations')).toBe(0);
    expect(await countRows(orm.em, 'capacity_events')).toBe(0);

    const program = await new MikroOrmProgramRepository(orm.em.fork()).findById(
      'prog-northwind',
    );

    expect(program!.reserved.isZero()).toBe(true);
  });
});

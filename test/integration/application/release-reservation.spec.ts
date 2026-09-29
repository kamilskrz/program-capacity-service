import { type MikroORM } from '@mikro-orm/postgresql';

import { LIMIT, aProgram, usd } from '../support/factories';
import { expectCapacityInvariant } from '../support/invariant';
import { initTestOrm, resetDatabase } from '../support/orm';
import { countRows } from '../support/rows';
import {
  type ReleaseReservationCommand,
  ReleaseReservationUseCase,
} from '../../../src/capacity/application/release-reservation.use-case';
import {
  type ReserveInvoiceCommand,
  ReserveInvoiceUseCase,
} from '../../../src/capacity/application/reserve-invoice.use-case';
import { type Program } from '../../../src/capacity/domain/program';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { MikroOrmTransactionRunner } from '../../../src/capacity/infrastructure/persistence/mikro-orm-transaction-runner';
import { SystemClock } from '../../../src/shared/system-clock';

// Symmetric with reserve-invoice.spec.ts.
//
// Releasing a reservation from a different program has no case here: the use
// case takes `programId` from the command, so there is no way to construct
// that call through this surface (docs/PLAN.md 2.4).
describe('ReleaseReservationUseCase, end to end', () => {
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

  function reserveCommand(
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

  function releaseCommand(
    overrides: Partial<ReleaseReservationCommand> = {},
  ): ReleaseReservationCommand {
    return {
      programId: 'prog-northwind',
      invoiceId: 'inv-0001',
      reason: 'REPAID',
      actor: 'user-42',
      correlationId: 'corr-0001',
      ...overrides,
    };
  }

  async function reserveOne(): Promise<void> {
    const reserve = new ReserveInvoiceUseCase(
      new MikroOrmTransactionRunner(orm.em),
      new SystemClock(),
    );

    await reserve.execute(reserveCommand());
  }

  function buildReleaseUseCase(): ReleaseReservationUseCase {
    return new ReleaseReservationUseCase(
      new MikroOrmTransactionRunner(orm.em),
      new SystemClock(),
    );
  }

  it('frees capacity, releases the row and appends one event', async () => {
    await createProgram(aProgram({ creditLimit: usd(LIMIT) }));
    await reserveOne();

    const result = await buildReleaseUseCase().execute(releaseCommand());

    expect(result.reservation.status).toBe('RELEASED');
    expect(await countRows(orm.em, 'capacity_events')).toBe(2);

    const program = await new MikroOrmProgramRepository(orm.em.fork()).findById(
      'prog-northwind',
    );

    expect(program!.reserved.isZero()).toBe(true);
    await expectCapacityInvariant(orm, 'prog-northwind');
  });

  it('is a no-op on a repeated release: no second event', async () => {
    await createProgram(aProgram({ creditLimit: usd(LIMIT) }));
    await reserveOne();

    const release = buildReleaseUseCase();

    await release.execute(releaseCommand());
    const second = await release.execute(releaseCommand());

    expect(second.reservation.status).toBe('RELEASED');
    expect(await countRows(orm.em, 'capacity_events')).toBe(2);
  });
});

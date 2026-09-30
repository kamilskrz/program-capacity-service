import { type MikroORM } from '@mikro-orm/postgresql';
import { Kafka, type Producer } from 'kafkajs';

import { kafkaBrokers } from '../global-setup';
import { aProgram, usd } from '../support/factories';
import { initTestOrm, resetDatabase } from '../support/orm';
import { countRows, selectRow } from '../support/rows';
import { CapacityChangeBroadcaster } from '../../../src/capacity/application/capacity-change-broadcaster';
import { MikroOrmProgramRepository } from '../../../src/capacity/infrastructure/persistence/mikro-orm-program.repository';
import { ApplyInvoiceRepaidUseCase } from '../../../src/treasury-sync/application/apply-invoice-repaid.use-case';
import { ApplyLimitChangeUseCase } from '../../../src/treasury-sync/application/apply-limit-change.use-case';
import { ApplySnapshotUseCase } from '../../../src/treasury-sync/application/apply-snapshot.use-case';
import { type DlqMessage } from '../../../src/treasury-sync/infrastructure/kafka/dlq-message';
import {
  TREASURY_DLQ_TOPIC,
  TREASURY_TOPIC,
  TreasuryKafkaConsumer,
} from '../../../src/treasury-sync/infrastructure/kafka/treasury-kafka-consumer';
import { MikroOrmTreasuryTransactionRunner } from '../../../src/treasury-sync/infrastructure/persistence/mikro-orm-treasury-transaction-runner';
import { type AppConfigService } from '../../../src/shared/config/app-config.service';
import { MetricsService } from '../../../src/shared/observability/metrics.service';
import { SystemClock } from '../../../src/shared/system-clock';
import { MikroOrmTransactionRunner } from '../../../src/capacity/infrastructure/persistence/mikro-orm-transaction-runner';

// The real consumer against real Redpanda and real Postgres (docs/PLAN.md
// 2.2). One consumer for the whole file: it subscribes from the beginning of
// a shared topic and offsets only ever move forward, so each test produces
// messages for its own program id and waits for that program's effect rather
// than trying to reset Kafka between tests.
describe('the treasury Kafka consumer, end to end', () => {
  let orm: MikroORM;
  let consumer: TreasuryKafkaConsumer;
  let producer: Producer;

  beforeAll(async () => {
    orm = await initTestOrm();

    const kafka = new Kafka({
      brokers: kafkaBrokers().split(','),
      clientId: 'treasury-consumer-spec',
    });
    const admin = kafka.admin();

    await admin.connect();
    // Created up front rather than relying on auto-creation, so a first
    // produce/consume never races topic metadata.
    await admin.createTopics({
      topics: [{ topic: TREASURY_TOPIC }, { topic: TREASURY_DLQ_TOPIC }],
      waitForLeaders: true,
    });
    await admin.disconnect();

    producer = kafka.producer();
    await producer.connect();

    const config = {
      kafkaBrokers: kafkaBrokers().split(','),
    } as AppConfigService;
    const treasuryRunner = new MikroOrmTreasuryTransactionRunner(orm.em);
    const capacityRunner = new MikroOrmTransactionRunner(orm.em);
    const clock = new SystemClock();

    consumer = new TreasuryKafkaConsumer(
      config,
      new ApplySnapshotUseCase(treasuryRunner),
      new ApplyLimitChangeUseCase(capacityRunner, clock),
      new ApplyInvoiceRepaidUseCase(capacityRunner, clock),
      new CapacityChangeBroadcaster(),
      new MetricsService(),
    );

    await consumer.onModuleInit();
  }, 60_000);

  // Generous: leaving a consumer group takes a rebalance, comfortably past
  // Jest's 5s hook default.
  afterAll(async () => {
    await consumer.onModuleDestroy();
    await producer.disconnect();
    await orm.close(true);
  }, 60_000);

  beforeEach(async () => {
    await resetDatabase(orm);
  });

  /** Polls until `condition` holds, or fails the test by timing out. */
  async function until(
    condition: () => Promise<boolean>,
    what: string,
  ): Promise<void> {
    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
      if (await condition()) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`timed out waiting for ${what}`);
  }

  /** Scoped to one program: the consumer is shared, so a global row count could see another test's work. */
  async function reservationsOf(programId: string): Promise<number> {
    const row = await selectRow<{ count: string }>(
      orm.em,
      `select count(*) as count from "reservations" where "program_id" = ?`,
      [programId],
    );

    return Number(row?.count);
  }

  async function seedProgram(id: string): Promise<void> {
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      new MikroOrmProgramRepository(tx).add(
        aProgram({ id, creditLimit: usd(1_000_000_000n) }),
      );
      await tx.flush();
    });
  }

  async function publish(value: unknown, key: string): Promise<void> {
    await producer.send({
      topic: TREASURY_TOPIC,
      messages: [{ key, value: JSON.stringify(value) }],
    });
  }

  function aSnapshot(programId: string, invoiceId: string) {
    return {
      type: 'ProgramSnapshot',
      programId,
      sequence: 1,
      asOf: new Date().toISOString(),
      currency: 'USD',
      creditLimit: '10000000.00',
      invoices: [
        {
          invoiceId,
          status: 'OUTSTANDING',
          amount: '1000.00',
          originalAmount: '1000.00',
          originalCurrency: 'USD',
        },
      ],
      outstandingTotal: '1000.00',
      invoiceCount: 1,
      repaidTotal: '0.00',
      repaidCount: 0,
    };
  }

  it('applies a snapshot it consumes, creating the hold treasury reports', async () => {
    const programId = 'prog-kafka-applied';

    await seedProgram(programId);
    await publish(aSnapshot(programId, 'inv-kafka-1'), programId);

    await until(
      async () => (await reservationsOf(programId)) === 1,
      'the consumer to apply the snapshot',
    );

    const row = await selectRow<{ reserved_amount: string }>(
      orm.em,
      `select "reserved_amount" from "programs" where "id" = ?`,
      [programId],
    );

    expect(row?.reserved_amount).toBe('100000');
    expect(await countRows(orm.em, 'capacity_events')).toBeGreaterThan(0);
  }, 40_000);

  it('routes a poison message to the DLQ without stalling the good message behind it', async () => {
    const programId = 'prog-kafka-poison';

    await seedProgram(programId);

    const kafka = new Kafka({
      brokers: kafkaBrokers().split(','),
      clientId: 'dlq-reader-spec',
    });
    const dlqReader = kafka.consumer({ groupId: `dlq-reader-${Date.now()}` });
    const dlqMessages: DlqMessage[] = [];

    await dlqReader.connect();
    await dlqReader.subscribe({
      topic: TREASURY_DLQ_TOPIC,
      fromBeginning: true,
    });
    await dlqReader.run({
      eachMessage: ({ message }) => {
        dlqMessages.push(
          JSON.parse(message.value?.toString('utf8') ?? '{}') as DlqMessage,
        );

        return Promise.resolve();
      },
    });

    try {
      // A type nothing recognises: permanent, so it must be DLQ'd and
      // committed rather than blocking the partition.
      await publish({ type: 'SomethingElse', programId }, programId);
      await publish(aSnapshot(programId, 'inv-kafka-2'), programId);

      await until(
        async () => (await reservationsOf(programId)) === 1,
        'the message behind the poison one to be applied',
      );
      await until(
        () =>
          Promise.resolve(
            dlqMessages.some((dlq) =>
              dlq.originalValue.includes('SomethingElse'),
            ),
          ),
        'the poison message to reach the DLQ',
      );
    } finally {
      await dlqReader.disconnect();
    }

    const poisoned = dlqMessages.find((dlq) =>
      dlq.originalValue.includes('SomethingElse'),
    );

    expect(poisoned?.originalTopic).toBe(TREASURY_TOPIC);
    expect(poisoned?.failureReason).toContain('Unrecognised');
    expect(poisoned?.failedAt).toEqual(expect.any(String));
  }, 60_000);
});

import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  Kafka,
  Partitioners,
  logLevel,
  type Consumer,
  type EachMessagePayload,
  type Producer,
} from 'kafkajs';

import { type DlqMessage } from './dlq-message';
import { classifyFailure, parseMessage } from './message-dispatch';
import { CapacityChangeBroadcaster } from '../../../capacity/application/capacity-change-broadcaster';
import { ApplyInvoiceRepaidUseCase } from '../../application/apply-invoice-repaid.use-case';
import { ApplyLimitChangeUseCase } from '../../application/apply-limit-change.use-case';
import { ApplySnapshotUseCase } from '../../application/apply-snapshot.use-case';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { MetricsService } from '../../../shared/observability/metrics.service';

/** `treasury.program-events` (docs/PLAN.md 2.2): one topic, keyed by `programId`. */
export const TREASURY_TOPIC = 'treasury.program-events';
export const TREASURY_DLQ_TOPIC = 'treasury.program-events.dlq';
export const TREASURY_CONSUMER_GROUP_ID = 'program-capacity-treasury-sync';

/**
 * `OnModuleInit`/`OnModuleDestroy`, not `@EventPattern` (docs/PLAN.md 2.2):
 * `kafkajs` directly, so the offset commit can be sequenced after the database
 * transaction that applied a message, not after Nest's own dispatch.
 */
@Injectable()
export class TreasuryKafkaConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TreasuryKafkaConsumer.name);
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;
  private readonly producer: Producer;
  /** Best-effort, per-program, for the gap log only; resets on restart. */
  private readonly lastSequence = new Map<string, number>();

  constructor(
    config: AppConfigService,
    private readonly applySnapshot: ApplySnapshotUseCase,
    private readonly applyLimitChange: ApplyLimitChangeUseCase,
    private readonly applyInvoiceRepaid: ApplyInvoiceRepaidUseCase,
    private readonly broadcaster: CapacityChangeBroadcaster,
    private readonly metrics: MetricsService,
  ) {
    this.kafka = new Kafka({
      brokers: config.kafkaBrokers,
      clientId: 'program-capacity',
      // kafkajs logs every group rebalance at INFO; this service's own log
      // lines are the ones worth reading.
      logLevel: logLevel.WARN,
    });
    this.consumer = this.kafka.consumer({
      groupId: TREASURY_CONSUMER_GROUP_ID,
    });
    this.producer = this.kafka.producer({
      // Stated rather than defaulted: the partitioner decides which partition a
      // key lands on, and therefore what stays ordered. kafkajs warns on every
      // boot until one is chosen. This service is greenfield, so the current
      // default is right; `LegacyPartitioner` would only matter alongside a
      // pre-2.0 producer writing the same topic.
      createPartitioner: Partitioners.DefaultPartitioner,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: TREASURY_TOPIC,
      fromBeginning: true,
    });

    // `autoCommit: false` is the whole point: the offset moves only once the
    // transaction that applied the message has committed.
    await this.consumer.run({
      autoCommit: false,
      eachMessage: (payload) => this.onMessage(payload),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
    await this.producer.disconnect();
  }

  /**
   * Applies one message, then commits its offset. A transient failure
   * propagates so kafkajs redelivers without the offset moving; a permanent
   * one goes to the DLQ and is committed, so one poison message cannot stall
   * the partition behind it (docs/PLAN.md 2.2).
   */
  private async onMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;

    try {
      await this.apply(message.value);
    } catch (error) {
      if (classifyFailure(error) === 'transient') {
        this.metrics.message(typeOf(message.value), 'retried');
        this.logger.warn(
          `transient failure on ${topic}[${partition}]@${message.offset}, leaving the offset where it is: ${describe(error)}`,
        );

        throw error;
      }

      this.metrics.message(typeOf(message.value), 'rejected');
      await this.sendToDlq(payload, describe(error));
    }

    // `offset + 1`: kafkajs commits the *next* offset to read, not the one
    // just handled.
    await this.consumer.commitOffsets([
      { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
    ]);
  }

  private async apply(value: Buffer | null): Promise<void> {
    const parsed = parseMessage(value?.toString('utf8') ?? null);

    switch (parsed.type) {
      case 'ProgramSnapshot': {
        this.logGap(parsed.programId, parsed.sequence);

        const outcome = await this.applySnapshot.execute(parsed);

        this.announce(parsed.programId);
        this.metrics.message(parsed.type, 'applied');
        this.metrics.observeSnapshotLag(
          parsed.programId,
          new Date(parsed.asOf),
          new Date(),
        );

        if (outcome.verdict === 'APPLY') {
          this.metrics.observeOpenDiscrepancies(
            parsed.programId,
            outcome.discrepancies.length,
          );
        }

        return;
      }
      case 'ProgramLimitChanged': {
        await this.applyLimitChange.execute(parsed);
        this.announce(parsed.programId);
        this.metrics.message(parsed.type, 'applied');

        return;
      }
      case 'InvoiceRepaid': {
        const result = await this.applyInvoiceRepaid.execute(parsed);

        this.metrics.message(parsed.type, 'applied');

        if (result.status === 'RELEASED') {
          this.announce(parsed.programId);
        }

        if (result.status === 'UNKNOWN_INVOICE') {
          this.logger.log(
            `InvoiceRepaid for ${parsed.programId}/${parsed.invoiceId} names an invoice this service holds no reservation for; only the next snapshot can resolve it (docs/PLAN.md 2.2)`,
          );
        }

        return;
      }
    }
  }

  /** Wakes any `GET /capacity/stream` watching this program (docs/PLAN.md 2.8). */
  private announce(programId: string): void {
    this.broadcaster.publish({ programId, occurredAt: new Date() });
  }

  /** Observability only — a gap heals itself, since every snapshot carries full state (docs/PLAN.md 2.2). */
  private logGap(programId: string, sequence: number): void {
    const previous = this.lastSequence.get(programId);

    if (previous !== undefined && sequence > previous + 1) {
      this.logger.warn(
        `snapshot sequence gap for ${programId}: ${previous} → ${sequence}`,
      );
    }

    this.lastSequence.set(programId, sequence);
  }

  private async sendToDlq(
    { topic, partition, message }: EachMessagePayload,
    failureReason: string,
  ): Promise<void> {
    const envelope: DlqMessage = {
      originalTopic: topic,
      originalPartition: partition,
      originalOffset: message.offset,
      originalKey: message.key?.toString('utf8') ?? null,
      originalValue: message.value?.toString('utf8') ?? '',
      failureReason,
      failedAt: new Date().toISOString(),
    };

    this.logger.error(
      `permanent failure on ${topic}[${partition}]@${message.offset}, routing to ${TREASURY_DLQ_TOPIC}: ${failureReason}`,
    );
    this.metrics.deadLettered();

    await this.producer.send({
      topic: TREASURY_DLQ_TOPIC,
      messages: [{ key: message.key, value: JSON.stringify(envelope) }],
    });
  }
}

/** The `type` a message claims, for the metric's label — before validation, so an unusable one still counts. */
function typeOf(value: Buffer | null): string {
  try {
    const parsed: unknown = JSON.parse(value?.toString('utf8') ?? 'null');
    const type =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { type?: unknown }).type
        : undefined;

    return typeof type === 'string' ? type : 'unknown';
  } catch {
    return 'unparseable';
  }
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

import {
  TREASURY_CONSUMER_GROUP_ID,
  TREASURY_DLQ_TOPIC,
  TREASURY_TOPIC,
  TreasuryKafkaConsumer,
} from './treasury-kafka-consumer';
import { type ApplyInvoiceRepaidUseCase } from '../../application/apply-invoice-repaid.use-case';
import { type ApplyLimitChangeUseCase } from '../../application/apply-limit-change.use-case';
import { type ApplySnapshotUseCase } from '../../application/apply-snapshot.use-case';
import { CapacityChangeBroadcaster } from '../../../capacity/application/capacity-change-broadcaster';
import { type AppConfigService } from '../../../shared/config/app-config.service';
import { MetricsService } from '../../../shared/observability/metrics.service';

const fakeConfig = { kafkaBrokers: ['localhost:19092'] } as AppConfigService;

function build(): TreasuryKafkaConsumer {
  return new TreasuryKafkaConsumer(
    fakeConfig,
    {} as ApplySnapshotUseCase,
    {} as ApplyLimitChangeUseCase,
    {} as ApplyInvoiceRepaidUseCase,
    new CapacityChangeBroadcaster(),
    new MetricsService(),
  );
}

// Everything past construction needs a broker, so it lives in
// test/integration/kafka/; the parse/classify half is covered by
// message-dispatch.spec.ts.
describe('TreasuryKafkaConsumer', () => {
  it('builds its client, consumer and producer without reaching a broker', () => {
    expect(() => build()).not.toThrow();
  });

  it('names one topic, one DLQ topic and one consumer group', () => {
    expect(TREASURY_TOPIC).toBe('treasury.program-events');
    expect(TREASURY_DLQ_TOPIC).toBe(`${TREASURY_TOPIC}.dlq`);
    expect(TREASURY_CONSUMER_GROUP_ID).toBe('program-capacity-treasury-sync');
  });
});

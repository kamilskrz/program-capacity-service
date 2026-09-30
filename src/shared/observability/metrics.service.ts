import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

/** What a reserve attempt ended as, for `capacity_reservations_total`. */
export type ReservationResult = 'created' | 'replayed' | 'rejected';

/** What handling one Kafka message ended as, for `kafka_messages_total`. */
export type KafkaMessageResult = 'applied' | 'rejected' | 'retried';

/**
 * The business metrics docs/PLAN.md 2.8 names, on this service's own registry
 * rather than the global one, so a test can build a second instance without
 * `prom-client` complaining about a duplicate registration.
 *
 * `capacity_utilization_ratio` is labelled by program, which is what makes the
 * plan's "utilization > 0.95" alert expressible per program. Cardinality is
 * therefore the number of programs that have seen a change since start-up —
 * fine for a closed set of commercial agreements (§2.9), and the label to drop
 * first if that ever stops being true.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly reservations = new Counter({
    name: 'capacity_reservations_total',
    help: 'Reserve attempts by outcome.',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly utilization = new Gauge({
    name: 'capacity_utilization_ratio',
    help: 'Reserved over credit limit, per program. Above 1 means over-utilised.',
    labelNames: ['programId'] as const,
    registers: [this.registry],
  });

  readonly snapshotLag = new Gauge({
    name: 'treasury_snapshot_lag_seconds',
    help: "How far behind the last applied snapshot's asOf is, per program.",
    labelNames: ['programId'] as const,
    registers: [this.registry],
  });

  /** A gauge, not a counter, despite the name the plan gives it: it measures open problems, not events. */
  readonly discrepancies = new Gauge({
    name: 'treasury_reconciliation_discrepancies_total',
    help: 'Open, unresolved discrepancies, per program.',
    labelNames: ['programId'] as const,
    registers: [this.registry],
  });

  readonly kafkaMessages = new Counter({
    name: 'kafka_messages_total',
    help: 'Treasury messages handled, by type and outcome.',
    labelNames: ['type', 'result'] as const,
    registers: [this.registry],
  });

  readonly kafkaDlq = new Counter({
    name: 'kafka_dlq_total',
    help: 'Messages routed to the dead-letter topic.',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  reservation(result: ReservationResult): void {
    this.reservations.inc({ result });
  }

  message(type: string, result: KafkaMessageResult): void {
    this.kafkaMessages.inc({ type, result });
  }

  deadLettered(): void {
    this.kafkaDlq.inc();
  }

  /** Both figures in minor units; a zero limit reports zero rather than dividing by it. */
  observeUtilization(
    programId: string,
    reserved: bigint,
    creditLimit: bigint,
  ): void {
    const ratio =
      creditLimit === 0n ? 0 : Number(reserved) / Number(creditLimit);

    this.utilization.set({ programId }, ratio);
  }

  observeSnapshotLag(programId: string, asOf: Date, now: Date): void {
    this.snapshotLag.set(
      { programId },
      Math.max(0, (now.getTime() - asOf.getTime()) / 1_000),
    );
  }

  observeOpenDiscrepancies(programId: string, open: number): void {
    this.discrepancies.set({ programId }, open);
  }

  scrape(): Promise<string> {
    return this.registry.metrics();
  }
}

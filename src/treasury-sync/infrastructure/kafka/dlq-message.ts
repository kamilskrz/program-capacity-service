/** One message written to `treasury.program-events.dlq` (docs/PLAN.md 2.2). */
export interface DlqMessage {
  readonly originalTopic: string;
  readonly originalPartition: number;
  readonly originalOffset: string;
  readonly originalKey: string | null;
  readonly originalValue: string;
  readonly failureReason: string;
  readonly failedAt: string;
}

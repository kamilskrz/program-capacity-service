import {
  type CapacityEventSource,
  type CapacityEventType,
} from '../../../domain/capacity-event';

/**
 * Wire shape of one `capacity_events` row. `id` is a decimal string — it is a
 * `bigint` on the domain side and never a JS `number` (docs/PLAN.md 2.7).
 */
export interface EventResponse {
  readonly id: string;
  readonly type: CapacityEventType;
  readonly invoiceId: string | null;
  readonly delta: string;
  readonly deltaCurrency: string;
  readonly resultingReserved: string;
  readonly resultingReservedCurrency: string;
  readonly actor: string;
  readonly source: CapacityEventSource;
  readonly correlationId: string | null;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

/** `GET /programs/:id/events`. */
export interface EventPageResponse {
  readonly events: readonly EventResponse[];
  /** Decimal string, the last page's `id` — round-trips through `ListEventsQueryDto.after`. */
  readonly nextCursor: string | null;
}

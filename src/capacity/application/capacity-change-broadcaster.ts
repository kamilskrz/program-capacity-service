import { Injectable } from '@nestjs/common';
import { Subject, filter, type Observable } from 'rxjs';

/** That one program's capacity moved; subscribers re-read it rather than being handed a figure. */
export interface CapacityChangeNotification {
  readonly programId: string;
  readonly occurredAt: Date;
}

/**
 * In-process fan-out behind `GET /capacity/stream` (docs/PLAN.md 2.8).
 *
 * Deliberately in memory and therefore **single-replica**: a change applied by
 * one instance does not reach a stream held by another. Making it cross-instance
 * needs a broadcast the streams subscribe to (Postgres `LISTEN/NOTIFY`, or the
 * Kafka topic this service already consumes) — documented as the next step,
 * not built, since the brief's scope is one service.
 *
 * Notified by the callers that already hold the outcome — the controller and
 * the Kafka consumer — rather than by the use cases, so an application-layer
 * operation stays unaware of who is watching it.
 */
@Injectable()
export class CapacityChangeBroadcaster {
  private readonly changes = new Subject<CapacityChangeNotification>();

  publish(notification: CapacityChangeNotification): void {
    this.changes.next(notification);
  }

  forProgram(programId: string): Observable<CapacityChangeNotification> {
    return this.changes
      .asObservable()
      .pipe(filter((change) => change.programId === programId));
  }
}

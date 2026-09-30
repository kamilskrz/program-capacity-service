import { type MessageEvent } from '@nestjs/common';
import { filter, firstValueFrom, take, toArray, type Subscription } from 'rxjs';

import { ProgramsController } from './programs.controller';
import { CapacityChangeBroadcaster } from '../../application/capacity-change-broadcaster';
import {
  type CapacityQueryService,
  type CapacitySnapshot,
} from '../../application/capacity-query.service';
import { type CreateProgramUseCase } from '../../application/create-program.use-case';
import { type ReleaseReservationUseCase } from '../../application/release-reservation.use-case';
import { type ReserveInvoiceUseCase } from '../../application/reserve-invoice.use-case';
import { MetricsService } from '../../../shared/observability/metrics.service';

// `streamCapacity`'s observable, subscribed directly: the `@Sse()` wiring
// around it is NestJS's, the merge/re-read/filter inside it is this file's.
// The 15s heartbeat is not asserted — it is a constant, and waiting for it
// would make this spec fifteen seconds long for no extra information.
describe('the capacity stream', () => {
  // The stream merges an infinite heartbeat, so every manual subscription has
  // to be torn down or Jest waits on the open timer for ever.
  const subscriptions: Subscription[] = [];

  afterEach(() => {
    subscriptions.forEach((subscription) => subscription.unsubscribe());
    subscriptions.length = 0;
  });

  function aSnapshot(reserved: string): CapacitySnapshot {
    return {
      limit: '10000.00',
      reserved,
      available: '0.00',
      currency: 'USD',
      overUtilized: false,
      lastReconciledAt: null,
    };
  }

  function setUp(snapshots: (CapacitySnapshot | null)[]) {
    const remaining = [...snapshots];
    const broadcaster = new CapacityChangeBroadcaster();
    const queries = {
      getCapacity: () => Promise.resolve(remaining.shift() ?? null),
    } as unknown as CapacityQueryService;
    const controller = new ProgramsController(
      {} as CreateProgramUseCase,
      {} as ReserveInvoiceUseCase,
      {} as ReleaseReservationUseCase,
      queries,
      broadcaster,
      new MetricsService(),
    );

    return { broadcaster, controller };
  }

  /** Only the capacity frames; heartbeats are noise for these assertions. */
  function capacityEvents(
    stream: ReturnType<ProgramsController['streamCapacity']>,
  ) {
    return stream.pipe(filter((event) => event.type === 'capacity'));
  }

  it('sends the current figure on subscribe, before any change happens', async () => {
    const { controller } = setUp([aSnapshot('0.00')]);

    const first = await firstValueFrom(
      capacityEvents(controller.streamCapacity('prog-northwind')),
    );

    expect(first).toEqual<MessageEvent>({
      type: 'capacity',
      data: expect.objectContaining({ reserved: '0.00', currency: 'USD' }),
    });
  });

  it('re-reads and sends again when that program reports a change', async () => {
    const { broadcaster, controller } = setUp([
      aSnapshot('0.00'),
      aSnapshot('100.00'),
    ]);

    const both = firstValueFrom(
      capacityEvents(controller.streamCapacity('prog-northwind')).pipe(
        take(2),
        toArray(),
      ),
    );

    broadcaster.publish({
      programId: 'prog-northwind',
      occurredAt: new Date(),
    });

    const [before, after] = await both;

    expect(before?.data).toMatchObject({ reserved: '0.00' });
    expect(after?.data).toMatchObject({ reserved: '100.00' });
  });

  it('ignores a change to a different program', async () => {
    const { broadcaster, controller } = setUp([
      aSnapshot('0.00'),
      aSnapshot('100.00'),
    ]);
    const seen: MessageEvent[] = [];

    subscriptions.push(
      capacityEvents(controller.streamCapacity('prog-northwind')).subscribe(
        (event) => seen.push(event),
      ),
    );

    broadcaster.publish({
      programId: 'prog-hanseatic',
      occurredAt: new Date(),
    });

    // One tick for the initial read's promise to settle; the foreign change
    // must not have produced a second.
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toHaveLength(1);
  });

  it('sends nothing for a program the read cannot find, rather than a stale figure', async () => {
    const { controller } = setUp([null]);
    const seen: MessageEvent[] = [];

    subscriptions.push(
      capacityEvents(controller.streamCapacity('prog-gone')).subscribe(
        (event) => seen.push(event),
      ),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toEqual([]);
  });
});

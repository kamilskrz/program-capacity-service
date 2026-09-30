import { firstValueFrom, take, toArray } from 'rxjs';

import {
  CapacityChangeBroadcaster,
  type CapacityChangeNotification,
} from './capacity-change-broadcaster';

describe('CapacityChangeBroadcaster', () => {
  const at = new Date('2026-01-15T10:32:00.000Z');

  it('delivers a change to a subscriber watching that program', async () => {
    const broadcaster = new CapacityChangeBroadcaster();
    const received = firstValueFrom(broadcaster.forProgram('prog-northwind'));

    broadcaster.publish({ programId: 'prog-northwind', occurredAt: at });

    await expect(received).resolves.toEqual({
      programId: 'prog-northwind',
      occurredAt: at,
    });
  });

  it('does not leak one program’s changes to another program’s stream', () => {
    const broadcaster = new CapacityChangeBroadcaster();
    const northwind: CapacityChangeNotification[] = [];

    broadcaster
      .forProgram('prog-northwind')
      .subscribe((change) => northwind.push(change));

    broadcaster.publish({ programId: 'prog-hanseatic', occurredAt: at });
    broadcaster.publish({ programId: 'prog-northwind', occurredAt: at });

    expect(northwind).toEqual([
      { programId: 'prog-northwind', occurredAt: at },
    ]);
  });

  it('fans one change out to every subscriber of that program', async () => {
    const broadcaster = new CapacityChangeBroadcaster();
    const first = firstValueFrom(broadcaster.forProgram('prog-northwind'));
    const second = firstValueFrom(broadcaster.forProgram('prog-northwind'));

    broadcaster.publish({ programId: 'prog-northwind', occurredAt: at });

    await expect(first).resolves.toMatchObject({ programId: 'prog-northwind' });
    await expect(second).resolves.toMatchObject({
      programId: 'prog-northwind',
    });
  });

  it('delivers changes in the order they were published', async () => {
    const broadcaster = new CapacityChangeBroadcaster();
    const both = firstValueFrom(
      broadcaster.forProgram('prog-northwind').pipe(take(2), toArray()),
    );
    const later = new Date(at.getTime() + 1_000);

    broadcaster.publish({ programId: 'prog-northwind', occurredAt: at });
    broadcaster.publish({ programId: 'prog-northwind', occurredAt: later });

    await expect(both).resolves.toEqual([
      { programId: 'prog-northwind', occurredAt: at },
      { programId: 'prog-northwind', occurredAt: later },
    ]);
  });

  // A stream opened after a change has already happened is not replayed it:
  // the endpoint sends the current figure itself on subscribe, so replaying
  // would double every first event.
  it('does not replay changes published before a subscription', () => {
    const broadcaster = new CapacityChangeBroadcaster();

    broadcaster.publish({ programId: 'prog-northwind', occurredAt: at });

    const seen: CapacityChangeNotification[] = [];

    broadcaster
      .forProgram('prog-northwind')
      .subscribe((change) => seen.push(change));

    expect(seen).toEqual([]);
  });
});

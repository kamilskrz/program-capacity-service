import { type DlqMessage } from './dlq-message';

// A plain type with no logic — this only proves the shape compiles and every
// field round-trips, not any behaviour.
describe('DlqMessage', () => {
  it('accepts a full literal, including a null key', () => {
    const message: DlqMessage = {
      originalTopic: 'treasury.program-events',
      originalPartition: 0,
      originalOffset: '42',
      originalKey: null,
      originalValue: '{"type":"Bogus"}',
      failureReason: 'Unrecognised treasury message type: "Bogus"',
      failedAt: '2026-09-30T00:00:00.000Z',
    };

    expect(message.originalPartition).toBe(0);
    expect(message.originalKey).toBeNull();
  });
});

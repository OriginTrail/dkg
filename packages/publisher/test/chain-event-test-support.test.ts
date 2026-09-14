import { describe, expect, it, vi } from 'vitest';
import { seedChainEventPollerCursors } from '../src/chain-event-test-support.js';

describe('chain event test support', () => {
  it('seeds every runtime lane at the requested block', async () => {
    const saveLane = vi.fn(async () => undefined);
    await seedChainEventPollerCursors(
      { loadLane: async () => undefined, saveLane },
      417,
    );
    expect(saveLane.mock.calls).toEqual([
      ['publish', 417],
      ['allocatorReconcile', 417],
      ['contextGraphDiscovery', 417],
      ['vmReconcile', 417],
      ['collectionUpdates', 417],
      ['allowListUpdates', 417],
      ['profileEvents', 417],
    ]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Rfc64CatalogMethods } from '../src/dkg-agent-rfc64-catalog.js';

type ScheduleCatchup = { scheduleRfc64AuthorityAcceptedPeerCatchupV1(this: unknown): void };

function scheduleCatchup(agent: unknown): void {
  (Rfc64CatalogMethods.prototype as unknown as ScheduleCatchup)
    .scheduleRfc64AuthorityAcceptedPeerCatchupV1.call(agent);
}

describe('RFC-64 accepted-authority peer catch-up timer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when the node stopped before the timer fired', () => {
    vi.useFakeTimers();
    const queueSyncFromPeerOnConnect = vi.fn();
    scheduleCatchup({
      started: true,
      node: {
        isStarted: false,
        get libp2p(): never {
          throw new Error('DKGNode not started');
        },
      },
      queueSyncFromPeerOnConnect,
      log: { warn: vi.fn() },
    });

    // An uncaught throw here fails a whole vitest shard, not just this test.
    expect(() => vi.advanceTimersByTime(3_000)).not.toThrow();
    expect(queueSyncFromPeerOnConnect).not.toHaveBeenCalled();
  });

  it('queues a catch-up from every connected peer while the node runs', () => {
    vi.useFakeTimers();
    const queueSyncFromPeerOnConnect = vi.fn();
    scheduleCatchup({
      started: true,
      node: {
        isStarted: true,
        libp2p: { getPeers: () => [{ toString: () => 'peer-a' }, { toString: () => 'peer-b' }] },
      },
      queueSyncFromPeerOnConnect,
      log: { warn: vi.fn() },
    });

    vi.advanceTimersByTime(3_000);

    expect(queueSyncFromPeerOnConnect.mock.calls.map((call) => call[0])).toEqual(['peer-a', 'peer-b']);
  });
});

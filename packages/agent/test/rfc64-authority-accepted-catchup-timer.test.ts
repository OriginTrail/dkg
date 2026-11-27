import { afterEach, describe, expect, it, vi } from 'vitest';

import { Rfc64CatalogMethods } from '../src/dkg-agent-rfc64-catalog.js';

type ScheduleCatchup = {
  scheduleRfc64AuthorityAcceptedPeerCatchupV1(this: unknown, contextGraphId: string): void;
};

function scheduleCatchup(agent: unknown, contextGraphId = 'cg-a'): void {
  (Rfc64CatalogMethods.prototype as unknown as ScheduleCatchup)
    .scheduleRfc64AuthorityAcceptedPeerCatchupV1.call(agent, contextGraphId);
}

function runningAgent(peerIds: readonly string[]) {
  return {
    started: true,
    node: {
      isStarted: true,
      libp2p: { getPeers: () => peerIds.map((peerId) => ({ toString: () => peerId })) },
    },
    queueSyncFromPeerOnConnect: vi.fn(),
    log: { warn: vi.fn() },
  };
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

  it('queues a catch-up of the changed graph from every connected peer while the node runs', () => {
    vi.useFakeTimers();
    const agent = runningAgent(['peer-a', 'peer-b']);
    scheduleCatchup(agent, 'cg-a');

    vi.advanceTimersByTime(3_000);

    expect(agent.queueSyncFromPeerOnConnect.mock.calls.map((call) => call[0])).toEqual(['peer-a', 'peer-b']);
    for (const call of agent.queueSyncFromPeerOnConnect.mock.calls) {
      expect(call[2]).toBe(0);
      expect(call[3]).toEqual({
        authorityScopeChanged: true,
        authorityScopeContextGraphIds: new Set(['cg-a']),
      });
    }
  });

  it('coalesces the graphs of one window and scopes the next window to its own graphs', () => {
    vi.useFakeTimers();
    const agent = runningAgent(['peer-a']);
    scheduleCatchup(agent, 'cg-a');
    vi.advanceTimersByTime(1_000);
    scheduleCatchup(agent, 'cg-b');
    vi.advanceTimersByTime(3_000);
    scheduleCatchup(agent, 'cg-c');
    vi.advanceTimersByTime(3_000);

    expect(agent.queueSyncFromPeerOnConnect.mock.calls.map((call) => call[3].authorityScopeContextGraphIds))
      .toEqual([new Set(['cg-a', 'cg-b']), new Set(['cg-c'])]);
  });

  it('logs a failed catch-up with the peer it came from', () => {
    vi.useFakeTimers();
    const agent = runningAgent(['12D3KooWCatchupFailurePeer']);
    scheduleCatchup(agent);
    vi.advanceTimersByTime(3_000);

    const onError = agent.queueSyncFromPeerOnConnect.mock.calls[0]![1] as (
      peerId: string,
      error: unknown,
    ) => void;
    onError('12D3KooWCatchupFailurePeer', new Error('stream reset'));
    onError('12D3KooWCatchupFailurePeer', 'refused');

    expect(agent.log.warn).toHaveBeenCalledTimes(2);
    expect(agent.log.warn.mock.calls[0]![1]).toBe(
      'RFC-64 authority catch-up from lurePeer failed: stream reset',
    );
    expect(agent.log.warn.mock.calls[1]![1]).toBe(
      'RFC-64 authority catch-up from lurePeer failed: refused',
    );
  });
});

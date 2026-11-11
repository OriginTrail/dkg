// SPDX-License-Identifier: Apache-2.0

/**
 * A catalog replay that could not finish is tried again while its peer stays
 * connected and admitted, a bounded number of times (`Rfc64CatalogReplayConnectionRuntimeV1`).
 */
import {describe, expect, it, vi} from 'vitest';
import {RFC64_CATALOG_UNFINISHED_REPLAY_MAX_RETRIES_V1} from '../src/rfc64/catalog-replay-scope-lifecycle-v1.js';
import {makeRuntime} from './_helpers/catalog-connection-runtime.js';

describe('an unfinished replay for a still-connected peer', () => {
  const MAX_RETRIES = RFC64_CATALOG_UNFINISHED_REPLAY_MAX_RETRIES_V1;
  /** Far past any backoff of a 100 ms debounce: 100, 200, 400 and 800 ms, with jitter. */
  const LONG_AFTER = 60_000;

  function fixture(options: {
    connected?: () => readonly string[];
    replay?: () => Promise<{ failed: number }>;
    selected?: () => readonly string[];
    fenceFree?: () => boolean;
  } = {}) {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const replay = vi.fn(options.replay ?? (async () => ({ failed: 1 })));
    const release = vi.fn();
    const reserveFence = vi.fn((_cg: string, peerId: string) => (options.fenceFree?.() === false ? null : {
      peerId, generation: 1, handle: {}, isCurrent: () => true, admit: () => undefined, release,
    }));
    const runtime = makeRuntime({
      selectContextGraphIds: options.selected ?? (() => ['cg']),
      admittedConnectedPeerIds: options.connected ?? (() => ['peer']),
      reserveDeferredFence: () => null,
      reserveFence,
      reannounce: vi.fn(async () => ({ failed: 0 })),
      replay,
      warn: vi.fn(),
    }, 100);
    return { runtime, replay, reserveFence, release };
  }

  it('is tried again on its backoff, a bounded number of times, and then left to full passes', async () => {
    const { runtime, replay } = fixture();
    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    expect(replay).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(replay, 'not before the first backoff has passed').toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(replay).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    await vi.advanceTimersByTimeAsync(10 * LONG_AFTER);
    expect(replay, 'the bound holds, however long the peer stays connected').toHaveBeenCalledTimes(1 + MAX_RETRIES);
  });

  it('stays within the runtime\'s two slots, however many peers have one waiting', async () => {
    const peers = ['peer-a', 'peer-b', 'peer-c', 'peer-d', 'peer-e'];
    let running = 0;
    let most = 0;
    const { runtime, replay } = fixture({
      connected: () => peers,
      replay: async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
        return { failed: 1 };
      },
    });
    for (const peer of peers) runtime.prepareConnectionOpen(peer)!.admit();
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(replay).toHaveBeenCalledTimes(peers.length * (1 + MAX_RETRIES));
    expect(most).toBe(2);
  });

  it('is tried once more only, when that attempt finishes', async () => {
    const results = [{ failed: 1 }, { failed: 0 }];
    const { runtime, replay } = fixture({ replay: async () => results.shift() ?? { failed: 0 } });
    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(replay).toHaveBeenCalledTimes(2);
  });

  it('is not tried again when it finished the first time', async () => {
    const { runtime, replay } = fixture({ replay: async () => ({ failed: 0 }) });
    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('holds no fence while its retry waits, so the graph\'s replay is not held open', async () => {
    const { runtime, reserveFence, release } = fixture();
    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(50);
    expect(reserveFence).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(runtime.status().pendingScopes).toBe(0);
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(reserveFence).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    expect(release).toHaveBeenCalledTimes(1 + MAX_RETRIES);
  });

  it('is not tried again once the peer has left, and a later connection brings its own attempts', async () => {
    const { runtime, replay } = fixture();
    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    runtime.disconnected('peer');
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(replay).toHaveBeenCalledTimes(1);

    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(replay).toHaveBeenCalledTimes(1 + 1 + MAX_RETRIES);
  });

  it('is tried again on the new connection when its demand waited for a fence across a reconnect', async () => {
    let fenceFree = false;
    const { runtime, replay } = fixture({ fenceFree: () => fenceFree });
    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    expect(replay).not.toHaveBeenCalled();
    runtime.disconnected('peer');
    expect(runtime.prepareConnectionOpen('peer'), 'the waiting demand serves for the new connection').toBeNull();
    fenceFree = true;
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(replay).toHaveBeenCalledTimes(1 + MAX_RETRIES);
  });

  it('is tried again on the new connection when its demand was queued through a cooldown across a reconnect', async () => {
    const results = [{ failed: 0 }];
    const { runtime, replay } = fixture({ replay: async () => results.shift() ?? { failed: 1 } });
    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    expect(replay).toHaveBeenCalledTimes(1);
    runtime.prepareGraphActivation('peer', 'cg')!.admit();
    runtime.disconnected('peer');
    expect(runtime.prepareConnectionOpen('peer'), 'the queued demand serves for the new connection').toBeNull();
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(replay).toHaveBeenCalledTimes(1 + 1 + MAX_RETRIES);
  });

  it('shares its attempts with the new connection\'s demand when the peer reconnected during the replay', async () => {
    let failFirst!: () => void;
    const results: Array<Promise<{ failed: number }>> = [new Promise((resolve) => { failFirst = () => resolve({ failed: 1 }); })];
    const { runtime, replay } = fixture({ replay: () => results.shift() ?? Promise.resolve({ failed: 1 }) });
    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    expect(replay).toHaveBeenCalledTimes(1);
    runtime.disconnected('peer');
    runtime.prepareConnectionOpen('peer')!.admit();
    failFirst();
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(replay).toHaveBeenCalledTimes(1 + MAX_RETRIES);
  });

  it('is not tried again for a peer that is no longer admitted or listed as connected', async () => {
    const connected: string[] = ['peer'];
    const { runtime, replay } = fixture({ connected: () => connected });
    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    connected.length = 0;
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(replay).toHaveBeenCalledTimes(1);
    connected.push('peer');
    runtime.prepareConnectionOpen('other')!.admit();
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(replay.mock.calls.filter((call) => (call as unknown as [string, { peerId: string }])[1].peerId === 'peer'), 'its retry was dropped, not put off')
      .toHaveLength(1);
  });

  it('is dropped when the graph is no longer selected', async () => {
    let selected: readonly string[] = ['cg'];
    const { runtime, replay } = fixture({ selected: () => selected });
    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    selected = [];
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('shares its attempts with a demand that a graph activation raises on the same connection', async () => {
    const { runtime, replay } = fixture();
    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    runtime.prepareGraphActivation('peer', 'cg')!.admit();
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(replay).toHaveBeenCalledTimes(1 + MAX_RETRIES);
  });

  it('counts a failed run as unfinished when the compatibility announcement alone failed', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const replay = vi.fn(async () => ({ failed: 0 }));
    const reannounce = vi.fn<() => Promise<{ failed: number }>>()
      .mockResolvedValueOnce({ failed: 1 })
      .mockResolvedValue({ failed: 0 });
    const runtime = makeRuntime({
      selectContextGraphIds: () => ['cg'],
      admittedConnectedPeerIds: () => ['peer'],
      reserveDeferredFence: () => null,
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, handle: {}, isCurrent: () => true, admit: () => undefined, release: vi.fn() }),
      reannounce, replay, warn: vi.fn(),
    }, 100);
    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(LONG_AFTER);
    expect(reannounce).toHaveBeenCalledTimes(2);
    expect(replay).toHaveBeenCalledTimes(2);
  });
});

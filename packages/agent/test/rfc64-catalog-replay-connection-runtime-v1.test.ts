import { describe, expect, it, vi } from 'vitest';
import { createRfc64CatalogReplayRecoveryCommandV1 } from '../src/rfc64/catalog-replay-connection-runtime-v1.js';
import { Rfc64CatalogReplayConnectionRuntimeV1 } from
  '../src/rfc64/catalog-replay-connection-runtime-v1.js';

describe('RFC-64 catalog replay connection debounce', () => {
  it('bounds a 59-graph reconnect burst to one stream per peer and two peers per node', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const replay = vi.fn(async () => { await held; return { failed: 0 }; });
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => Array.from({ length: 59 }, (_, i) => `cg-${i}`),
      acquireFence: (_cg, peerId) => ({ peerId, generation: 1, release: vi.fn() }),
      reannounce: vi.fn(async () => undefined), replay, warn: vi.fn(),
    });
    try {
      for (const peer of ['a', 'b', 'c']) runtime.prepare(peer, 0)?.admit();
      await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(2));
      expect(replay.mock.calls.map((call) => call[1].peerId)).toEqual(['a', 'b']);
      for (let i = 1; i <= 20; i++) {
        runtime.peerDisconnected('a');
        expect(runtime.prepare('a', i)).toBeNull();
      }
      expect(replay).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
      expect(replay).toHaveBeenCalledTimes(177);
    }
  });

  it('retains the completed replay cooldown across a short disconnect', async () => {
    const replay = vi.fn(async () => ({ failed: 0 }));
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => ['cg'],
      acquireFence: (_cg, peerId) => ({ peerId, generation: 1, release: vi.fn() }),
      reannounce: vi.fn(async () => undefined), replay, warn: vi.fn(),
    }, 100);
    runtime.prepare('peer', 0)?.admit();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    runtime.peerDisconnected('peer');
    expect(runtime.prepare('peer', 1)).toBeNull();
  });

  it('replays only the newly activated graph without re-announcing unrelated scopes', async () => {
    const replay = vi.fn(async () => ({ failed: 0 }));
    const reannounce = vi.fn(async () => undefined);
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => ['old-cg', 'new-cg'],
      acquireFence: (_cg, peerId) => ({ peerId, generation: 1, release: vi.fn() }),
      reannounce, replay, warn: vi.fn(),
    });
    runtime.prepare('peer', 0, 'new-cg')?.admit();
    await vi.waitFor(() => expect(replay).toHaveBeenCalled());
    expect(replay.mock.calls.map((call) => call[0])).toEqual(['new-cg']);
    expect(reannounce).toHaveBeenCalledWith('peer', 'new-cg', expect.any(AbortSignal));
  });

  it('evicts only the oldest idle peer when the table reaches capacity', async () => {
    const replay = vi.fn(async () => ({ failed: 0 }));
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => ['public-cg'],
      acquireFence: (_contextGraphId, peerId) => ({
        peerId,
        generation: 1,
        release: vi.fn(),
      }),
      reannounce: vi.fn(async () => undefined),
      replay,
      warn: vi.fn(),
    }, 100, 2);

    runtime.prepare('peer-a', 0)?.admit();
    await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
    runtime.prepare('peer-b', 1)?.admit();
    await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
    runtime.prepare('peer-c', 2)?.admit();
    await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));

    expect(runtime.prepare('peer-b', 3)).toBeNull();
    const retriedA = runtime.prepare('peer-a', 3);
    expect(retriedA).not.toBeNull();
    retriedA?.reject();
    expect(replay).toHaveBeenCalledWith('public-cg', {
      peerId: 'peer-a',
      generation: 1,
      release: expect.any(Function),
    }, expect.any(AbortSignal));

    runtime.reset();
    expect(runtime.prepare('peer-b', 4)).not.toBeNull();
  });
});


describe('catalog reconnect work ownership', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };

  it('retains exponential failure backoff and caps it at ten minutes', async () => {
    let now = 10_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const release = vi.fn();
    const replay = vi.fn(async () => ({ failed: 1 }));
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => ['cg'],
      acquireFence: (_cg, peerId) => ({ peerId, generation: 1, release }),
      reannounce: async () => undefined, replay, warn: vi.fn(),
    });
    try {
      let previousDelay = 0;
      for (let attempt = 1; attempt <= 8; attempt++) {
        runtime.prepare('failed-peer', now)?.admit();
        await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
        const status = runtime.status().peers[0];
        const delay = status.nextEligibleAt - now;
        expect(delay).toBeGreaterThanOrEqual(previousDelay);
        expect(delay).toBeLessThanOrEqual(600_000);
        expect(status.failed).toBe(attempt);
        expect(status.startedLastMinute).toBe(1);
        runtime.peerDisconnected('failed-peer');
        expect(runtime.prepare('failed-peer', status.nextEligibleAt - 1)).toBeNull();
        previousDelay = delay;
        now = status.nextEligibleAt;
      }
      expect(replay).toHaveBeenCalledTimes(8);
      expect(release).toHaveBeenCalledTimes(8);
      now += 60_000;
      expect(runtime.status().peers[0].startedLastMinute).toBe(0);
    } finally { clock.mockRestore(); runtime.reset(); }
  });

  it('queues a new activation behind the current stream without overlapping its peer', async () => {
    const held = deferred();
    const calls: string[] = [];
    const replay = vi.fn(async (cg: string) => {
      calls.push(cg);
      if (cg === 'old') await held.promise;
      return { failed: 0 };
    });
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => ['old', 'new'],
      acquireFence: (_cg, peerId) => ({ peerId, generation: 1, release: vi.fn() }),
      reannounce: async () => undefined, replay, warn: vi.fn(),
    });
    try {
      runtime.prepare('peer', Date.now(), 'old')?.admit();
      await vi.waitFor(() => expect(calls).toEqual(['old']));
      runtime.prepare('peer', Date.now(), 'new')?.admit();
      expect(runtime.status().pendingScopes).toBe(2);
      expect(runtime.prepare('peer', Date.now(), 'new')).toBeNull();
      expect(calls).toEqual(['old']);
      held.resolve();
      await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
      expect(calls).toEqual(['old', 'new']);
    } finally { held.resolve(); }
  });

  it('does not evict an active or queued peer at capacity', async () => {
    const held = deferred();
    const release = vi.fn();
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => ['cg'],
      acquireFence: (_cg, peerId) => ({ peerId, generation: 1, release }),
      reannounce: async () => undefined,
      replay: async () => { await held.promise; return { failed: 0 }; }, warn: vi.fn(),
    }, 100, 1);
    try {
      runtime.prepare('a')?.admit();
      await vi.waitFor(() => expect(runtime.status().activePeers).toBe(1));
      expect(runtime.prepare('b')).toBeNull();
      expect(release).not.toHaveBeenCalled();
    } finally {
      held.resolve();
      await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
    }
  });

  it('releases rejected reservations once and handles an unavailable fence', () => {
    const release = vi.fn();
    const acquireFence = vi.fn((_cg: string, peerId: string) =>
      peerId === 'none' ? null : { peerId, generation: 1, release });
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => ['cg'], acquireFence,
      reannounce: vi.fn(), replay: vi.fn(), warn: vi.fn(),
    });
    expect(runtime.prepare('none')).toBeNull();
    const reservation = runtime.prepare('a');
    reservation?.reject(); reservation?.reject(); reservation?.admit();
    expect(release).toHaveBeenCalledTimes(1);
    const retry = runtime.prepare('a');
    expect(retry).not.toBeNull();
    retry?.reject();
    expect(runtime.status().pendingScopes).toBe(0);
    const empty = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => [], acquireFence,
      reannounce: vi.fn(), replay: vi.fn(), warn: vi.fn(),
    });
    expect(empty.prepare('a')).toBeNull();
  });

  it('physically drains a held stream on cancellation and fences queued scopes', async () => {
    const held = deferred();
    const controller = new AbortController();
    let work: ((signal: AbortSignal) => Promise<void>) | undefined;
    const release = vi.fn();
    const replay = vi.fn(async () => { await held.promise; return { failed: 0 }; });
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => ['a', 'b'],
      acquireFence: (_cg, peerId) => ({ peerId, generation: 1, release }),
      reannounce: async () => undefined, replay, warn: vi.fn(),
      schedule: (next) => { work = next; return true; },
    });
    runtime.prepare('peer')?.admit();
    let drained = false;
    const drain = work!(controller.signal).then(() => { drained = true; });
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drained).toBe(false);
    expect(release).not.toHaveBeenCalled();
    held.resolve(); await drain;
    expect(replay).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
    expect(runtime.prepare('peer')).toBeNull();
    expect(runtime.status().pendingScopes).toBe(0);
  });

  it('releases all fences when the background owner refuses admission', () => {
    const release = vi.fn();
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => ['a', 'b'],
      acquireFence: (_cg, peerId) => ({ peerId, generation: 1, release }),
      reannounce: vi.fn(), replay: vi.fn(), warn: vi.fn(), schedule: () => false,
    });
    runtime.prepare('peer')?.admit();
    expect(release).toHaveBeenCalledTimes(2);
    expect(runtime.prepare('peer')).toBeNull();
  });

  it('still requests the authoritative catalog after a compatibility announcement fails', async () => {
    const warn = vi.fn();
    const replay = vi.fn(async () => { throw new Error('catalog unavailable'); });
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => ['cg'],
      acquireFence: (_cg, peerId) => ({ peerId, generation: 1, release: vi.fn() }),
      reannounce: async () => { throw new Error('legacy unavailable'); }, replay, warn,
    });
    runtime.prepare('peer')?.admit();
    await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
    expect(replay).toHaveBeenCalledTimes(1);
    expect(runtime.status().peers[0].failed).toBe(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('legacy unavailable');
    expect(warn.mock.calls.flat().join(' ')).toContain('catalog unavailable');
  });

  it('rotates bounded scope state so graphs beyond the table limit are not starved', async () => {
    let now = 10_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const seen = new Set<string>();
    const runtime = new Rfc64CatalogReplayConnectionRuntimeV1({
      selectContextGraphIds: () => Array.from({ length: 257 }, (_, i) => `cg-${String(i).padStart(3, '0')}`),
      acquireFence: (_cg, peerId) => ({ peerId, generation: 1, release: vi.fn() }),
      reannounce: async () => undefined,
      replay: async (cg) => { seen.add(cg); return { failed: 0 }; }, warn: vi.fn(),
    }, 100);
    try {
      runtime.prepare('peer', now)?.admit();
      await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
      expect(seen.size).toBe(256);
      now += 100;
      runtime.prepare('peer', now)?.admit();
      await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
      expect(seen.size).toBe(257);
    } finally { clock.mockRestore(); runtime.reset(); }
  });

  it('keeps command-specific peer selection lazy and preserves the exact fence and signal', () => {
    const connected = vi.fn(() => ['peer']);
    const signal = new AbortController().signal;
    const scope = { contextGraphId: 'cg', policyDigest: 'digest', signal };
    const demand = { peerId: 'peer', generation: 4 };
    expect(createRfc64CatalogReplayRecoveryCommandV1(scope,
      { kind: 'pending-recovery' }, connected)).toEqual({ ...scope, kind: 'pending-recovery' });
    const command = createRfc64CatalogReplayRecoveryCommandV1(scope,
      { kind: 'connection-demand', replayDemand: demand }, connected);
    expect(command).toEqual({ ...scope, kind: 'connection-demand', demand });
    if (command.kind === 'connection-demand') expect(command.demand).toBe(demand);
    expect(connected).not.toHaveBeenCalled();
    expect(createRfc64CatalogReplayRecoveryCommandV1(scope,
      { kind: 'connected-peers' }, connected)).toEqual({ ...scope,
      kind: 'full-connected-peers', connectedPeerIds: ['peer'] });
    expect(connected).toHaveBeenCalledTimes(1);
  });
});

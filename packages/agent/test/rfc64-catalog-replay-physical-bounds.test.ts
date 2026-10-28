import { createCatalogReplayTransportV1 } from '../src/rfc64/catalog-replay-transport-v1.js';
import { describe, expect, it, vi } from 'vitest';
import { Rfc64CatalogReplayRecoveryRuntimeV1 } from '../src/rfc64/catalog-replay-recovery-runtime-v1.js';
import { CatalogReplayPeerLaneV1 } from '../src/rfc64/catalog-replay-peer-lane-v1.js';
import { makeRuntime } from './_helpers/catalog-connection-runtime.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('physical catalog replay capacity', () => {
  it.each(['connection', 'activation'] as const)('resumes every peer in a 257-peer %s burst without another event', async kind => {
    const peers = Array.from({ length: 257 }, (_, i) => `peer-${String(i).padStart(3, '0')}`);
    const requested = new Set<string>();
    const held = deferred();
    const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({
      requestPeer: async (_cg, peer) => { await held.promise; requested.add(peer); return { status: 'completed', targets: [] }; },
      whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target,
      parityFailed: async () => false,
    });
    const runtime = makeRuntime({ admittedConnectedPeerIds: () => peers, selectContextGraphIds: () => ['cg'],
      reserveFence: (cg, peer) => recovery.reservePeer(cg, 'p', peer),
      reannounce: async () => ({ failed: 0 }), warn: vi.fn(),
      replay: (cg, demand, signal) => recovery.request({ contextGraphId: cg, policyDigest: 'p', kind: 'connection-demand', demand, signal }),
    });
    try {
      for (const peer of peers) {
        const reservation = kind === 'connection' ? runtime.prepareConnectionOpen(peer)
          : runtime.prepareGraphActivation(peer, 'cg');
        expect(reservation).not.toBeNull(); reservation?.admit();
      }
      expect(runtime.status().peers).toHaveLength(256);
      held.resolve();
      await vi.waitFor(() => expect(requested.size).toBe(257), { timeout: 5000 });
      await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
      expect([...requested].sort()).toEqual(peers);
      expect(runtime.status().peers.length).toBeLessThanOrEqual(256);
    } finally { held.resolve(); }
  });

  it('keeps an overflow graph activation scoped to that graph', async () => {
    const held = deferred();
    const replay = vi.fn(async (_cg: string, demand: { peerId: string }) => {
      if (demand.peerId === 'a') await held.promise;
      return { failed: 0 };
    });
    const announce = vi.fn(async (_peer: string, _cg: string) => ({ failed: 0 }));
    const runtime = makeRuntime({ admittedConnectedPeerIds: () => ['a', 'b'],
      selectContextGraphIds: () => ['old', 'new'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit() {}, release() {} }),
      reannounce: announce, replay, warn: vi.fn(),
    }, 60_000, 1);
    try {
      runtime.prepareGraphActivation('a', 'new')!.admit();
      await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
      runtime.prepareGraphActivation('b', 'new')!.admit();
      held.resolve();
      await vi.waitFor(() => expect(replay.mock.calls.some(([, demand]) => demand.peerId === 'b')).toBe(true));
      await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
      expect(replay.mock.calls.map(([cg]) => cg)).toEqual(['new', 'new']);
      expect(announce.mock.calls.map(call => call[1])).toEqual(['new', 'new']);
    } finally { held.resolve(); }
  });

  it('wakes admitted overflow after every occupying reservation is rejected', async () => {
    const replay = vi.fn(async () => ({ failed: 0 }));
    const runtime = makeRuntime({ admittedConnectedPeerIds: () => ['a', 'b'], selectContextGraphIds: () => ['cg'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit() {}, release() {} }),
      reannounce: async () => ({ failed: 0 }), replay, warn: vi.fn(),
    }, 60_000, 1);
    const occupying = runtime.prepareConnectionOpen('a')!;
    runtime.prepareConnectionOpen('b')!.admit();
    // Let both scheduled workers discover that no occupying peer is runnable.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(replay).not.toHaveBeenCalled();
    occupying.reject();
    await vi.waitFor(() => expect(replay.mock.calls.some(([, demand]) => demand.peerId === 'b')).toBe(true));
    await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
  });

  it.each(['pending', 'rejected'] as const)('does not resume %s topology peers when another overflow peer is admitted', async state => {
    const accepted = new Set<string>();
    const topology = ['a', 'b', 'c'];
    const replay = vi.fn(async (_cg: string, _demand: { peerId: string }) => ({ failed: 0 }));
    const fences = vi.fn((_cg: string, peerId: string) => ({ peerId, generation: 1, admit() {}, release() {} }));
    const runtime = makeRuntime({ admittedConnectedPeerIds: () => topology.filter(peer => accepted.has(peer)),
      selectContextGraphIds: () => ['cg'], reserveFence: fences,
      reannounce: async () => ({ failed: 0 }), replay, warn: vi.fn(),
    }, 60_000, 1);
    const occupying = runtime.prepareConnectionOpen('a')!;
    const other = runtime.prepareConnectionOpen('b')!;
    if (state === 'rejected') other.reject();
    const admitted = runtime.prepareConnectionOpen('c')!;
    accepted.add('c'); admitted.admit();
    occupying.reject();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
    expect(replay.mock.calls.map(([, demand]) => demand.peerId)).toEqual(['c']);
    expect(fences.mock.calls.map(([, peer]) => peer)).not.toContain('b');
    other.reject();
  });

  it('retains replay completion and active state until aborted running transports drain', async () => {
    const held = deferred(), controller = new AbortController();
    const called: string[] = [];
    const transport = createCatalogReplayTransportV1<never>({
      requestPeer: async (_cg, peer) => { called.push(peer); await held.promise; return { status: 'completed', targets: [] }; },
      reannounce: async () => ({ failed: 0 }),
    });
    const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({ requestPeer: transport.requestPeer,
      whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target, parityFailed: async () => false });
    let settled = false;
    const run = recovery.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'full-connected-peers',
      connectedPeerIds: ['a', 'b', 'c'], signal: controller.signal });
    const rejected = expect(run).rejects.toThrow('shutdown');
    void run.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.waitFor(() => expect(called).toHaveLength(2));
      controller.abort(new Error('shutdown'));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      expect(recovery.status('cg', 'p')?.active).toBe(true);
      expect(called).toEqual(['a', 'b']);
    } finally { held.resolve(); await rejected; }
    expect(recovery.status('cg', 'p')?.active).toBe(false);
    expect(called).toEqual(['a', 'b']);
  });

  it('limits actual announcement and recovery requests with retained provider fan-out across graphs', async () => {
    let seeding = true;
    let active = 0, peak = 0;
    const perPeer = new Map<string, number>();
    const peaks = new Map<string, number>();
    const physical: string[] = [];
    const held = deferred();
    async function operation(peer: string, kind: string) {
      physical.push(`${kind}:${peer}`); active++; peak = Math.max(peak, active);
      const count = (perPeer.get(peer) ?? 0) + 1; perPeer.set(peer, count);
      peaks.set(peer, Math.max(peaks.get(peer) ?? 0, count));
      try { await held.promise; }
      finally { active--; perPeer.set(peer, perPeer.get(peer)! - 1); }
    }
    const transport = createCatalogReplayTransportV1<never>({
      requestPeer: async (_cg, peer) => {
        if (seeding) throw new Error('retained provider unavailable');
        await operation(peer, 'request'); return { status: 'completed', targets: [] };
      },
      reannounce: async peer => { await operation(peer, 'announcement'); return { failed: 0 }; },
    });
    const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({ requestPeer: transport.requestPeer,
      whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target, parityFailed: async () => false });
    for (const cg of ['g1', 'g2']) {
      await recovery.request({ contextGraphId: cg, policyDigest: 'p', kind: 'full-connected-peers', connectedPeerIds: ['a', 'b'] });
      expect(recovery.status(cg, 'p')?.unresolvedPeerCount).toBe(2);
    }
    seeding = false;
    const runtime = makeRuntime({ selectContextGraphIds: () => ['g1', 'g2'],
      reserveFence: (cg, peer) => recovery.reservePeer(cg, 'p', peer), warn: vi.fn(),
      reannounce: (peer, _cg, signal) => transport.reannounce(peer, {} as never, signal),
      replay: (cg, demand, signal) => recovery.request({ contextGraphId: cg, policyDigest: 'p', kind: 'connection-demand', demand, signal }),
    });
    try {
      runtime.prepareConnectionOpen('c')!.admit(); runtime.prepareConnectionOpen('d')!.admit();
      await vi.waitFor(() => expect(active).toBe(2));
      held.resolve();
      await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
      expect(physical).toContain('request:a'); expect(physical).toContain('request:b');
      expect(physical).toContain('request:c'); expect(physical).toContain('request:d');
      expect(physical).toContain('announcement:c'); expect(physical).toContain('announcement:d');
      expect(peak).toBe(2); expect([...peaks.values()]).toEqual(expect.arrayContaining([1]));
      expect([...peaks.values()].every(count => count === 1)).toBe(true);
    } finally { held.resolve(); }
  });

  it('cancels queued work while retaining physical custody of an aborted active operation', async () => {
    const lane = new CatalogReplayPeerLaneV1(); const held = deferred();
    const active = new AbortController(); const queued = new AbortController();
    const first = lane.run('a', active.signal, () => held.promise);
    const skipped = vi.fn(async () => {});
    const pending = lane.run('a', queued.signal, skipped);
    const rejected = expect(pending).rejects.toThrow('queued cancelled');
    await Promise.resolve();
    active.abort(new Error('active cancelled')); queued.abort(new Error('queued cancelled')); await rejected;
    const next = vi.fn(async () => {}); const following = lane.run('a', undefined, next);
    await Promise.resolve(); expect(next).not.toHaveBeenCalled(); expect(skipped).not.toHaveBeenCalled();
    held.resolve(); await first; await following; expect(next).toHaveBeenCalledOnce();
  });
});

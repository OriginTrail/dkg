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
    const runtime = makeRuntime({ connectedPeerIds: () => peers, selectContextGraphIds: () => ['cg'],
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
    const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({
      requestPeer: async (_cg, peer) => {
        if (seeding) throw new Error('retained provider unavailable');
        await operation(peer, 'request'); return { status: 'completed', targets: [] };
      },
      whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target,
      parityFailed: async () => false,
    });
    for (const cg of ['g1', 'g2']) {
      await recovery.request({ contextGraphId: cg, policyDigest: 'p', kind: 'full-connected-peers', connectedPeerIds: ['a', 'b'] });
      expect(recovery.status(cg, 'p')?.unresolvedPeerCount).toBe(2);
    }
    seeding = false;
    const runtime = makeRuntime({ selectContextGraphIds: () => ['g1', 'g2'],
      reserveFence: (cg, peer) => recovery.reservePeer(cg, 'p', peer), warn: vi.fn(),
      reannounce: (peer, _cg, signal) => recovery.runPeerTransport(peer, signal, async () => {
        await operation(peer, 'announcement'); return { failed: 0 };
      }),
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

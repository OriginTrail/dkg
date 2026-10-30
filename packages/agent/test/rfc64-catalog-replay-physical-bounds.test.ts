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
      reserveDeferredFence: () => null, reserveFence: (cg, peer) => recovery.reservePeer(cg, 'p', peer),
      reannounce: async () => ({ failed: 0 }), warn: vi.fn(),
      replay: (cg, demand, signal) => recovery.request({ contextGraphId: cg, policyDigest: 'p', kind: 'connection-demand', demand, executionOwner: { signal } }),
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
      reserveDeferredFence: () => null, reserveFence: (_cg, peerId) => ({ peerId, generation: 1, handle: {}, isCurrent: () => true, admit() {}, release() {} }),
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

  it('retains full overflow coverage when activation installs the peer first', async () => {
    const replay = vi.fn(async (_cg: string, _demand: { peerId: string }) => ({ failed: 0 }));
    const runtime = makeRuntime({ admittedConnectedPeerIds: () => ['b'], selectContextGraphIds: () => ['old', 'new'],
      reserveDeferredFence: () => null, reserveFence: (_cg, peerId) => ({ peerId, generation: 1, handle: {}, isCurrent: () => true, admit() {}, release() {} }),
      reannounce: async () => ({ failed: 0 }), replay, warn: vi.fn(),
    }, 60_000, 1);
    const occupying = runtime.prepareConnectionOpen('a')!;
    runtime.prepareGraphActivation('b', 'new')!.admit();
    runtime.prepareConnectionOpen('b')!.admit();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(replay).not.toHaveBeenCalled();
    occupying.reject();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
    expect(replay.mock.calls.map(([cg]) => cg).sort()).toEqual(['new', 'old']);
    expect(replay.mock.calls.map(([, demand]) => demand.peerId)).toEqual(['b', 'b']);
    expect(runtime.status().peers).toHaveLength(1);
  });

  it('wakes admitted overflow after every occupying reservation is rejected', async () => {
    const replay = vi.fn(async () => ({ failed: 0 }));
    const runtime = makeRuntime({ admittedConnectedPeerIds: () => ['a', 'b'], selectContextGraphIds: () => ['cg'],
      reserveDeferredFence: () => null, reserveFence: (_cg, peerId) => ({ peerId, generation: 1, handle: {}, isCurrent: () => true, admit() {}, release() {} }),
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
    const fences = vi.fn((_cg: string, peerId: string) => ({ peerId, generation: 1, handle: {}, isCurrent: () => true, admit() {}, release() {} }));
    const runtime = makeRuntime({ admittedConnectedPeerIds: () => topology.filter(peer => accepted.has(peer)),
      selectContextGraphIds: () => ['cg'], reserveDeferredFence: () => null, reserveFence: fences,
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
      connectedPeerIds: ['a', 'b', 'c'], executionOwner: { signal: controller.signal } });
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
      reserveDeferredFence: () => null, reserveFence: (cg, peer) => recovery.reservePeer(cg, 'p', peer), warn: vi.fn(),
      reannounce: (peer, _cg, signal) => transport.reannounce(peer, {} as never, signal),
      replay: (cg, demand, signal) => recovery.request({ contextGraphId: cg, policyDigest: 'p', kind: 'connection-demand', demand, executionOwner: { signal } }),
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


it.each(['clear', 'reset', 'policy replacement'] as const)('retires queued connection demand on %s while the old physical chunk drains', async mode => {
  const held = deferred();
  const requested: string[] = [];
  const peers = Array.from({ length: 64 }, (_, i) => `budget-${i}`);
  const heldPeers = new Set(peers.slice(-4));
  const physical = new Set<string>();
  const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({
    requestPeer: async (_cg, peer) => {
      requested.push(peer);
      // Spend all 64 demand records without requiring 64 concurrent providers.
      // The final four retain physical custody behind the agent-wide admission gate.
      if (heldPeers.has(peer)) {
        physical.add(peer);
        try { await held.promise; } finally { physical.delete(peer); }
      }
      return { status: 'completed', targets: [] };
    },
    whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target, parityFailed: async () => false,
  });
  let fullSettled = false;
  const full = recovery.request({ contextGraphId: 'cg', policyDigest: 'old', kind: 'full-connected-peers', connectedPeerIds: peers });
  void full.then(() => { fullSettled = true; });
  const replay = vi.fn((cg: string, demand: { peerId: string; generation: number; handle: object }, signal: AbortSignal) =>
    recovery.request({ contextGraphId: cg, policyDigest: 'old', kind: 'connection-demand', demand, executionOwner: { signal } }));
  const connection = makeRuntime({ selectContextGraphIds: () => ['cg'], reserveDeferredFence: () => null,
    reserveFence: (cg, peer) => recovery.reservePeer(cg, 'old', peer),
    reannounce: async () => ({ failed: 0 }), replay, warn: vi.fn() });
  try {
    await vi.waitFor(() => expect(requested).toHaveLength(64));
    expect(physical.size).toBe(4);
    connection.prepareConnectionOpen('queued-65')!.admit();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    expect(connection.status().activePeers).toBe(1);
    if (mode === 'clear') recovery.clear('cg');
    else if (mode === 'reset') recovery.reset();
    else recovery.reserveDeferred('cg', 'next').release();
    await vi.waitFor(() => expect(connection.status().activePeers).toBe(0));
    expect(connection.status().pendingScopes).toBe(0);
    expect(fullSettled).toBe(false); // A running chunk keeps its physical completion custody.
    expect(requested).not.toContain('queued-65');
    const currentRevision = recovery.revisionForContextGraph('cg');
    held.resolve(); await full;
    expect(recovery.revisionForContextGraph('cg')).toBe(currentRevision);
    expect(recovery.status('cg', 'old')).toBeNull();
  } finally { held.resolve(); await full; }
});

it.each(['policy replacement', 'clear', 'reset'] as const)('requests the newer head after stale admission crosses %s', async mode => {
  let policy = 'A', head = 'H1';
  const held = deferred();
  const requested: string[] = [];
  const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<string>({
    requestPeer: async (_cg, peer) => { requested.push(`${peer}:${head}`); if (head === 'H2') await held.promise;
      return { status: 'completed', targets: [head] }; },
    whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target, parityFailed: async () => false,
  });
  const connection = makeRuntime({ selectContextGraphIds: () => ['cg'], reserveDeferredFence: () => null,
    reserveFence: (cg, peer) => recovery.reservePeer(cg, policy, peer),
    reannounce: async () => ({ failed: 0 }),
    replay: (cg, demand, signal) => recovery.request({ contextGraphId: cg, policyDigest: policy, kind: 'connection-demand', demand, executionOwner: { signal } }),
    warn: vi.fn() });
  try {
  const pending = connection.prepareConnectionOpen('peer')!;
  if (mode === 'clear') recovery.clear('cg');
  else if (mode === 'reset') recovery.reset();
  else policy = 'B';
  await recovery.request({ contextGraphId: 'cg', policyDigest: policy, kind: 'full-connected-peers', connectedPeerIds: ['peer'] });
  expect(requested).toEqual(['peer:H1']);
  head = 'H2';
  connection.disconnected('peer');
  const replacement = connection.prepareConnectionOpen('peer')!;
  expect(recovery.status('cg', policy)?.active).toBe(true);
  pending.reject(); // The old callback cannot release the fresh owner's fence.
  expect(recovery.status('cg', policy)?.active).toBe(true);
  replacement.admit();
  await vi.waitFor(() => expect(requested).toEqual(['peer:H1', 'peer:H2']));
  expect(recovery.status('cg', policy)?.active).toBe(true);
  held.resolve();
  await vi.waitFor(() => expect(connection.status().pendingScopes).toBe(0));
  expect(requested).toEqual(['peer:H1', 'peer:H2']);
  expect(recovery.promisedTargets('cg', policy)).toContain('H2');
  expect(recovery.status('cg', policy)?.active).toBe(false);
  } finally { held.resolve(); connection.reset(); }
});


it.each([true, false])('keeps an independently owned reconnect after full replay cancellation=%s', async cancel => {
  const held = deferred(), nextHeld = deferred(), controller = new AbortController();
  const requested: string[] = [];
  const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<string>({
    requestPeer: async (_cg, peer) => { requested.push(peer); await (peer === 'old' ? held.promise : nextHeld.promise);
      return { status: 'completed', targets: [peer === 'old' ? 'H1' : 'H2'] }; },
    whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target, parityFailed: async () => false,
  });
  const full = recovery.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'full-connected-peers', connectedPeerIds: ['old'], executionOwner: { signal: controller.signal } });
  const completion = cancel ? expect(full).rejects.toThrow('full cancelled') : expect(full).resolves.toMatchObject({ failed: 0 });
  const replay = vi.fn((cg: string, demand: { peerId: string; generation: number; handle: object }, signal: AbortSignal) =>
    recovery.request({ contextGraphId: cg, policyDigest: 'p', kind: 'connection-demand', demand, executionOwner: { signal } }));
  const connection = makeRuntime({ selectContextGraphIds: () => ['cg'], reserveDeferredFence: () => null,
    reserveFence: (cg, peer) => recovery.reservePeer(cg, 'p', peer), reannounce: async () => ({ failed: 0 }), replay, warn: vi.fn() });
  try {
    await vi.waitFor(() => expect(requested).toEqual(['old']));
    connection.prepareConnectionOpen('live')!.admit();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    if (cancel) controller.abort(new Error('full cancelled'));
    expect(recovery.status('cg', 'p')?.active).toBe(true);
    expect(connection.status().activePeers).toBe(1);
    held.resolve(); await completion;
    await vi.waitFor(() => expect(requested).toEqual(['old', 'live']));
    expect(recovery.status('cg', 'p')?.active).toBe(true);
    expect(connection.status().activePeers).toBe(1);
    nextHeld.resolve();
    await vi.waitFor(() => expect(connection.status().pendingScopes).toBe(0));
    expect(recovery.promisedTargets('cg', 'p')).toContain('H2');
    expect(recovery.status('cg', 'p')?.active).toBe(false);
  } finally { held.resolve(); nextHeld.resolve(); connection.reset(); await completion; }
});


it('derives idle status from custody while retaining budget-exhausted retry work', async () => {
  let requested = 0;
  const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({
    requestPeer: async () => { requested++; recovery.markPeerPending('cg', 'p', 'peer'); return { status: 'completed', targets: [] }; },
    whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target, parityFailed: async () => false,
  });
  await recovery.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'full-connected-peers', connectedPeerIds: ['peer'] });
  expect(requested).toBe(64);
  expect(recovery.status('cg', 'p')).toMatchObject({ active: false, failed: true });
  const deferred = recovery.reserveDeferred('cg', 'p');
  expect(recovery.status('cg', 'p')?.active).toBe(true);
  deferred.release();
  expect(recovery.status('cg', 'p')?.active).toBe(false);
});

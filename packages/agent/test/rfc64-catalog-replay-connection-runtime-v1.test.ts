import { RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1 } from '../src/rfc64/public-catalog-transport-v1.js';
import { createRfc64CatalogReplayConnectionRuntimeV1 } from '../src/rfc64/catalog-replay-connection-adapter-v1.js';
import { buildOpenOwnerContextGraphPolicyV1, computeOpenContextGraphPolicyDigestV1 } from '../src/rfc64/open-catalog-policy-v1.js';
import { RFC64_ROLLOUT_AUTHOR, RFC64_ROLLOUT_CONTEXT_GRAPH_ID, RFC64_ROLLOUT_NETWORK_ID } from './_helpers/rfc64-rollout-agent-harness.js';
import { Rfc64CatalogReplayRecoveryRuntimeV1 } from '../src/rfc64/catalog-replay-recovery-runtime-v1.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rfc64CatalogReplayConnectionRuntimeV1, type Rfc64CatalogReplayConnectionRuntimePortsV1 } from
  '../src/rfc64/catalog-replay-connection-runtime-v1.js';
import { Rfc64BackgroundWorkDispatcherV1 } from '../src/rfc64/background-work-dispatcher-v1.js';

const owners: Rfc64BackgroundWorkDispatcherV1[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.closeAndDrain()));
  vi.useRealTimers();
});

function makeRuntime(ports: Omit<Rfc64CatalogReplayConnectionRuntimePortsV1, 'schedule' | 'wait'>
  & Partial<Pick<Rfc64CatalogReplayConnectionRuntimePortsV1, 'schedule' | 'wait'>>,
  debounceMs?: number, maxPeers?: number): Rfc64CatalogReplayConnectionRuntimeV1 {
  const owner = new Rfc64BackgroundWorkDispatcherV1(); owners.push(owner);
  return new Rfc64CatalogReplayConnectionRuntimeV1({
    schedule: (slot, work) => owner.scheduleKeyed(`replay:${slot}`, work),
    wait: (signal, delay) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
    }),
    ...ports,
  }, debounceMs, maxPeers);
}

describe('RFC-64 catalog replay connection debounce', () => {
  it('bounds a 59-graph reconnect burst to one stream per peer and two peers per node', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const replay = vi.fn(async () => { await held; return { failed: 0 }; });
    const runtime = makeRuntime({
      selectContextGraphIds: () => Array.from({ length: 59 }, (_, i) => `cg-${i}`),
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release: vi.fn() }),
      reannounce: vi.fn(async () => ({ failed: 0 })), replay, warn: vi.fn(),
    });
    try {
      for (const peer of ['a', 'b', 'c']) runtime.prepareConnectionOpen(peer, 0)?.admit();
      await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(2));
      expect(replay.mock.calls.map((call) => call[1].peerId)).toEqual(['a', 'b']);
      for (let i = 1; i <= 20; i++) {
        expect(runtime.prepareConnectionOpen('a', i)).toBeNull();
      }
      expect(replay).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
      expect(replay).toHaveBeenCalledTimes(177);
    }
  });

  it('retains reconnect demand and executes only at the completed cooldown boundary', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const owner = new Rfc64BackgroundWorkDispatcherV1(); owners.push(owner);
    const replay = vi.fn(async () => ({ failed: 0 }));
    const runtime = makeRuntime({
      selectContextGraphIds: () => ['cg'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release: vi.fn() }),
      reannounce: vi.fn(async () => ({ failed: 0 })), replay, warn: vi.fn(),
      schedule: (slot, work) => owner.scheduleKeyed(`replay:${slot}`, work),
    }, 100);
    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.status().pendingScopes).toBe(0);
    const deferred = runtime.prepareConnectionOpen('peer');
    expect(deferred).not.toBeNull(); deferred?.admit();
    await vi.advanceTimersByTimeAsync(99);
    expect(replay).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(replay).toHaveBeenCalledTimes(2);
    expect(runtime.status().pendingScopes).toBe(0);
  });

  it('replays only the newly activated graph without re-announcing unrelated scopes', async () => {
    const replay = vi.fn(async () => ({ failed: 0 }));
    const reannounce = vi.fn(async () => ({ failed: 0 }));
    const runtime = makeRuntime({
      selectContextGraphIds: () => ['old-cg', 'new-cg'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release: vi.fn() }),
      reannounce, replay, warn: vi.fn(),
    });
    runtime.prepareGraphActivation('peer', 'new-cg', 0)?.admit();
    await vi.waitFor(() => expect(replay).toHaveBeenCalled());
    expect(replay.mock.calls.map((call) => call[0])).toEqual(['new-cg']);
    expect(reannounce).toHaveBeenCalledWith('peer', 'new-cg', expect.any(AbortSignal));
  });

  it('evicts only the oldest idle peer when the table reaches capacity', async () => {
    const replay = vi.fn(async () => ({ failed: 0 }));
    const runtime = makeRuntime({
      selectContextGraphIds: () => ['public-cg'],
      reserveFence: (_contextGraphId, peerId) => ({
        peerId,
        generation: 1,
        admit: () => undefined,
        release: vi.fn(),
      }),
      reannounce: vi.fn(async () => ({ failed: 0 })),
      replay,
      warn: vi.fn(),
    }, 100, 2);

    runtime.prepareConnectionOpen('peer-a', 0)?.admit();
    await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
    runtime.prepareConnectionOpen('peer-b', 1)?.admit();
    await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
    runtime.prepareConnectionOpen('peer-c', 2)?.admit();
    await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));

    const coolingB = runtime.prepareConnectionOpen('peer-b', 3);
    expect(coolingB).not.toBeNull(); coolingB?.reject();
    const retriedA = runtime.prepareConnectionOpen('peer-a', 3);
    expect(retriedA).not.toBeNull();
    retriedA?.reject();
    expect(replay).toHaveBeenCalledWith('public-cg', {
      peerId: 'peer-a',
      generation: 1,
      admit: expect.any(Function),
      release: expect.any(Function),
    }, expect.any(AbortSignal));

    runtime.reset();
    expect(runtime.prepareConnectionOpen('peer-b', 4)).not.toBeNull();
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
    const runtime = makeRuntime({
      selectContextGraphIds: () => ['cg'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release }),
      reannounce: async () => ({ failed: 0 }), replay, warn: vi.fn(),
    });
    try {
      let previousDelay = 0;
      for (let attempt = 1; attempt <= 8; attempt++) {
        runtime.prepareConnectionOpen('failed-peer', now)?.admit();
        await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
        const status = runtime.status().peers[0];
        const delay = status.nextEligibleAt - now;
        const base = Math.min(600_000, 60_000 * 2 ** (attempt - 1));
        expect(delay).toBeGreaterThanOrEqual(base);
        expect(delay).toBeLessThanOrEqual(Math.min(600_000, Math.floor(base * 1.25)));
        if (attempt <= 4) expect(delay).toBeGreaterThan(previousDelay);
        if (attempt >= 5) expect(delay).toBe(600_000);
        expect(delay).toBeLessThanOrEqual(600_000);
        expect(status.failed).toBe(attempt);
        expect(status.startedLastMinute).toBe(1);
        const cooling = runtime.prepareConnectionOpen('failed-peer', status.nextEligibleAt - 1);
        expect(cooling).not.toBeNull(); cooling?.reject();
        previousDelay = delay;
        now = status.nextEligibleAt;
      }
      expect(replay).toHaveBeenCalledTimes(8);
      expect(release).toHaveBeenCalledTimes(16);
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
    const runtime = makeRuntime({
      selectContextGraphIds: () => ['old', 'new'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release: vi.fn() }),
      reannounce: async () => ({ failed: 0 }), replay, warn: vi.fn(),
    });
    try {
      runtime.prepareGraphActivation('peer', 'old', Date.now())?.admit();
      await vi.waitFor(() => expect(calls).toEqual(['old']));
      runtime.prepareGraphActivation('peer', 'new', Date.now())?.admit();
      expect(runtime.status().pendingScopes).toBe(2);
      expect(runtime.prepareGraphActivation('peer', 'new', Date.now())).toBeNull();
      expect(calls).toEqual(['old']);
      held.resolve();
      await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
      expect(calls).toEqual(['old', 'new']);
    } finally { held.resolve(); }
  });

  it('hands a completion-time admission to the keyed background owner', async () => {
    const release = vi.fn();
    const calls: string[] = [];
    let next: Rfc64CatalogReplayConnectionRuntimeV1;
    next = makeRuntime({
      selectContextGraphIds: () => ['old', 'new'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release }),
      reannounce: async () => ({ failed: 0 }),
      replay: async cg => {
        calls.push(cg);
        if (cg === 'old') queueMicrotask(() => next.prepareGraphActivation('peer', 'new', Date.now())?.admit());
        return { failed: 0 };
      }, warn: vi.fn(),
    });
    next.prepareGraphActivation('peer', 'old', Date.now())!.admit();
    await vi.waitFor(() => expect(calls).toEqual(['old', 'new']));
    expect(release).toHaveBeenCalledTimes(2);
    expect(next.status().pendingScopes).toBe(0);
  });

  it('does not evict an active or queued peer at capacity', async () => {
    const held = deferred();
    const release = vi.fn();
    const runtime = makeRuntime({
      selectContextGraphIds: () => ['cg'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release }),
      reannounce: async () => ({ failed: 0 }),
      replay: async () => { await held.promise; return { failed: 0 }; }, warn: vi.fn(),
    }, 100, 1);
    try {
      runtime.prepareConnectionOpen('a')?.admit();
      await vi.waitFor(() => expect(runtime.status().activePeers).toBe(1));
      expect(runtime.prepareConnectionOpen('b')).toBeNull();
      expect(release).not.toHaveBeenCalled();
    } finally {
      held.resolve();
      await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
    }
  });

  it('releases rejected reservations once and handles an unavailable fence', () => {
    const release = vi.fn();
    const reserveFence = vi.fn((_cg: string, peerId: string) =>
      peerId === 'none' ? null : { peerId, generation: 1, admit: () => undefined, release });
    const runtime = makeRuntime({
      selectContextGraphIds: () => ['cg'], reserveFence,
      reannounce: vi.fn(), replay: vi.fn(), warn: vi.fn(),
    });
    const unavailable = runtime.prepareConnectionOpen('none');
    expect(unavailable).not.toBeNull(); unavailable?.reject();
    const reservation = runtime.prepareConnectionOpen('a');
    reservation?.reject(); reservation?.reject(); reservation?.admit();
    expect(release).toHaveBeenCalledTimes(1);
    const retry = runtime.prepareConnectionOpen('a');
    expect(retry).not.toBeNull();
    retry?.reject();
    expect(runtime.status().pendingScopes).toBe(0);
    const empty = makeRuntime({
      selectContextGraphIds: () => [], reserveFence,
      reannounce: vi.fn(), replay: vi.fn(), warn: vi.fn(),
    });
    expect(empty.prepareConnectionOpen('a')).toBeNull();
  });

  it('physically drains a held stream on cancellation and fences queued scopes', async () => {
    const held = deferred();
    const owner = new Rfc64BackgroundWorkDispatcherV1();
    const release = vi.fn();
    const replay = vi.fn(async () => { await held.promise; return { failed: 0 }; });
    const next = makeRuntime({
      selectContextGraphIds: () => ['a', 'b'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release }),
      reannounce: async () => ({ failed: 0 }), replay, warn: vi.fn(),
      schedule: (slot, work) => owner.scheduleKeyed(`cancel:${slot}`, work),
    });
    next.prepareConnectionOpen('peer')!.admit();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    let drained = false;
    const drain = owner.closeAndDrain().then(() => { drained = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(drained).toBe(false); expect(release).not.toHaveBeenCalled();
    held.resolve(); await drain;
    expect(replay).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(2);
    expect(next.prepareConnectionOpen('peer')).toBeNull(); expect(next.status().pendingScopes).toBe(0);
  });

  it('releases all fences when the background owner refuses admission', () => {
    const release = vi.fn();
    const runtime = makeRuntime({
      selectContextGraphIds: () => ['a', 'b'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release }),
      reannounce: vi.fn(), replay: vi.fn(), warn: vi.fn(), schedule: () => false,
    });
    runtime.prepareConnectionOpen('peer')?.admit();
    expect(release).toHaveBeenCalledTimes(2);
    expect(runtime.prepareConnectionOpen('peer')).toBeNull();
  });

  it('still requests the authoritative catalog after a compatibility announcement fails', async () => {
    const warn = vi.fn();
    const replay = vi.fn(async () => { throw new Error('catalog unavailable'); });
    const runtime = makeRuntime({
      selectContextGraphIds: () => ['cg'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release: vi.fn() }),
      reannounce: async () => { throw new Error('legacy unavailable'); }, replay, warn,
    });
    runtime.prepareConnectionOpen('peer')?.admit();
    await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
    expect(replay).toHaveBeenCalledTimes(1);
    expect(runtime.status().peers[0].failed).toBe(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('legacy unavailable');
    expect(warn.mock.calls.flat().join(' ')).toContain('catalog unavailable');
  });

  it('continues all 257 graphs after one admitted connection without another prepare', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const owner = new Rfc64BackgroundWorkDispatcherV1(); owners.push(owner);
    const seen = new Set<string>();
    const runtime = makeRuntime({
      selectContextGraphIds: () => Array.from({ length: 257 }, (_, i) => `cg-${String(i).padStart(3, '0')}`),
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release: vi.fn() }),
      reannounce: async () => ({ failed: 0 }),
      replay: async cg => { seen.add(cg); return { failed: 0 }; }, warn: vi.fn(),
      schedule: (slot, work) => owner.scheduleKeyed(`replay:${slot}`, work),
    }, 100);
    runtime.prepareConnectionOpen('peer')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.size).toBe(256);
    await vi.advanceTimersByTimeAsync(100);
    expect(seen.size).toBe(257);
    expect(runtime.status().pendingScopes).toBe(0);
  });

  it('retains an exact activation while all 256 scope leases await network admission', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    let ids = Array.from({ length: 256 }, (_, i) => `cg-${String(i).padStart(3, '0')}`);
    const pushed: string[] = [];
    const runtime = makeRuntime({ selectContextGraphIds: () => ids,
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release: vi.fn() }),
      reannounce: async (_peer, cg) => { pushed.push(cg); return { failed: 0 }; },
      replay: async () => ({ failed: 0 }), warn: vi.fn() });
    const heldAdmissions = runtime.prepareConnectionOpen('peer')!;
    ids = [...ids, 'cg-256'];
    runtime.prepareGraphActivation('peer', 'cg-256', Date.now())!.admit();
    await vi.advanceTimersByTimeAsync(0);
    expect(pushed).toEqual([]);
    heldAdmissions.reject();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pushed).toEqual(['cg-256']);
    expect(runtime.status().pendingScopes).toBe(0);
  });

  it('runs a ready third peer while two peers wait for their cooldown deadlines', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const calls: string[] = [];
    const next = makeRuntime({ selectContextGraphIds: () => ['cg'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release: vi.fn() }),
      reannounce: async () => ({ failed: 0 }),
      replay: async (_cg, demand) => { calls.push(demand.peerId); return { failed: 0 }; }, warn: vi.fn(),
    }, 100);
    for (const peer of ['a', 'b']) next.prepareConnectionOpen(peer)!.admit();
    await vi.advanceTimersByTimeAsync(0);
    for (const peer of ['a', 'b']) next.prepareConnectionOpen(peer)!.admit();
    next.prepareConnectionOpen('c')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['a', 'b', 'c']);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual(['a', 'b', 'c', 'a', 'b']);
  });

  it('retains exact activation overflow without replaying unrelated retained scopes', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const selected = Array.from({ length: 256 }, (_, i) => `cg-${String(i).padStart(3, '0')}`);
    const calls: string[] = [];
    const next = makeRuntime({ selectContextGraphIds: () => selected,
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release: vi.fn() }),
      reannounce: async () => ({ failed: 0 }),
      replay: async cg => { calls.push(cg); return { failed: 0 }; }, warn: vi.fn(),
    }, 100);
    next.prepareConnectionOpen('peer')!.admit(); await vi.advanceTimersByTimeAsync(0);
    selected.push('new-cg'); next.prepareGraphActivation('peer', 'new-cg', Date.now())!.admit();
    await vi.advanceTimersByTimeAsync(99); expect(calls).toHaveLength(256);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.slice(256)).toEqual(['new-cg']);
    expect(next.status().pendingScopes).toBe(0);
  });
  it('retires both stream keys and the eligibility notifier through one dispatcher shutdown', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const owner = new Rfc64BackgroundWorkDispatcherV1();
    const held = deferred(); const signals = new Map<string | number, AbortSignal>();
    const release = vi.fn();
    const next = makeRuntime({ selectContextGraphIds: () => ['cg'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release }),
      reannounce: async () => ({ failed: 0 }),
      replay: async (_cg, demand) => { if (demand.peerId === 'held') await held.promise; return { failed: 0 }; },
      warn: vi.fn(), schedule: (slot, work) => owner.scheduleKeyed(`shutdown:${slot}`, signal => {
        signals.set(slot, signal); return work(signal);
      }),
    }, 100);
    next.prepareConnectionOpen('cooling')!.admit(); await vi.advanceTimersByTimeAsync(0);
    next.prepareConnectionOpen('cooling')!.admit(); next.prepareConnectionOpen('held')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    expect([...signals.keys()].sort()).toEqual([0, 1, 'deadline']);
    let drained = false;
    const drain = owner.closeAndDrain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect([...signals.values()].every(signal => signal.aborted)).toBe(true);
    expect(drained).toBe(false);
    held.resolve(); await drain;
    expect(next.status().pendingScopes).toBe(0);
    expect(next.prepareConnectionOpen('held')).toBeNull(); expect(release).toHaveBeenCalledTimes(3);
  });

  it('prunes a deferred activation when authoritative graph membership ends', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const selected = Array.from({ length: 256 }, (_, i) => `cg-${i}`);
    const calls: string[] = [];
    const next = makeRuntime({ selectContextGraphIds: () => selected,
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release: vi.fn() }),
      reannounce: async () => ({ failed: 0 }),
      replay: async cg => { calls.push(cg); return { failed: 0 }; }, warn: vi.fn(),
    }, 100);
    next.prepareConnectionOpen('peer')!.admit(); await vi.advanceTimersByTimeAsync(0);
    selected.push('removed'); next.prepareGraphActivation('peer', 'removed', Date.now())!.admit();
    selected.pop(); await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(256); expect(next.prepareGraphActivation('peer', 'removed', Date.now())).toBeNull();
  });

});

// These controls use recovery's actual worklist, rather than a fake fence.
describe('connection staging versus canonical recovery execution', () => {
  function canonicalRuntime() {
    const calls: string[] = [];
    const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({
      requestPeer: async (_cg, peer) => { calls.push(peer); return { status: 'completed', targets: [] }; },
      whenReceiverIdleForContextGraph: async () => ({ failed: 0 }),
      targetIdentity: () => '', parityFailed: async () => false,
    });
    const pushed: string[] = [];
    const connection = makeRuntime({
      selectContextGraphIds: () => ['cg'],
      reserveFence: (_cg, peer) => recovery.reservePeer('cg', 'policy', peer),
      reannounce: async peer => { pushed.push(peer); return { failed: 0 }; },
      replay: (_cg, demand, signal) => recovery.request({ kind: 'connection-demand', contextGraphId: 'cg', policyDigest: 'policy', demand, signal }),
      warn: vi.fn(),
    });
    return { connection, recovery, calls, pushed };
  }

  it('keeps A staged during its announcement while B pulls only its own demand', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    let releaseAnnouncement!: () => void;
    let releasePulls!: () => void;
    const announcement = new Promise<void>(resolve => { releaseAnnouncement = resolve; });
    const pulls = new Promise<void>(resolve => { releasePulls = resolve; });
    const called: string[] = [];
    let activeStreams = 0;
    let peakStreams = 0;
    const enter = () => { peakStreams = Math.max(peakStreams, ++activeStreams); };
    const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({
      requestPeer: async (_cg, peer) => {
        called.push(peer); enter();
        try { await pulls; return { status: 'completed', targets: [] }; }
        finally { activeStreams--; }
      },
      whenReceiverIdleForContextGraph: async () => undefined,
      targetIdentity: () => '', parityFailed: async () => false,
    });
    const connection = makeRuntime({ selectContextGraphIds: () => ['cg'],
      reserveFence: (cg, peer) => recovery.reservePeer(cg, 'policy', peer),
      reannounce: async peer => {
        if (peer === 'a') {
          enter();
          try { await announcement; } finally { activeStreams--; }
        }
        return { failed: 0 };
      },
      replay: (cg, demand, signal) => recovery.request({ kind: 'connection-demand',
        contextGraphId: cg, policyDigest: 'policy', demand, signal }), warn: vi.fn(),
    });
    try {
      connection.prepareConnectionOpen('a')!.admit();
      await vi.advanceTimersByTimeAsync(0);
      connection.prepareConnectionOpen('b')!.admit();
      await vi.advanceTimersByTimeAsync(0);
      expect(peakStreams).toBe(2);
      expect(called).toEqual(['b']);
      releasePulls(); await vi.advanceTimersByTimeAsync(0);
      expect(recovery.status('cg', 'policy')?.active).toBe(true);
      expect(connection.status().pendingScopes).toBe(1);
      releaseAnnouncement(); await vi.advanceTimersByTimeAsync(0);
      expect(called).toEqual(['b', 'a']);
      expect(peakStreams).toBe(2);
      expect(recovery.status('cg', 'policy')?.active).toBe(false);
      expect(connection.status().pendingScopes).toBe(0);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(called).toEqual(['b', 'a']);
    } finally {
      releasePulls(); releaseAnnouncement(); await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('keeps cooling A fenced but not runnable while B completes independent recovery', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const { connection, recovery, calls } = canonicalRuntime();
    connection.prepareConnectionOpen('a')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['a']);
    vi.setSystemTime(11_000); connection.prepareConnectionOpen('a')!.admit();
    vi.setSystemTime(12_000); connection.prepareConnectionOpen('b')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['a', 'b']);
    expect(recovery.status('cg', 'policy')?.active).toBe(true);
    await vi.advanceTimersByTimeAsync(57_999);
    expect(calls).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['a', 'b', 'a']);
    expect(recovery.status('cg', 'policy')?.active).toBe(false);
  });

  it('delivers the 65th peer head after 64 admission fences release without another event', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const { connection, pushed } = canonicalRuntime();
    const pending = Array.from({ length: 64 }, (_, i) => connection.prepareConnectionOpen(`held-${i}`)!);
    expect(pending.every(Boolean)).toBe(true);
    const last = connection.prepareConnectionOpen('peer-65');
    expect(last).not.toBeNull(); last!.admit();
    await vi.advanceTimersByTimeAsync(0); expect(pushed).toEqual([]);
    for (const reservation of pending) reservation.reject();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pushed).toEqual(['peer-65']);
    expect(connection.status().pendingScopes).toBe(0);
  });

  it('counts a resolved failed push while still pulling and retaining exponential backoff', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const replay = vi.fn(async () => ({ failed: 0 }));
    const connection = makeRuntime({ selectContextGraphIds: () => ['cg'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release: vi.fn() }),
      reannounce: async () => ({ announced: 0, failed: 1, manifest: [] }), replay, warn: vi.fn() }, 100);
    for (let attempt = 1; attempt <= 3; attempt++) {
      connection.prepareConnectionOpen('peer')!.admit(); await vi.advanceTimersByTimeAsync(0);
      const status = connection.status().peers[0];
      expect(status.failed).toBe(attempt);
      expect(status.nextEligibleAt - Date.now()).toBeGreaterThanOrEqual(100 * 2 ** (attempt - 1));
      vi.setSystemTime(status.nextEligibleAt);
    }
    expect(replay).toHaveBeenCalledTimes(3);
  });

  it('rotates three ready peers before either large scope pass can drain', async () => {
    const calls: string[] = [];
    const connection = makeRuntime({ selectContextGraphIds: () => Array.from({ length: 12 }, (_, i) => `cg-${i}`),
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release: vi.fn() }),
      reannounce: async () => ({ failed: 0 }),
      replay: async (_cg, demand) => { calls.push(demand.peerId); return { failed: 0 }; }, warn: vi.fn() });
    for (const peer of ['a', 'b', 'c']) connection.prepareConnectionOpen(peer)!.admit();
    await vi.waitFor(() => expect(calls).toHaveLength(36));
    const firstC = calls.indexOf('c');
    expect(firstC).toBeLessThan(24);
    expect(calls.slice(0, firstC).filter(peer => peer === 'a').length).toBeLessThan(12);
    expect(calls.slice(0, firstC).filter(peer => peer === 'b').length).toBeLessThan(12);
  });
});


describe('deferred replay completeness custody', () => {
  it('rotates the 257th graph into execution despite reconnects before every cooldown', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const ids = Array.from({ length: 257 }, (_, i) => `cg-${String(i).padStart(3, '0')}`);
    const calls: { cg: string; at: number }[] = [];
    const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({
      requestPeer: async cg => { calls.push({ cg, at: Date.now() }); return { status: 'completed', targets: [] }; },
      whenReceiverIdleForContextGraph: async () => undefined, targetIdentity: () => '', parityFailed: async () => false,
    });
    const connection = makeRuntime({ selectContextGraphIds: () => ids,
      reserveFence: (cg, peer) => recovery.reservePeer(cg, 'policy', peer),
      reannounce: async () => ({ failed: 0 }),
      replay: (cg, demand, signal) => recovery.request({ kind: 'connection-demand', contextGraphId: cg,
        policyDigest: 'policy', demand, signal }), warn: vi.fn(),
    });
    connection.prepareConnectionOpen('peer')!.admit(); await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(256);
    for (let reconnect = 1; reconnect <= 3; reconnect++) {
      await vi.advanceTimersByTimeAsync(30_000);
      connection.disconnected('peer'); connection.prepareConnectionOpen('peer')?.admit();
      await vi.advanceTimersByTimeAsync(0);
      if (reconnect === 1) {
        expect(recovery.status('cg-256', 'policy')?.active).toBe(true);
        expect(calls.some(call => call.cg === 'cg-256')).toBe(false);
      } else {
        expect(calls.some(call => call.cg === 'cg-256')).toBe(true);
      }
    }
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connection.status().pendingScopes).toBe(0);
    for (const cg of ids) {
      expect(recovery.status(cg, 'policy')?.active).toBe(false);
      const completedAt = calls.filter(call => call.cg === cg).map(call => call.at);
      expect(completedAt.length).toBeGreaterThanOrEqual(cg === 'cg-256' ? 1 : 2);
      for (let i = 1; i < completedAt.length; i++) expect(completedAt[i] - completedAt[i - 1]).toBeGreaterThanOrEqual(60_000);
    }
  });

  it.each([1, 12])('reads selection once per synchronous worker and deadline sweep with %i peers', async peerCount => {
    const scheduled = new Map<0 | 1 | 'deadline', (signal: AbortSignal) => Promise<void>>();
    const select = vi.fn(() => ['cg']);
    const controller = new AbortController(); const cancelled = new Error('deadline control complete');
    let waits = 0;
    const connection = makeRuntime({ selectContextGraphIds: select, reserveFence: () => null,
      reannounce: async () => ({ failed: 0 }), replay: async () => ({ failed: 0 }), warn: vi.fn(),
      schedule: (slot, work) => { scheduled.set(slot, work); return true; },
      wait: async () => { if (++waits === 2) { controller.abort(cancelled); throw cancelled; } },
    });
    for (let i = 0; i < peerCount; i++) connection.prepareConnectionOpen(`peer-${i}`)!.admit();
    select.mockClear();
    await scheduled.get(0)!(controller.signal);
    expect(select).toHaveBeenCalledOnce();
    select.mockClear();
    await expect(scheduled.get('deadline')!(controller.signal)).rejects.toBe(cancelled);
    expect(select).toHaveBeenCalledOnce();
    expect(waits).toBe(2);
  });

  it('fences the 257th graph before execution and retains its fence through cooldown', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const ids = Array.from({ length: 257 }, (_, i) => `cg-${String(i).padStart(3, '0')}`);
    const seen: string[] = [];
    const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({
      requestPeer: async cg => { seen.push(cg); return { status: 'completed', targets: [] }; },
      whenReceiverIdleForContextGraph: async () => undefined,
      targetIdentity: () => '', parityFailed: async () => false,
    });
    const connection = makeRuntime({ selectContextGraphIds: () => ids,
      reserveFence: (cg, peer) => recovery.reservePeer(cg, 'policy', peer),
      reannounce: async () => ({ failed: 0 }),
      replay: (cg, demand, signal) => recovery.request({ kind: 'connection-demand', contextGraphId: cg,
        policyDigest: 'policy', demand, signal }), warn: vi.fn(),
    }, 100);
    const reservation = connection.prepareConnectionOpen('peer')!;
    expect(recovery.status('cg-256', 'policy')?.active).toBe(true);
    expect(recovery.revisionForContextGraph('cg-256')).toBeDefined();
    reservation.admit(); await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(256);
    expect(recovery.status('cg-256', 'policy')?.active).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toHaveLength(257);
    expect(recovery.status('cg-256', 'policy')?.active).toBe(false);
    expect(connection.status().pendingScopes).toBe(0);
  });
});


describe('reconnected peer generation custody', () => {
  it('transfers an unsampled admission fence without letting the old rejection cancel it', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({
      requestPeer: async () => ({ status: 'completed', targets: [] }),
      whenReceiverIdleForContextGraph: async () => undefined, targetIdentity: () => '', parityFailed: async () => false,
    });
    const reserve = vi.fn((cg: string, peer: string) => recovery.reservePeer(cg, 'policy', peer));
    const replay = vi.fn((cg: string, demand: Parameters<Rfc64CatalogReplayConnectionRuntimePortsV1['replay']>[1], signal: AbortSignal) => recovery.request({
      kind: 'connection-demand', contextGraphId: cg, policyDigest: 'policy', demand, signal,
    }));
    const connection = makeRuntime({ selectContextGraphIds: () => ['cg'], reserveFence: reserve,
      reannounce: async () => ({ failed: 0 }), replay, warn: vi.fn() }, 100);
    const older = connection.prepareConnectionOpen('peer')!;
    connection.disconnected('peer');
    const replacement = connection.prepareConnectionOpen('peer')!;
    expect(reserve).toHaveBeenCalledOnce();
    older.reject();
    expect(recovery.status('cg', 'policy')?.active).toBe(true);
    replacement.admit(); await vi.advanceTimersByTimeAsync(0);
    expect(replay).toHaveBeenCalledOnce();
    expect(recovery.status('cg', 'policy')?.active).toBe(false);
    expect(connection.status().pendingScopes).toBe(0);
  });

  it('acquires H2 after the held H1 receiver drains without a third connection event', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    let version = 1;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const request = vi.fn(async () => ({ status: 'completed' as const, targets: [{ id: 'head', version }] }));
    const idle = vi.fn(async () => { if (request.mock.calls.length === 1) await held; });
    const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<{ id: string; version: number }>({
      requestPeer: request, whenReceiverIdleForContextGraph: idle, targetIdentity: target => `${target.id}:${target.version}`,
      pruneSupersededTargets: targets => targets.filter(target => target.version === Math.max(...targets.map(item => item.version))),
      parityFailed: async () => false,
    });
    const connection = makeRuntime({ selectContextGraphIds: () => ['cg'],
      reserveFence: (cg, peer) => recovery.reservePeer(cg, 'policy', peer),
      reannounce: async () => ({ failed: 0 }),
      replay: (cg, demand, signal) => recovery.request({ kind: 'connection-demand', contextGraphId: cg,
        policyDigest: 'policy', demand, signal }), warn: vi.fn(),
    }, 100);
    try {
      connection.prepareConnectionOpen('peer')!.admit(); await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledOnce();
      expect(idle).toHaveBeenCalledOnce();
      version = 2; connection.disconnected('peer');
      expect(connection.prepareGraphActivation('peer', 'cg')).toBeNull();
      connection.prepareConnectionOpen('peer')!.admit();
      for (let i = 0; i < 20; i++) expect(connection.prepareConnectionOpen('peer')).toBeNull();
      expect(connection.status().pendingScopes).toBe(2);
      expect(recovery.status('cg', 'policy')?.active).toBe(true);
      release(); await vi.advanceTimersByTimeAsync(0);
      expect(connection.status().pendingScopes).toBe(1);
      expect(recovery.status('cg', 'policy')?.active).toBe(true);
      await vi.advanceTimersByTimeAsync(99); expect(request).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
      expect(recovery.promisedTargets('cg', 'policy')).toEqual([{ id: 'head', version: 2 }]);
      expect(recovery.status('cg', 'policy')?.active).toBe(false);
      expect(connection.status().pendingScopes).toBe(0);
    } finally { release(); }
  });
});

describe('selected replay demand custody', () => {
  it('retains all 257 unavailable-fence admissions until fences become available', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const ids = Array.from({ length: 257 }, (_, i) => `cg-${String(i).padStart(3, '0')}`);
    let available = false;
    const seen: string[] = [];
    const runtime = makeRuntime({ selectContextGraphIds: () => ids,
      reserveFence: (_cg, peerId) => available
        ? { peerId, generation: 1, admit: () => undefined, release: vi.fn() } : null,
      reannounce: async () => ({ failed: 0 }),
      replay: async cg => { seen.push(cg); return { failed: 0 }; }, warn: vi.fn(),
    }, 100);
    const reservation = runtime.prepareConnectionOpen('peer')!;
    available = true; reservation.admit();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(seen).toHaveLength(257);
    expect(runtime.status().pendingScopes).toBe(0);
  });

  it('releases a removed installed cooldown demand without replaying it', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    let selected = ['old-cg'];
    const release = vi.fn(); const replay = vi.fn(async () => ({ failed: 0 }));
    const runtime = makeRuntime({ selectContextGraphIds: () => selected,
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release }),
      reannounce: async () => ({ failed: 0 }), replay, warn: vi.fn(),
    }, 100);
    runtime.prepareConnectionOpen('peer')!.admit(); await vi.advanceTimersByTimeAsync(0);
    runtime.prepareConnectionOpen('peer')!.admit();
    selected = [];
    await vi.advanceTimersByTimeAsync(100);
    expect(replay).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(2);
    expect(runtime.status().pendingScopes).toBe(0);
  });

  it('retires removed unavailable-fence retry custody so a new peer can enter at capacity', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    let selected = ['old-cg'];
    const reserve = vi.fn((cg: string, peerId: string) => cg === 'old-cg' ? null
      : { peerId, generation: 1, admit: () => undefined, release: vi.fn() });
    const replay = vi.fn(async () => ({ failed: 0 }));
    const runtime = makeRuntime({ selectContextGraphIds: () => selected, reserveFence: reserve,
      reannounce: async () => ({ failed: 0 }), replay, warn: vi.fn(),
    }, 100, 1);
    runtime.prepareConnectionOpen('old-peer')!.admit(); await vi.advanceTimersByTimeAsync(0);
    selected = ['new-cg'];
    await vi.advanceTimersByTimeAsync(1_000);
    const oldAttempts = reserve.mock.calls.filter(([cg]) => cg === 'old-cg').length;
    const next = runtime.prepareConnectionOpen('new-peer');
    expect(next).not.toBeNull(); next!.admit();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reserve.mock.calls.filter(([cg]) => cg === 'old-cg')).toHaveLength(oldAttempts);
    expect(replay).toHaveBeenCalledExactlyOnceWith('new-cg', expect.anything(), expect.any(AbortSignal));
    expect(runtime.status().pendingScopes).toBe(0);
  });
});


describe('selection retirement preserves physical custody', () => {
  it('retires a queued successor while the executing canonical receiver physically drains', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    let selected = ['old-cg']; let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const requests: string[] = [];
    const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({
      requestPeer: async cg => { requests.push(cg); return { status: 'completed', targets: [] }; },
      whenReceiverIdleForContextGraph: async cg => { if (cg === 'old-cg') await held; },
      targetIdentity: () => '', parityFailed: async () => false,
    });
    const releases = new Map<string, ReturnType<typeof vi.fn>[]>();
    const connection = makeRuntime({ selectContextGraphIds: () => selected,
      reserveFence: (cg, peer) => {
        const fence = recovery.reservePeer(cg, 'policy', peer);
        if (fence === null) return null;
        const done = vi.fn(() => fence.release());
        releases.set(cg, [...(releases.get(cg) ?? []), done]);
        return { ...fence, release: done };
      },
      reannounce: async () => ({ failed: 0 }),
      replay: (cg, demand, signal) => recovery.request({ kind: 'connection-demand', contextGraphId: cg,
        policyDigest: 'policy', demand, signal }), warn: vi.fn(),
    }, 100);
    try {
      connection.prepareConnectionOpen('peer')!.admit(); await vi.advanceTimersByTimeAsync(0);
      expect(requests).toEqual(['old-cg']);
      connection.disconnected('peer'); connection.prepareConnectionOpen('peer')!.admit();
      expect(releases.get('old-cg')).toHaveLength(2);
      selected = ['new-cg']; connection.prepareConnectionOpen('other')!.admit();
      await vi.advanceTimersByTimeAsync(0);
      expect(releases.get('old-cg')![0]).not.toHaveBeenCalled();
      expect(releases.get('old-cg')![1]).toHaveBeenCalledOnce();
      expect(recovery.status('old-cg', 'policy')?.active).toBe(true);
      release(); await vi.advanceTimersByTimeAsync(1_000);
      expect(releases.get('old-cg')![0]).toHaveBeenCalledOnce();
      expect(recovery.status('old-cg', 'policy')?.active).toBe(false);
      expect(requests.filter(cg => cg === 'old-cg')).toHaveLength(1);
      expect(connection.status().pendingScopes).toBe(0);
    } finally { release(); }
  });
});

// Reselecting a graph is an activation edge even on the same live connection.
describe('selection reactivation during receiver drain', () => {
  it('retains one reactivation successor without releasing the executing canonical fence', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    let selected = ['cg']; let version = 1; let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const request = vi.fn(async (cg: string) => ({ status: 'completed' as const,
      targets: [{ id: cg, version }] }));
    let firstCg = true;
    const recovery = new Rfc64CatalogReplayRecoveryRuntimeV1<{ id: string; version: number }>({
      requestPeer: request, whenReceiverIdleForContextGraph: async cg => {
        if (cg === 'cg' && firstCg) { firstCg = false; await held; }
      }, targetIdentity: target => `${target.id}:${target.version}`,
      pruneSupersededTargets: targets => targets.filter(target => target.version === Math.max(...targets.map(item => item.version))),
      parityFailed: async () => false,
    });
    const fences: ReturnType<typeof vi.fn>[] = [];
    const announce = vi.fn(async (_peer: string, _cg: string) => ({ failed: 0 }));
    const connection = makeRuntime({ selectContextGraphIds: () => selected,
      reserveFence: (cg, peer) => {
        const fence = recovery.reservePeer(cg, 'policy', peer); if (fence === null) return null;
        const done = vi.fn(() => fence.release()); if (cg === 'cg') fences.push(done);
        return { ...fence, release: done };
      }, reannounce: announce,
      replay: (cg, demand, signal) => recovery.request({ kind: 'connection-demand', contextGraphId: cg,
        policyDigest: 'policy', demand, signal }), warn: vi.fn(),
    }, 100);
    try {
      connection.prepareConnectionOpen('peer')!.admit(); await vi.advanceTimersByTimeAsync(0);
      expect(request.mock.calls.filter(([cg]) => cg === 'cg')).toHaveLength(1);
      selected = ['other']; connection.prepareGraphActivation('other-peer', 'other')!.admit();
      await vi.advanceTimersByTimeAsync(0);
      expect(fences[0]).not.toHaveBeenCalled();
      selected = ['cg', 'other']; version = 2;
      const refused = connection.prepareGraphActivation('peer', 'cg');
      expect(refused).not.toBeNull(); refused!.reject();
      expect(fences[1]).toHaveBeenCalledOnce();
      const activation = connection.prepareGraphActivation('peer', 'cg');
      expect(activation).not.toBeNull(); activation!.admit();
      for (let i = 0; i < 20; i++) expect(connection.prepareGraphActivation('peer', 'cg')).toBeNull();
      expect(fences).toHaveLength(3); expect(fences[0]).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(request.mock.calls.filter(([cg]) => cg === 'cg')).toHaveLength(1);
      release(); await vi.advanceTimersByTimeAsync(100);
      expect(request.mock.calls.filter(([cg]) => cg === 'cg')).toHaveLength(2);
      expect(announce.mock.calls.filter(([, cg]) => cg === 'cg')).toHaveLength(2);
      expect(recovery.promisedTargets('cg', 'policy')).toEqual([{ id: 'cg', version: 2 }]);
      expect(fences.every(done => done.mock.calls.length === 1)).toBe(true);
      expect(connection.status().pendingScopes).toBe(0);
    } finally { release(); }
  });
});


describe('connection adapter current-policy capabilities', () => {
  it('uses separate reservation and announcement snapshots without an agent dependency', async () => {
    const initial = buildOpenOwnerContextGraphPolicyV1({ networkId: RFC64_ROLLOUT_NETWORK_ID,
      contextGraphId: RFC64_ROLLOUT_CONTEXT_GRAPH_ID, ownerAddress: RFC64_ROLLOUT_AUTHOR });
    const successor = Object.freeze({ ...initial, issuedAt: '1' as typeof initial.issuedAt });
    const snapshot = (policy: typeof initial) => Object.freeze({ policy,
      policyDigest: computeOpenContextGraphPolicyDigestV1(policy), roster: null });
    let accepted: ReturnType<typeof snapshot> | null = snapshot(initial);
    const initialDigest = accepted.policyDigest;
    const readAcceptedPolicy = vi.fn(() => accepted);
    const announce = vi.fn(async () => ({ failed: 0 }));
    const reservePeer = vi.fn((_cg: string, _digest: string, peerId: string) => ({
      peerId, generation: 1, admit: vi.fn(), release: vi.fn(),
    }));
    const scheduled = new Map<0 | 1 | 'deadline', (signal: AbortSignal) => Promise<void>>();
    const controller = new AbortController();
    const runtime = createRfc64CatalogReplayConnectionRuntimeV1({
      capabilities: {
        listActiveRfc64CatalogReplayContextGraphIdsV1: () => [RFC64_ROLLOUT_CONTEXT_GRAPH_ID],
        readAcceptedRfc64CatalogAccessSnapshotV1: readAcceptedPolicy,
        reannounceRfc64CatalogHeadsToPeerV1: announce,
      },
      reservePeer, replay: async () => ({ failed: 0 }), warn: vi.fn(),
      schedule: (slot, work) => { scheduled.set(slot, work); return true; }, wait: async () => undefined,
    });
    runtime.prepareConnectionOpen('peer')!.admit();
    expect(reservePeer).toHaveBeenCalledWith(RFC64_ROLLOUT_CONTEXT_GRAPH_ID, initialDigest, 'peer');
    accepted = snapshot(successor);
    await scheduled.get(0)!(controller.signal);
    expect(announce).toHaveBeenCalledExactlyOnceWith('peer', {
      kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1, networkId: RFC64_ROLLOUT_NETWORK_ID,
      contextGraphId: RFC64_ROLLOUT_CONTEXT_GRAPH_ID, policyDigest: accepted.policyDigest,
    }, controller.signal);
    expect(readAcceptedPolicy).toHaveBeenCalledTimes(2);
    expect(accepted.policyDigest).not.toBe(initialDigest);
    accepted = null;
    const unavailable = runtime.prepareConnectionOpen('unknown')!;
    expect(reservePeer).toHaveBeenCalledOnce();
    unavailable.reject(); runtime.reset();
  });
});

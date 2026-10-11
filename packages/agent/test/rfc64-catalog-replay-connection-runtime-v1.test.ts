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
      for (const peer of ['a', 'b', 'c']) runtime.prepare(peer, 0)?.admit();
      await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(2));
      expect(replay.mock.calls.map((call) => call[1].peerId)).toEqual(['a', 'b']);
      for (let i = 1; i <= 20; i++) {
        expect(runtime.prepare('a', i)).toBeNull();
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
    runtime.prepare('peer')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.status().pendingScopes).toBe(0);
    const deferred = runtime.prepare('peer');
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
    runtime.prepare('peer', 0, 'new-cg')?.admit();
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

    runtime.prepare('peer-a', 0)?.admit();
    await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
    runtime.prepare('peer-b', 1)?.admit();
    await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));
    runtime.prepare('peer-c', 2)?.admit();
    await vi.waitFor(() => expect(runtime.status().pendingScopes).toBe(0));

    const coolingB = runtime.prepare('peer-b', 3);
    expect(coolingB).not.toBeNull(); coolingB?.reject();
    const retriedA = runtime.prepare('peer-a', 3);
    expect(retriedA).not.toBeNull();
    retriedA?.reject();
    expect(replay).toHaveBeenCalledWith('public-cg', {
      peerId: 'peer-a',
      generation: 1,
      admit: expect.any(Function),
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
    const runtime = makeRuntime({
      selectContextGraphIds: () => ['cg'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release }),
      reannounce: async () => ({ failed: 0 }), replay, warn: vi.fn(),
    });
    try {
      let previousDelay = 0;
      for (let attempt = 1; attempt <= 8; attempt++) {
        runtime.prepare('failed-peer', now)?.admit();
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
        const cooling = runtime.prepare('failed-peer', status.nextEligibleAt - 1);
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
        if (cg === 'old') queueMicrotask(() => next.prepare('peer', Date.now(), 'new')?.admit());
        return { failed: 0 };
      }, warn: vi.fn(),
    });
    next.prepare('peer', Date.now(), 'old')!.admit();
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
    const reserveFence = vi.fn((_cg: string, peerId: string) =>
      peerId === 'none' ? null : { peerId, generation: 1, admit: () => undefined, release });
    const runtime = makeRuntime({
      selectContextGraphIds: () => ['cg'], reserveFence,
      reannounce: vi.fn(), replay: vi.fn(), warn: vi.fn(),
    });
    const unavailable = runtime.prepare('none');
    expect(unavailable).not.toBeNull(); unavailable?.reject();
    const reservation = runtime.prepare('a');
    reservation?.reject(); reservation?.reject(); reservation?.admit();
    expect(release).toHaveBeenCalledTimes(1);
    const retry = runtime.prepare('a');
    expect(retry).not.toBeNull();
    retry?.reject();
    expect(runtime.status().pendingScopes).toBe(0);
    const empty = makeRuntime({
      selectContextGraphIds: () => [], reserveFence,
      reannounce: vi.fn(), replay: vi.fn(), warn: vi.fn(),
    });
    expect(empty.prepare('a')).toBeNull();
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
    next.prepare('peer')!.admit();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    let drained = false;
    const drain = owner.closeAndDrain().then(() => { drained = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(drained).toBe(false); expect(release).not.toHaveBeenCalled();
    held.resolve(); await drain;
    expect(replay).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(2);
    expect(next.prepare('peer')).toBeNull(); expect(next.status().pendingScopes).toBe(0);
  });

  it('releases all fences when the background owner refuses admission', () => {
    const release = vi.fn();
    const runtime = makeRuntime({
      selectContextGraphIds: () => ['a', 'b'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release }),
      reannounce: vi.fn(), replay: vi.fn(), warn: vi.fn(), schedule: () => false,
    });
    runtime.prepare('peer')?.admit();
    expect(release).toHaveBeenCalledTimes(2);
    expect(runtime.prepare('peer')).toBeNull();
  });

  it('still requests the authoritative catalog after a compatibility announcement fails', async () => {
    const warn = vi.fn();
    const replay = vi.fn(async () => { throw new Error('catalog unavailable'); });
    const runtime = makeRuntime({
      selectContextGraphIds: () => ['cg'],
      reserveFence: (_cg, peerId) => ({ peerId, generation: 1, admit: () => undefined, release: vi.fn() }),
      reannounce: async () => { throw new Error('legacy unavailable'); }, replay, warn,
    });
    runtime.prepare('peer')?.admit();
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
    runtime.prepare('peer')!.admit();
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
    const heldAdmissions = runtime.prepare('peer')!;
    ids = [...ids, 'cg-256'];
    runtime.prepare('peer', Date.now(), 'cg-256')!.admit();
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
    for (const peer of ['a', 'b']) next.prepare(peer)!.admit();
    await vi.advanceTimersByTimeAsync(0);
    for (const peer of ['a', 'b']) next.prepare(peer)!.admit();
    next.prepare('c')!.admit();
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
    next.prepare('peer')!.admit(); await vi.advanceTimersByTimeAsync(0);
    selected.push('new-cg'); next.prepare('peer', Date.now(), 'new-cg')!.admit();
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
    next.prepare('cooling')!.admit(); await vi.advanceTimersByTimeAsync(0);
    next.prepare('cooling')!.admit(); next.prepare('held')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    expect([...signals.keys()].sort()).toEqual([0, 1, 'deadline']);
    let drained = false;
    const drain = owner.closeAndDrain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect([...signals.values()].every(signal => signal.aborted)).toBe(true);
    expect(drained).toBe(false);
    held.resolve(); await drain;
    expect(next.status().pendingScopes).toBe(0);
    expect(next.prepare('held')).toBeNull(); expect(release).toHaveBeenCalledTimes(3);
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
    next.prepare('peer')!.admit(); await vi.advanceTimersByTimeAsync(0);
    selected.push('removed'); next.prepare('peer', Date.now(), 'removed')!.admit();
    selected.pop(); await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(256); expect(next.prepare('peer', Date.now(), 'removed')).toBeNull();
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

  it('keeps cooling A fenced but not runnable while B completes independent recovery', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const { connection, recovery, calls } = canonicalRuntime();
    connection.prepare('a')!.admit();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['a']);
    vi.setSystemTime(11_000); connection.prepare('a')!.admit();
    vi.setSystemTime(12_000); connection.prepare('b')!.admit();
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
    const pending = Array.from({ length: 64 }, (_, i) => connection.prepare(`held-${i}`)!);
    expect(pending.every(Boolean)).toBe(true);
    const last = connection.prepare('peer-65');
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
      connection.prepare('peer')!.admit(); await vi.advanceTimersByTimeAsync(0);
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
    for (const peer of ['a', 'b', 'c']) connection.prepare(peer)!.admit();
    await vi.waitFor(() => expect(calls).toHaveLength(36));
    const firstC = calls.indexOf('c');
    expect(firstC).toBeLessThan(24);
    expect(calls.slice(0, firstC).filter(peer => peer === 'a').length).toBeLessThan(12);
    expect(calls.slice(0, firstC).filter(peer => peer === 'b').length).toBeLessThan(12);
  });
});

import { Rfc64BackgroundWorkDispatcherV1 } from '../src/rfc64/background-work-dispatcher-v1.js';
import { describe, expect, it, vi } from 'vitest';
import { Rfc64CatalogReplayRecoveryRuntimeV1, RFC64_CATALOG_REPLAY_IDLE_DRAIN_BUDGET_MS_V1 } from '../src/rfc64/catalog-replay-recovery-runtime-v1.js';
import { RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 } from '../src/rfc64/catalog-limits-v1.js';
import { RFC64_RECEIVER_MAX_ADMISSION_DEFERRAL_WINDOW_MS_V1 } from '../src/rfc64/public-catalog-receiver-v1.js';
interface Target { readonly id: string; readonly scope?: string; readonly version?: number }
const run = (runtime: Rfc64CatalogReplayRecoveryRuntimeV1<Target>, policyDigest: string) => runtime.request({ contextGraphId: 'public-cg', policyDigest, kind: 'pending-recovery' });

describe('replay budgets and unobserved evidence', () => {
  it('continues multiple admitted connection demands after the real 64-peer run budget is spent', async () => {
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const peers = Array.from({ length: 64 }, (_, i) => `peer-${i}`);
    const requested: string[] = [];
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: async (_cg, peer) => {
        requested.push(peer); started.resolve(); await held.promise;
        return { status: 'completed', targets: peer === 'new-peer' ? [{ id: 'new-head' }] : [] };
      },
      whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target.id,
      parityFailed: async () => false,
    });
    const first = runtime.request({ contextGraphId: 'public-cg', policyDigest: 'p',
      kind: 'full-connected-peers', connectedPeerIds: peers });
    await started.promise;
    const lease = runtime.reservePeer('public-cg', 'p', 'new-peer');
    const secondLease = runtime.reservePeer('public-cg', 'p', 'newer-peer')!; secondLease.admit();
    expect(lease).not.toBeNull(); lease!.admit();
    let atCompletion: { requested: boolean; targets: readonly Target[] | null } | undefined;
    const joined = runtime.request({ contextGraphId: 'public-cg', policyDigest: 'p',
      kind: 'connection-demand', demand: lease! }).then(() => {
      atCompletion = { requested: requested.includes('new-peer'), targets: runtime.promisedTargets('public-cg', 'p') };
    });
    const second = runtime.request({ contextGraphId: 'public-cg', policyDigest: 'p', kind: 'connection-demand', demand: secondLease });
    try {
      held.resolve(); await first; await Promise.all([joined, second]);
      expect(requested).toHaveLength(66);
      expect(new Set(requested).size).toBe(66);
      expect(atCompletion).toEqual({ requested: true, targets: [{ id: 'new-head' }] });
    } finally { held.resolve(); lease!.release(); secondLease.release(); }
  });

  it.each(['same', 'distinct'] as const)('bounds %s-peer churn without a connection waiter', async mode => {
    let calls = 0;
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: async () => {
        calls += 1;
        // Keep a regressed unbounded runner from consuming the test worker heap.
        if (calls > 64) runtime.clear('public-cg');
        else runtime.markPeerPending('public-cg', 'p', mode === 'same' ? 'peer' : `peer-${calls}`);
        return { status: 'completed', targets: [] };
      },
      whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target.id,
      parityFailed: async () => false,
    });
    await expect(runtime.request({ contextGraphId: 'public-cg', policyDigest: 'p',
      kind: 'full-connected-peers', connectedPeerIds: ['peer'] })).resolves.toEqual({ requested: 64, failed: 1 });
    expect(calls).toBe(64);
    expect(runtime.status('public-cg', 'p')).toMatchObject({ failed: true, active: false, unverified: true });
  });

  it.each([false, true])('keeps scoped continuation status honest (prior failure=%s)', async priorFailure => {
    const held = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
    let hold = false, parityFailed = priorFailure;
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: async () => { if (hold) { started.resolve(); await held.promise; } return { status: 'completed', targets: [{ id: 'applied' }] }; },
      whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target.id,
      parityFailed: async () => parityFailed,
    });
    await runtime.request({ contextGraphId: 'public-cg', policyDigest: 'p', kind: 'full-connected-peers', connectedPeerIds: ['initial'] });
    parityFailed = false; hold = true;
    const leases = Array.from({ length: 64 }, (_, i) => runtime.markPeerPending('public-cg', 'p', `peer-${i}`)!);
    const first = runtime.request({ contextGraphId: 'public-cg', policyDigest: 'p', kind: 'pending-recovery' });
    await started.promise;
    const extra = runtime.markPeerPending('public-cg', 'p', 'extra')!;
    const next = runtime.request({ contextGraphId: 'public-cg', policyDigest: 'p', kind: 'connection-demand', demand: extra });
    held.resolve();
    await expect(first).resolves.toEqual({ requested: 64, failed: 0 });
    await expect(next).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status('public-cg', 'p')).toMatchObject({ active: false, failed: priorFailure, unverified: false });
    for (const lease of [...leases, extra]) lease.release();
  });

  it('settles the original full caller despite sustained joined full requests', async () => {
    let calls = 0;
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: async () => { calls += 1; return { status: 'completed', targets: [] }; },
      whenReceiverIdleForContextGraph: async () => {
        if (calls > 64) runtime.clear('public-cg');
        else void runtime.request({ contextGraphId: 'public-cg', policyDigest: 'p', kind: 'full-connected-peers', connectedPeerIds: ['peer'] });
      }, targetIdentity: target => target.id, parityFailed: async () => false,
    });
    await expect(runtime.request({ contextGraphId: 'public-cg', policyDigest: 'p', kind: 'full-connected-peers', connectedPeerIds: ['peer'] }))
      .resolves.toEqual({ requested: 64, failed: 1 });
    expect(calls).toBe(64);
  });

  it.each(['timeout', 'cancel'] as const)('retains overflow after an unobserved %s until a full corroborated replay', async mode => {
    const full = Array.from({ length: RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 }, (_, i) => ({ id: `head-${i}` }));
    let targets = full, unobserved = false;
    const controller = new AbortController();
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: async () => ({ status: 'completed', targets }),
      whenReceiverIdleForContextGraph: async () => {
        if (!unobserved) return;
        if (mode === 'cancel') { controller.abort(new Error('cancel drain')); throw controller.signal.reason; }
        await new Promise<void>(() => undefined);
      },
      sleep: () => unobserved && mode === 'timeout' ? Promise.resolve() : new Promise(() => undefined),
      targetIdentity: target => target.id, parityFailed: async () => false,
    });
    const fullPass = () => runtime.request({ contextGraphId: 'public-cg', policyDigest: 'policy', kind: 'full-connected-peers', connectedPeerIds: ['peer'] });
    await fullPass(); expect(runtime.promisedTargets('public-cg', 'policy')).toHaveLength(full.length);
    targets = [{ id: 'extra-head' }]; unobserved = true;
    runtime.markPeerPending('public-cg', 'policy', 'peer');
    const pending = runtime.request({ contextGraphId: 'public-cg', policyDigest: 'policy', kind: 'pending-recovery', signal: controller.signal });
    if (mode === 'cancel') await expect(pending).rejects.toThrow('cancel drain'); else await pending;
    expect(runtime.promisedTargets('public-cg', 'policy')).toBeNull();
    expect(runtime.status('public-cg', 'policy')).toMatchObject({ failed: true, unverified: true });
    unobserved = false;
    runtime.markPeerPending('public-cg', 'policy', 'peer'); await run(runtime, 'policy');
    expect(runtime.status('public-cg', 'policy')?.failed).toBe(true);
    await fullPass(); expect(runtime.status('public-cg', 'policy')).toMatchObject({ failed: false, unverified: false });
    expect(runtime.promisedTargets('public-cg', 'policy')).toEqual(targets);
  });

});

/**
 * A pass runs INSIDE the single-flight RFC-64 authority refresh
 * (`requestRfc64CatalogHeadReplaysFromConnectedPeersV1` is awaited there), so a
 * drain that never completes does not merely stall this graph — it withholds
 * every admission queued behind that refresh, including the finalized-private
 * catalog placement a confirmed VM publish waits on. That is how a single
 * private graph wedged the async promote queue: four such publishes pinned all
 * four worker slots and the queue stopped claiming work entirely.
 */
describe('RFC-64 replay recovery: the idle drain is bounded', () => {
  it('allows strictly more than the receiver can lawfully defer', () => {
    // At exactly the deferral window this budget is a tie, and one task
    // waiting on the process-wide chain-read lane defeats it every time.
    expect(RFC64_CATALOG_REPLAY_IDLE_DRAIN_BUDGET_MS_V1)
      .toBeGreaterThan(RFC64_RECEIVER_MAX_ADMISSION_DEFERRAL_WINDOW_MS_V1);
  });

  function runtimeWith(
    whenReceiverIdleForContextGraph: () => Promise<void>,
    sleep?: (ms: number) => Promise<void>,
    warn?: (message: string) => void,
  ) {
    return new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: async () => Object.freeze({
        status: 'completed' as const,
        targets: Object.freeze([{ id: 'target-1' }]),
      }),
      whenReceiverIdleForContextGraph,
      ...(sleep ? { sleep } : {}),
      ...(warn ? { warn } : {}),
      targetIdentity: (target) => target.id,
      parityFailed: async () => false,
    });
  }

  it('fails the pass closed when the drain outlives its budget, instead of parking forever', async () => {
    const budgets: number[] = [];
    const warnings: string[] = [];
    // A drain that never settles. Without the budget this await never returns.
    const runtime = runtimeWith(
      () => new Promise<void>(() => {}),
      async (ms) => { budgets.push(ms); },
      (message) => warnings.push(message),
    );

    const result = await runtime.request({
      contextGraphId: 'public-cg',
      policyDigest: 'p1',
      kind: 'full-connected-peers',
      connectedPeerIds: Object.freeze(['peer-1']),
    });

    // NOT a failure: parity was not observed, which is weaker than evidence
    // that rows are missing. Reporting `failed` here made the status
    // projection say `catalog-replay-incomplete` -> phase 'blocked', and
    // demanded a full replay that re-flooded the receiver it was waiting on.
    expect(result.failed).toBe(0);
    expect(budgets).toEqual([RFC64_CATALOG_REPLAY_IDLE_DRAIN_BUDGET_MS_V1]);
    // ...but it must NOT claim parity either.
    expect(runtime.status('public-cg', 'p1').unverified).toBe(true);
    // Never silent.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`exceeded ${RFC64_CATALOG_REPLAY_IDLE_DRAIN_BUDGET_MS_V1}ms`);
    expect(warnings[0]).toContain('public-cg');
    expect(warnings[0]).toContain('UNVERIFIED');
  });

  it('a spent budget must not CLEAR a standing parity witness, even on a full pass', async () => {
    // The corroboration contract: a pass that observed nothing may neither
    // fail the graph nor absolve it. Without the veto, a full pass whose
    // providers answered would clear a witness raised by real parity evidence
    // while never having watched this graph's admissions drain.
    // Exactly one side of the race resolves per pass, so which one wins is
    // deterministic rather than a scheduling coin-flip.
    let budgetWins = false;
    let parityFails = true;
    const never = () => new Promise<void>(() => {});
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: async () => Object.freeze({
        status: 'completed' as const,
        targets: Object.freeze([{ id: 'target-1' }]),
      }),
      whenReceiverIdleForContextGraph: () => (budgetWins ? never() : Promise.resolve()),
      sleep: () => (budgetWins ? Promise.resolve() : never()),
      targetIdentity: (target) => target.id,
      parityFailed: async () => parityFails,
    });
    const full = () => runtime.request({
      contextGraphId: 'public-cg',
      policyDigest: 'p1',
      kind: 'full-connected-peers',
      connectedPeerIds: Object.freeze(['peer-1']),
    });

    // Pass 1: the drain settles, parity FAILS -> a real witness stands.
    budgetWins = false;
    await full();
    expect(runtime.status('public-cg', 'p1').failed).toBe(true);

    // Pass 2: providers answer and parity would pass, but the drain never
    // settles. The witness must survive: this pass corroborated nothing.
    budgetWins = true;
    parityFails = false;
    await full();
    expect(runtime.status('public-cg', 'p1').failed).toBe(true);
    expect(runtime.status('public-cg', 'p1').unverified).toBe(true);
  });

  it('takes the drain result when it settles inside the budget', async () => {
    let drained = false;
    const runtime = runtimeWith(
      async () => { drained = true; },
      // Budget that never fires: only a real drain can complete this pass.
      () => new Promise<void>(() => {}),
    );

    const result = await runtime.request({
      contextGraphId: 'public-cg',
      policyDigest: 'p1',
      kind: 'full-connected-peers',
      connectedPeerIds: Object.freeze(['peer-1']),
    });

    expect(drained).toBe(true);
    expect(result.failed).toBe(0);
    // A drain that DID complete corroborates, so the witness clears.
    expect(runtime.status('public-cg', 'p1').unverified).toBe(false);
    expect(result.requested).toBeGreaterThan(0);
  });

  it('bounds the drain even when no sleep port is injected', async () => {
    // A missed wiring must not silently restore the unbounded park.
    const runtime = runtimeWith(() => new Promise<void>(() => {}));
    const pass = runtime.request({
      contextGraphId: 'public-cg',
      policyDigest: 'p1',
      kind: 'full-connected-peers',
      connectedPeerIds: Object.freeze(['peer-1']),
    });
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(RFC64_CATALOG_REPLAY_IDLE_DRAIN_BUDGET_MS_V1 + 1);
      await expect(pass).resolves.toMatchObject({ failed: 0 });
      expect(runtime.status('public-cg', 'p1').unverified).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('joined connection ownership after an unobserved run', () => {
  it.each(['drain-timeout', 'parity-error'] as const)('continues a connection queued during %s without another recovery request', async exit => {
    const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const requested: string[] = [];
    let drains = 0, parities = 0, sleeps = 0;
    const never = () => new Promise<void>(() => {});
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: async (_cg, peer) => { requested.push(peer); return { status: 'completed', targets: [{ id: peer }] }; },
      whenReceiverIdleForContextGraph: async () => {
        if (++drains === 1 && exit === 'drain-timeout') { entered.resolve(); await never(); }
      },
      sleep: () => ++sleeps === 1 && exit === 'drain-timeout' ? finish.promise : never(),
      targetIdentity: target => target.id,
      parityFailed: async () => {
        if (++parities === 1 && exit === 'parity-error') { entered.resolve(); await finish.promise; throw new Error('parity read refused'); }
        return false;
      },
    });
    const first = runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'full-connected-peers', connectedPeerIds: ['a'] });
    await entered.promise;
    const lease = runtime.markPeerPending('cg', 'p', 'b')!;
    let joinedDone = false;
    const joined = runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'connection-demand', demand: lease })
      .then(result => { joinedDone = true; return result; });
    try {
      finish.resolve(); await first;
      await vi.waitFor(() => expect(joinedDone).toBe(true), { timeout: 500 });
      expect(requested).toEqual(['a', 'b']);
      await expect(joined).resolves.toEqual({ requested: 1, failed: 0 });
      expect(runtime.promisedTargets('cg', 'p')).toEqual([{ id: 'a' }, { id: 'b' }]);
      expect(runtime.status('cg', 'p')).toMatchObject({ active: false, unverified: false, failed: false });
    } finally {
      finish.resolve();
      // Ensure a regression cannot leave the test worker with a stranded promise.
      if (!joinedDone) await runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'pending-recovery' });
      lease.release(); await joined;
    }
  });

  it('drains dispatcher shutdown after a timeout transfers a joined connection, retaining physical custody', async () => {
    const owner = new Rfc64BackgroundWorkDispatcherV1();
    const entered = Promise.withResolvers<void>(), timeout = Promise.withResolvers<void>(), transport = Promise.withResolvers<void>();
    let drains = 0, sleeps = 0, joinedDone = false, closingDone = false;
    const signals: (AbortSignal | undefined)[] = [];
    const never = () => new Promise<void>(() => {});
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: async (_cg, peer, signal) => {
        if (peer === 'b') { signals.push(signal); await transport.promise; }
        return { status: 'completed', targets: [] };
      },
      whenReceiverIdleForContextGraph: async () => { if (++drains === 1) { entered.resolve(); await never(); } },
      sleep: () => ++sleeps === 1 ? timeout.promise : never(),
      targetIdentity: target => target.id, parityFailed: async () => false,
    });
    const first = runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'full-connected-peers', connectedPeerIds: ['a'] });
    await entered.promise;
    const lease = runtime.markPeerPending('cg', 'p', 'b')!;
    let expectedSignal: AbortSignal | undefined;
    const joined = owner.runAwaited(signal => {
      expectedSignal = signal;
      return runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'connection-demand', demand: lease, signal });
    }).then(() => { joinedDone = true; }, () => { joinedDone = true; });
    try {
      timeout.resolve(); await first;
      await vi.waitFor(() => expect(signals).toHaveLength(1), { timeout: 500 });
      expect(signals[0]).toBe(expectedSignal);
      const closing = owner.closeAndDrain().then(() => { closingDone = true; });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(joinedDone).toBe(false); expect(closingDone).toBe(false);
      transport.resolve();
      await vi.waitFor(() => expect(closingDone).toBe(true), { timeout: 500 });
      await closing; await joined;
      expect(runtime.status('cg', 'p')?.active).toBe(false);
    } finally {
      timeout.resolve(); transport.resolve();
      if (!joinedDone) await runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'pending-recovery' });
      await joined; lease.release(); await owner.closeAndDrain();
    }
  });

  it('does not leave an already-cancelled command installed as the next run owner', async () => {
    const controller = new AbortController(); controller.abort(new Error('already closed'));
    const requestPeer = vi.fn(async () => ({ status: 'completed' as const, targets: [] }));
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({ requestPeer,
      whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target.id, parityFailed: async () => false });
    const lease = runtime.markPeerPending('cg', 'p', 'a')!;
    await expect(runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'connection-demand', demand: lease, signal: controller.signal }))
      .rejects.toThrow('already closed');
    expect(requestPeer).not.toHaveBeenCalled();
    await expect(runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'pending-recovery' })).resolves.toEqual({ requested: 1, failed: 0 });
    expect(requestPeer).toHaveBeenCalledOnce(); lease.release();
  });
});

it('executes a full request joining immediately after the final parity continuation', async () => {
  const requested: string[] = [];
  const joined = Promise.withResolvers<Readonly<{ requested: number; failed: number }>>();
  let join = false;
  const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
    requestPeer: async (_cg, peer) => { requested.push(peer); return { status: 'completed', targets: [{ id: peer }] }; },
    whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target.id,
    parityFailed: async () => {
      if (join) {
        join = false;
        // The first task precedes the await continuation, the second follows
        // its final queue check. An extra await before settlement strands B.
        queueMicrotask(() => queueMicrotask(() => {
          runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'full-connected-peers', connectedPeerIds: ['b'] })
            .then(joined.resolve, joined.reject);
        }));
      }
      return false;
    },
  });
  await runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'full-connected-peers', connectedPeerIds: ['initial'] });
  requested.length = 0; join = true;
  await runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'full-connected-peers', connectedPeerIds: ['a'] });
  await expect(joined.promise).resolves.toEqual({ requested: 1, failed: 0 });
  expect(requested).toEqual(['a', 'b']);
  expect(runtime.promisedTargets('cg', 'p')).toContainEqual({ id: 'b' });
  expect(runtime.status('cg', 'p')).toMatchObject({ active: false, failed: false, unverified: false });
});

it('carries one opaque demand through decorated admission and repeated completion', async () => {
  const requestPeer = vi.fn(async () => ({ status: 'completed' as const, targets: [] }));
  const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({ requestPeer,
    whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target.id, parityFailed: async () => false });
  const reserved = runtime.reservePeer('cg', 'p', 'peer')!;
  expect(() => runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'connection-demand',
    demand: { ...reserved, handle: {} } })).toThrow('Unknown catalog replay demand handle');
  expect(() => runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'connection-demand', demand: reserved }))
    .toThrow('not admitted');
  const decorated = { ...reserved, release: vi.fn(() => reserved.release()) };
  decorated.admit();
  const command = { contextGraphId: 'cg', policyDigest: 'p', kind: 'connection-demand' as const, demand: decorated };
  const first = runtime.request(command);
  const second = runtime.request(command);
  await expect(first).resolves.toEqual({ requested: 1, failed: 0 });
  await expect(second).resolves.toEqual({ requested: 1, failed: 0 });
  await expect(runtime.request(command)).resolves.toEqual({ requested: 1, failed: 0 });
  expect(requestPeer).toHaveBeenCalledOnce();
  decorated.release();
});


it.each([false, true])('groups execution by explicit owner despite composed cancellation signals (shared owner=%s)', async shared => {
  const controller = new AbortController();
  const ownerA = Object.freeze({ signal: controller.signal });
  const ownerB = shared ? ownerA : Object.freeze({ signal: controller.signal });
  const held = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  const requests: string[] = [], parity: string[][] = [];
  const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<never>({
    requestPeer: async (_cg, peer) => { requests.push(peer); if (peer === 'a') { started.resolve(); await held.promise; } return { status: 'completed', targets: [] }; },
    whenReceiverIdleForContextGraph: async () => {},
    targetIdentity: () => '', parityFailed: async () => { parity.push([...requests]); return false; },
  });
  const a = runtime.reservePeer('cg', 'p', 'a')!, b = runtime.reservePeer('cg', 'p', 'b')!;
  a.admit(); b.admit();
  const first = runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'connection-demand', demand: a,
    signal: controller.signal, executionOwner: ownerA });
  await started.promise;
  const second = runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'connection-demand', demand: b,
    signal: AbortSignal.any([controller.signal]), executionOwner: ownerB });
  try {
    held.resolve(); await Promise.all([first, second]);
    expect(requests).toEqual(['a', 'b']);
    // Same owner joins before the first parity settlement; separate owners each settle independently.
    expect(parity).toEqual(shared ? [['a', 'b']] : [['a'], ['a', 'b']]);
    expect(runtime.status('cg', 'p')?.active).toBe(false);
  } finally { held.resolve(); a.release(); b.release(); }
});

import { describe, expect, it, vi } from 'vitest';
import { Rfc64CatalogReplayRecoveryRuntimeV1, RFC64_CATALOG_REPLAY_IDLE_DRAIN_BUDGET_MS_V1 } from '../src/rfc64/catalog-replay-recovery-runtime-v1.js';
import { RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 } from '../src/rfc64/catalog-limits-v1.js';
import { RFC64_RECEIVER_MAX_ADMISSION_DEFERRAL_WINDOW_MS_V1 } from '../src/rfc64/public-catalog-receiver-v1.js';
interface Target { readonly id: string; readonly scope?: string; readonly version?: number }
const run = (runtime: Rfc64CatalogReplayRecoveryRuntimeV1<Target>, policyDigest: string) => runtime.request({ contextGraphId: 'public-cg', policyDigest, kind: 'pending-recovery' });

describe('replay budgets and unobserved evidence', () => {
  it('continues an admitted connection demand after the real 64-peer run budget is spent', async () => {
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
    expect(lease).not.toBeNull(); lease!.admit();
    let atCompletion: { requested: boolean; targets: readonly Target[] | null } | undefined;
    const joined = runtime.request({ contextGraphId: 'public-cg', policyDigest: 'p',
      kind: 'connection-demand', demand: lease! }).then(() => {
      atCompletion = { requested: requested.includes('new-peer'), targets: runtime.promisedTargets('public-cg', 'p') };
    });
    try {
      held.resolve(); await first; await joined;
      expect(requested).toHaveLength(65);
      expect(atCompletion).toEqual({ requested: true, targets: [{ id: 'new-head' }] });
    } finally { held.resolve(); lease!.release(); }
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

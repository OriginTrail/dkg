import { describe, expect, it, vi } from 'vitest';
import {
  Rfc64CatalogReplayRecoveryRuntimeV1,
  RFC64_CATALOG_REPLAY_IDLE_DRAIN_BUDGET_MS_V1,
} from '../src/rfc64/catalog-replay-recovery-runtime-v1.js';
import { RFC64_RECEIVER_MAX_ADMISSION_DEFERRAL_WINDOW_MS_V1 } from
  '../src/rfc64/public-catalog-receiver-v1.js';

interface Target {
  readonly id: string;
}

function run(
  runtime: Rfc64CatalogReplayRecoveryRuntimeV1<Target>,
  policyDigest: string,
  fullReplay = false,
) {
  return fullReplay
    ? runtime.request({
      contextGraphId: 'public-cg',
      policyDigest,
      kind: 'full-connected-peers',
      connectedPeerIds: Object.freeze([]),
    })
    : runtime.request({
      contextGraphId: 'public-cg',
      policyDigest,
      kind: 'pending-recovery',
    });
}

describe('RFC-64 catalog replay recovery runtime', () => {
  it('owns policy replacement leases, coalesced completion, and status projection', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requestPeer = vi.fn(async () => {
      await gate;
      return Object.freeze({
        status: 'completed' as const,
        targets: Object.freeze([]),
      });
    });
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer,
      whenReceiverIdleForContextGraph: async () => undefined,
      targetIdentity: (target) => target.id,
      parityFailed: async () => false,
    });
    const oldLease = runtime.markPeerPending('public-cg', 'old-policy', 'peer-old');
    const newLease = runtime.markPeerPending('public-cg', 'new-policy', 'peer-new');
    oldLease?.release();

    const first = run(runtime, 'new-policy');
    const coalesced = run(runtime, 'new-policy');
    expect(coalesced).toBe(first);
    expect(runtime.status('public-cg', 'new-policy')).toEqual({
      active: true,
      failed: false,
      unresolvedPeerCount: 0,
      unverified: false,
    });

    release();
    await expect(first).resolves.toEqual({ requested: 1, failed: 0 });
    expect(requestPeer).toHaveBeenCalledOnce();
    expect(runtime.status('public-cg', 'old-policy')).toBeNull();
    expect(runtime.status('public-cg', 'new-policy')).toEqual({
      active: false,
      failed: false,
      unresolvedPeerCount: 0,
      unverified: false,
    });
    newLease?.release();
  });

  it('OR-merges a joining full replay and clears only its failure witness', async () => {
    let parityFails = true;
    let release!: () => void;
    let gate = Promise.resolve();
    const requestPeer = vi.fn(async () => {
      await gate;
      return Object.freeze({
        status: 'completed' as const,
        targets: Object.freeze([{ id: 'target' }]),
      });
    });
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer,
      whenReceiverIdleForContextGraph: async () => undefined,
      targetIdentity: (target) => target.id,
      parityFailed: async () => parityFails,
    });

    runtime.markPeerPending('public-cg', 'policy', 'peer-a');
    await expect(run(runtime, 'policy')).resolves.toEqual({ requested: 1, failed: 1 });
    expect(runtime.status('public-cg', 'policy')?.failed).toBe(true);

    parityFails = false;
    runtime.markPeerPending('public-cg', 'policy', 'peer-b');
    await expect(run(runtime, 'policy')).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status('public-cg', 'policy')?.failed).toBe(true);

    gate = new Promise<void>((resolve) => { release = resolve; });
    runtime.markPeerPending('public-cg', 'policy', 'peer-c');
    const scoped = run(runtime, 'policy');
    const full = run(runtime, 'policy', true);
    expect(full).toBe(scoped);
    release();
    await expect(scoped).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status('public-cg', 'policy')?.failed).toBe(false);
  });

  it('parks each pass on ITS OWN context graph and reads parity only after that wait', async () => {
    const order: string[] = [];
    const releases = new Map<string, () => void>();
    const whenReceiverIdleForContextGraph = vi.fn((contextGraphId: string) => (
      new Promise<void>((resolve) => {
        order.push(`idle-wait:${contextGraphId}`);
        releases.set(contextGraphId, resolve);
      })
    ));
    const parityFailed = vi.fn(async (contextGraphId: string) => {
      order.push(`parity:${contextGraphId}`);
      return false;
    });
    const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<Target>({
      requestPeer: async () => Object.freeze({
        status: 'completed' as const,
        targets: Object.freeze([{ id: 'target' }]),
      }),
      whenReceiverIdleForContextGraph,
      targetIdentity: (target) => target.id,
      parityFailed,
    });
    const request = (contextGraphId: string) => {
      runtime.markPeerPending(contextGraphId, 'policy', 'peer-a');
      return runtime.request({ contextGraphId, policyDigest: 'policy', kind: 'pending-recovery' });
    };

    const busy = request('busy-cg');
    const converged = request('converged-cg');
    await vi.waitFor(() => { expect(releases.size).toBe(2); });
    // The id is the whole contract: a wait keyed by anything else reads idle
    // for a graph with admissions still pending, or parks on a stranger's work.
    expect(whenReceiverIdleForContextGraph.mock.calls).toEqual([['busy-cg'], ['converged-cg']]);
    expect(parityFailed).not.toHaveBeenCalled();

    // The converged graph's pass completes while the busy graph's stays parked.
    releases.get('converged-cg')!();
    await expect(converged).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status('converged-cg', 'policy')?.active).toBe(false);
    expect(runtime.status('busy-cg', 'policy')?.active).toBe(true);
    expect(order).toEqual(['idle-wait:busy-cg', 'idle-wait:converged-cg', 'parity:converged-cg']);

    releases.get('busy-cg')!();
    await expect(busy).resolves.toEqual({ requested: 1, failed: 0 });
    expect(runtime.status('busy-cg', 'policy')?.active).toBe(false);
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

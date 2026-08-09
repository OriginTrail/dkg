/**
 * Regression test for GH #1098 (layer 1) — the chain-driven VM reconcile sweep
 * must SELF-PRIME `onChainId` for a peer that subscribed to a PUBLIC CG BEFORE
 * its first publish. Such a peer has `subscribed: true` but no `onChainId` (only
 * curated CGs bind it on the ContextGraphCreated event; ACK-signers bind via the
 * storage-ACK hook), so the sweep would otherwise skip it forever and the peer
 * never reconciles the published KA into VM.
 *
 * This pins the state transition: a `subscribed && !onChainId` entry whose
 * ontology OnChainId quad is locally present gets bound + persisted, and the
 * sweep then triggers its reconcile. Hermetic — MockChainAdapter, no network.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

interface AgentInternals {
  runVmReconcileSweep(): Promise<void>;
  selfPrimeSubscriptionOnChainId(
    localCgId: string,
    sub: { subscribed: boolean; coreHosted?: boolean; onChainId?: string },
    targetOnChainId?: bigint,
    isCurrent?: () => boolean,
    signal?: AbortSignal,
  ): Promise<string | null>;
  resolveContextGraphOnChainIdBinding(
    localCgId: string,
    options?: { signal?: AbortSignal; source?: string },
  ): Promise<{
    onChainId: string;
    provenance: 'authoritative' | 'reverse-name-hash' | 'ontology';
  } | null>;
  handleKARegisteredNudge(onChainId: string, kaId: bigint, ctx: unknown): Promise<string | null>;
  subscribedContextGraphs: Map<string, { subscribed: boolean; coreHosted?: boolean; onChainId?: string }>;
  vmReconcileDispatcher: {
    dispatch: (cg: string, reason: 'live' | 'periodic') => Promise<boolean>;
    triggerLive: (cg: string) => void;
    triggerPeriodic: (cg: string) => void;
    tryTriggerPeriodic: (cg: string) => boolean;
  } | null;
  store: TripleStore;
}

// DKGNode getter throws on peerId access without a real start(); stub it so the
// subscription bookkeeping path runs (mirrors core-fills-gap.test.ts).
function stubNode(agent: DKGAgent): void {
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWSelfPrimeTestPeer',
    libp2p: { getPeers: () => [] },
  };
}

describe('GH #1098 — VM reconcile sweep self-primes onChainId for a pre-subscribed CG', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) { await agent.stop().catch(() => undefined); agent = null; }
  });

  it('binds onChainId from the ontology quad, persists, and triggers reconcile for a subscribed-but-unbound CG', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'SelfPrimeSweep', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;

    const LOCAL = 'gh1098-presub';
    const ONCHAIN = '4242';

    // The publisher broadcasts the CG's OnChainId quad on the ontology topic at
    // publish time (durable _meta sync also delivers it). Seed it — this is the
    // exact source `getContextGraphOnChainId` reads.
    await internals.store.insert([{
      subject: `did:dkg:context-graph:${LOCAL}`,
      predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
      object: `"${ONCHAIN}"`,
      graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
    }]);

    // The #1098 state: a pre-subscribed member CG with NO onChainId bound.
    internals.subscribedContextGraphs.set(LOCAL, { subscribed: true });

    const triggered: string[] = [];
    internals.vmReconcileDispatcher = {
      dispatch: async (cg: string, reason: 'live' | 'periodic') => {
        triggered.push(`${reason}:${cg}`);
        return true;
      },
      triggerLive: (cg: string) => { triggered.push(`live:${cg}`); },
      triggerPeriodic: (cg: string) => { triggered.push(`periodic:${cg}`); },
      tryTriggerPeriodic: (cg: string) => {
        triggered.push(`periodic:${cg}`);
        return true;
      },
    };

    // Precondition: unbound before the sweep (so the assertion below is meaningful).
    expect(internals.subscribedContextGraphs.get(LOCAL)?.onChainId).toBeUndefined();

    await internals.runVmReconcileSweep();

    // Post-fix: the sweep self-primed onChainId from the ontology quad and then
    // — no longer skipped by the `!onChainId` guard — triggered its reconcile.
    expect(internals.subscribedContextGraphs.get(LOCAL)?.onChainId).toBe(ONCHAIN);
    expect(triggered).toEqual([`periodic:${LOCAL}`]);
  });

  it('does not self-prime or reconcile CG 0 from empty or malformed ontology ids', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'SelfPrimeRejectsInvalidIds', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const invalidBindings = [
      ['gh1098-empty-id', ''],
      ['gh1098-zero-id', '0'],
      ['gh1098-leading-zero-id', '01'],
      ['gh1098-negative-id', '-1'],
    ] as const;

    await internals.store.insert(invalidBindings.map(([localCgId, onChainId]) => ({
      subject: `did:dkg:context-graph:${localCgId}`,
      predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
      object: `"${onChainId}"`,
      graph: ontologyGraph,
    })));
    for (const [localCgId] of invalidBindings) {
      internals.subscribedContextGraphs.set(localCgId, { subscribed: true });
    }

    const dispatch = vi.fn(async () => true);
    internals.vmReconcileDispatcher = {
      dispatch,
      triggerLive: vi.fn(),
      triggerPeriodic: vi.fn(),
      tryTriggerPeriodic: vi.fn(() => true),
    };

    await internals.runVmReconcileSweep();

    expect(dispatch).not.toHaveBeenCalled();
    for (const [localCgId] of invalidBindings) {
      expect(internals.subscribedContextGraphs.get(localCgId)?.onChainId).toBeUndefined();
    }
  });

  it('sweeps only operator-selected accepted RFC-64 public CGs without creating a subscription', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'Rfc64SelectedVmSweep', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const selected = 'rfc64-selected-vm';
    const acceptedButUnselected = 'rfc64-accepted-only';
    const syncScopedButUnaccepted = 'rfc64-sync-only';
    const serializedPolicy = (contextGraphId: string) => JSON.parse(JSON.stringify({
      policyEnvelope: {
        payload: { accessPolicy: 0, contextGraphId },
      },
      targets: [],
    }));
    (internals as any).config.syncContextGraphs = [selected, syncScopedButUnaccepted];
    (internals as any).config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [
        serializedPolicy(selected),
        serializedPolicy(acceptedButUnselected),
      ],
    };
    internals.subscribedContextGraphs.clear();

    const triggered: string[] = [];
    internals.vmReconcileDispatcher = {
      dispatch: async (cg: string, reason: 'live' | 'periodic') => {
        triggered.push(`${reason}:${cg}`);
        return true;
      },
      triggerLive: () => undefined,
      triggerPeriodic: () => undefined,
      tryTriggerPeriodic: () => true,
    };

    await internals.runVmReconcileSweep();

    expect(triggered).toEqual([`periodic:${selected}`]);
    expect(internals.subscribedContextGraphs.size).toBe(0);
  });

  it('resolves a selected-only RFC-64 VM target from chain binding without persisting member intent', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'Rfc64SelectedVmTarget', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const selected = 'rfc64-selected-vm-target';
    (internals as any).config.syncContextGraphs = [selected];
    (internals as any).config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: {
          payload: { accessPolicy: 0, contextGraphId: selected },
        },
        targets: [],
      }],
    };
    internals.subscribedContextGraphs.clear();
    const resolveOnChainId = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockResolvedValue(298n);

    const target = await (internals as any).resolveVmReconcileTarget(selected);

    expect(target).toMatchObject({
      kind: 'rfc64-selected',
      onChainId: '298',
      onChainCgId: 298n,
    });
    expect(resolveOnChainId).toHaveBeenCalledWith(
      (internals as any).contextGraphNameCommitment(selected),
      expect.objectContaining({ signal: undefined }),
    );
    expect(internals.subscribedContextGraphs.size).toBe(0);
  });

  it('invalidates a selected-only target when operator scope is removed during binding resolution', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'Rfc64SelectedVmScopeFence', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const selected = 'rfc64-selected-vm-scope-fence';
    const config = (internals as any).config;
    config.syncContextGraphs = [selected];
    config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: selected } },
        targets: [],
      }],
    };
    const binding = deferred<bigint | null>();
    vi.spyOn(chain, 'resolveContextGraphIdByNameHash').mockImplementation(() => binding.promise);

    const target = (internals as any).resolveVmReconcileTarget(selected);
    await Promise.resolve();
    config.syncContextGraphs = [];
    binding.resolve(298n);

    await expect(target).rejects.toMatchObject({ code: 'VmReconcileQueueClosed' });
    expect(internals.subscribedContextGraphs.size).toBe(0);
  });

  it('preserves lifecycle cancellation while a selected-only chain binding is unresolved', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'Rfc64SelectedVmAbortFence', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const selected = 'rfc64-selected-vm-abort-fence';
    (internals as any).config.syncContextGraphs = [selected];
    (internals as any).config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: selected } },
        targets: [],
      }],
    };
    const binding = deferred<bigint | null>();
    vi.spyOn(chain, 'resolveContextGraphIdByNameHash').mockImplementation(() => binding.promise);
    const controller = new AbortController();

    const target = (internals as any).resolveVmReconcileTarget(
      selected,
      () => true,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();

    await expect(target).rejects.toMatchObject({ code: 'VmReconcileQueueClosed' });
    expect(internals.subscribedContextGraphs.size).toBe(0);
  });

  it('KACG nudge targeting: binds ONLY the unbound CG whose on-chain id matches the event, not an unrelated one', async () => {
    // This exercises the SAME `selfPrimeSubscriptionOnChainId` helper the live
    // onKARegisteredToContextGraph nudge delegates to, with a `targetOnChainId`
    // (the event's CG id). The nudge loops subscribed-unbound CGs and binds the
    // one whose resolved id matches the event — so an unrelated CG must NOT bind.
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'SelfPrimeTargeted', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;

    const CG_MATCH = 'gh1098-match';
    const CG_OTHER = 'gh1098-other';
    const ON_MATCH = '500';
    const ON_OTHER = '600';
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    await internals.store.insert([
      { subject: `did:dkg:context-graph:${CG_MATCH}`, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${ON_MATCH}"`, graph: ontologyGraph },
      { subject: `did:dkg:context-graph:${CG_OTHER}`, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${ON_OTHER}"`, graph: ontologyGraph },
    ]);
    internals.subscribedContextGraphs.set(CG_MATCH, { subscribed: true });
    internals.subscribedContextGraphs.set(CG_OTHER, { subscribed: true });

    // Event for ON_MATCH: the other CG (resolves to ON_OTHER) must NOT bind.
    const other = await internals.selfPrimeSubscriptionOnChainId(CG_OTHER, internals.subscribedContextGraphs.get(CG_OTHER)!, BigInt(ON_MATCH));
    expect(other).toBeNull();
    expect(internals.subscribedContextGraphs.get(CG_OTHER)?.onChainId).toBeUndefined();

    // The matching CG binds.
    const matched = await internals.selfPrimeSubscriptionOnChainId(CG_MATCH, internals.subscribedContextGraphs.get(CG_MATCH)!, BigInt(ON_MATCH));
    expect(matched).toBe(ON_MATCH);
    expect(internals.subscribedContextGraphs.get(CG_MATCH)?.onChainId).toBe(ON_MATCH);
  });

  it('does not bind or persist a replacement subscription after delayed self-prime is invalidated', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'SelfPrimeLifecycleFence', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'gh1098-stale-self-prime';
    const original: { subscribed: boolean; onChainId?: string } = { subscribed: true };
    const replacement = { subscribed: true, onChainId: '9002' };
    internals.subscribedContextGraphs.set(localCgId, original);

    const lookup = deferred<string | null>();
    let receivedSignal: AbortSignal | undefined;
    internals.resolveContextGraphOnChainIdBinding = async (
      _id: string,
      options: { signal?: AbortSignal } = {},
    ) => {
      receivedSignal = options.signal;
      const onChainId = await lookup.promise;
      return onChainId === null
        ? null
        : { onChainId, provenance: 'ontology' };
    };
    const persist = vi.fn();
    (internals as any).persistContextGraphSubscription = persist;
    let current = true;
    const controller = new AbortController();

    const prime = internals.selfPrimeSubscriptionOnChainId(
      localCgId,
      original,
      undefined,
      () => current,
      controller.signal,
    );
    await Promise.resolve();
    current = false;
    controller.abort();
    internals.subscribedContextGraphs.set(localCgId, replacement);
    lookup.resolve('9001');

    await expect(prime).resolves.toBeNull();
    expect(receivedSignal).toBe(controller.signal);
    expect(original.onChainId).toBeUndefined();
    expect(internals.subscribedContextGraphs.get(localCgId)).toBe(replacement);
    expect(persist).not.toHaveBeenCalled();
  });

  it('does not overwrite a same-object binding that lands during self-prime', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'SelfPrimeSameObjectFence', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'gh1098-same-object-self-prime';
    const original: { subscribed: boolean; onChainId?: string } = { subscribed: true };
    internals.subscribedContextGraphs.set(localCgId, original);

    const lookup = deferred<string | null>();
    internals.resolveContextGraphOnChainIdBinding = async () => {
      const onChainId = await lookup.promise;
      return onChainId === null
        ? null
        : { onChainId, provenance: 'ontology' };
    };
    const persist = vi.fn();
    (internals as any).persistContextGraphSubscription = persist;

    const prime = internals.selfPrimeSubscriptionOnChainId(localCgId, original);
    await Promise.resolve();
    original.onChainId = '9002';
    lookup.resolve('9001');

    await expect(prime).resolves.toBeNull();
    expect(original.onChainId).toBe('9002');
    expect(persist).not.toHaveBeenCalled();
  });

  it('strict-persists the resolved binding before exposing it to live reconcile state', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'SelfPrimeStrictOrdering', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'gh1098-strict-ordering';
    const original: { subscribed: boolean; onChainId?: string } = { subscribed: true };
    internals.subscribedContextGraphs.set(localCgId, original);
    internals.resolveContextGraphOnChainIdBinding = async () => ({
      onChainId: '9010',
      provenance: 'ontology',
    });
    const persistStrict = vi.fn(async (
      _id: string,
      candidate: { onChainId?: string },
    ) => {
      expect(candidate.onChainId).toBe('9010');
      expect(original.onChainId).toBeUndefined();
    });
    (internals as any).persistContextGraphSubscriptionStrict = persistStrict;

    await expect(internals.selfPrimeSubscriptionOnChainId(localCgId, original))
      .resolves.toBe('9010');

    expect(persistStrict).toHaveBeenCalledOnce();
    expect(original.onChainId).toBe('9010');
  });

  it('leaves self-prime unbound when strict persistence fails', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'SelfPrimeStrictFailure', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'gh1098-strict-failure';
    const original: { subscribed: boolean; onChainId?: string } = { subscribed: true };
    internals.subscribedContextGraphs.set(localCgId, original);
    internals.resolveContextGraphOnChainIdBinding = async () => ({
      onChainId: '9011',
      provenance: 'ontology',
    });
    (internals as any).persistContextGraphSubscriptionStrict = async () => {
      throw new Error('subscription store unavailable');
    };

    await expect(internals.selfPrimeSubscriptionOnChainId(localCgId, original))
      .resolves.toBeNull();
    expect(original.onChainId).toBeUndefined();
  });

  it('rechecks the binding generation after strict self-prime persistence', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'SelfPrimeStrictGeneration', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'gh1098-strict-generation';
    const original: { subscribed: boolean; onChainId?: string } = { subscribed: true };
    internals.subscribedContextGraphs.set(localCgId, original);
    internals.resolveContextGraphOnChainIdBinding = async () => ({
      onChainId: '9012',
      provenance: 'ontology',
    });
    const persisted = deferred<void>();
    let markPersistStarted!: () => void;
    const persistStarted = new Promise<void>((resolve) => { markPersistStarted = resolve; });
    (internals as any).persistContextGraphSubscriptionStrict = async () => {
      markPersistStarted();
      await persisted.promise;
    };

    const prime = internals.selfPrimeSubscriptionOnChainId(localCgId, original);
    await persistStarted;
    (internals as any).bindSubscriptionOnChainId(localCgId, original, '9999');
    original.onChainId = undefined;
    persisted.resolve();

    await expect(prime).resolves.toBeNull();
    expect(original.onChainId).toBeUndefined();
  });

  it('settles promptly on lifecycle abort even when the lookup ignores its signal', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'SelfPrimeAbortRace', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'gh1098-abort-race';
    const original = { subscribed: true };
    internals.subscribedContextGraphs.set(localCgId, original);
    internals.resolveContextGraphOnChainIdBinding = async () => (
      new Promise<never>(() => undefined)
    );
    const persist = vi.fn();
    (internals as any).persistContextGraphSubscription = persist;
    const controller = new AbortController();

    const prime = internals.selfPrimeSubscriptionOnChainId(
      localCgId,
      original,
      undefined,
      () => !controller.signal.aborted,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();

    await expect(prime).resolves.toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it('live KACG nudge handler: with multiple subscribed-unbound CGs, binds + reconciles ONLY the one matching the event id', async () => {
    // Exercises the EXACT branch the live `onKARegisteredToContextGraph` poller
    // hook runs (extracted to `handleKARegisteredNudge`), not just the underlying
    // self-prime helper — so the loop-and-target logic is covered end to end.
    // Three pre-subscribed PUBLIC member CGs are unbound (the #1098 state); a KA
    // registration arrives for ONE of their on-chain ids. Only that CG must bind
    // and reconcile; the other two are left untouched.
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'KacgNudgeLive', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;

    const CG_HIT = 'gh1098-nudge-hit';
    const CG_MISS_A = 'gh1098-nudge-miss-a';
    const CG_MISS_B = 'gh1098-nudge-miss-b';
    const ON_HIT = '7000';
    const ON_MISS_A = '7001';
    const ON_MISS_B = '7002';
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    await internals.store.insert([
      { subject: `did:dkg:context-graph:${CG_HIT}`, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${ON_HIT}"`, graph: ontologyGraph },
      { subject: `did:dkg:context-graph:${CG_MISS_A}`, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${ON_MISS_A}"`, graph: ontologyGraph },
      { subject: `did:dkg:context-graph:${CG_MISS_B}`, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${ON_MISS_B}"`, graph: ontologyGraph },
    ]);
    internals.subscribedContextGraphs.set(CG_HIT, { subscribed: true });
    internals.subscribedContextGraphs.set(CG_MISS_A, { subscribed: true });
    internals.subscribedContextGraphs.set(CG_MISS_B, { subscribed: true });

    const triggered: string[] = [];
    internals.vmReconcileDispatcher = {
      dispatch: async () => true,
      triggerLive: (cg: string) => { triggered.push(`live:${cg}`); },
      triggerPeriodic: (cg: string) => { triggered.push(`periodic:${cg}`); },
      tryTriggerPeriodic: () => true,
    };

    // The event names ON_HIT's on-chain id. None is bound yet.
    const reconciled = await internals.handleKARegisteredNudge(ON_HIT, 99n, createOperationContext('system'));

    expect(reconciled).toBe(CG_HIT);
    expect(internals.subscribedContextGraphs.get(CG_HIT)?.onChainId).toBe(ON_HIT);
    // The other two pre-subscribed CGs were NOT bound and NOT reconciled.
    expect(internals.subscribedContextGraphs.get(CG_MISS_A)?.onChainId).toBeUndefined();
    expect(internals.subscribedContextGraphs.get(CG_MISS_B)?.onChainId).toBeUndefined();
    expect(triggered).toEqual([`live:${CG_HIT}`]);
  });

  it('live KACG nudge handler: an already-bound CG reconciles directly without a self-prime scan', async () => {
    // The other live branch: the event id already resolves to a local CG. It must
    // reconcile that CG straight away (subscribed or core-hosted), independent of
    // the pre-subscribed self-prime loop.
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'KacgNudgeBound', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;

    const CG_BOUND = 'gh1098-nudge-bound';
    const ON_BOUND = '8080';
    internals.subscribedContextGraphs.set(CG_BOUND, { subscribed: true, onChainId: ON_BOUND });

    const triggered: string[] = [];
    internals.vmReconcileDispatcher = {
      dispatch: async () => true,
      triggerLive: (cg: string) => { triggered.push(`live:${cg}`); },
      triggerPeriodic: (cg: string) => { triggered.push(`periodic:${cg}`); },
      tryTriggerPeriodic: () => true,
    };

    const reconciled = await internals.handleKARegisteredNudge(ON_BOUND, 1n, createOperationContext('system'));
    expect(reconciled).toBe(CG_BOUND);
    expect(triggered).toEqual([`live:${CG_BOUND}`]);
  });
});

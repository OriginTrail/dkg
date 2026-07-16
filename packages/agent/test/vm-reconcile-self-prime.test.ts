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
import { afterEach, describe, it, expect } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';

interface AgentInternals {
  runVmReconcileSweep(): Promise<void>;
  selfPrimeSubscriptionOnChainId(
    localCgId: string,
    sub: { subscribed: boolean; coreHosted?: boolean; onChainId?: string },
    targetOnChainId?: bigint,
  ): Promise<string | null>;
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

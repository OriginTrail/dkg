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
import {
  MockChainAdapter,
  type ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  DKGAgent,
  type ContextGraphSubscriptionRecord,
} from '../src/index.js';
import {
  VmReconcileSchedulingRuntime,
} from '../src/chain-reconciler.js';
import { resolveRfc64CatalogExecutionPlanV1 } from '../src/rfc64/public-catalog-activation-config-v1.js';
import { ethers } from 'ethers';

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
  isVmReconcileTargetSelected(contextGraphId: string): boolean;
  rfc64SelectedVmReconcileTargetIds(): readonly string[];
  resolveVmReconcileTarget(localCgId: string): Promise<unknown>;
  fetchContextGraphAssets(localCgId: string, requestedUals: readonly string[]): Promise<unknown>;
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
  bindSubscriptionOnChainId(
    localCgId: string,
    sub: { subscribed: boolean; coreHosted?: boolean; onChainId?: string },
    onChainId: string,
  ): void;
  subscribedContextGraphs: Map<string, { subscribed: boolean; coreHosted?: boolean; onChainId?: string }>;
  vmReconcileScheduling: VmReconcileSchedulingRuntime<boolean>;
  store: TripleStore;
}

function finalizedVmSnapshot(
  contextGraphId: string,
  onChainId = '298',
): ContextGraphAuthoritySnapshot {
  return Object.freeze({
    chainId: '31337',
    governanceContract: `0x${'11'.repeat(20)}`,
    contextGraphId: onChainId,
    owner: `0x${'22'.repeat(20)}`,
    active: true,
    accessPolicy: 0,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    participantAgents: [],
    nameHash: ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase(),
    ownershipEra: '1',
    policyVersion: '1',
    rosterVersion: '0',
    sourceBlockNumber: '42',
    sourceBlockHash: `0x${'33'.repeat(32)}`,
  });
}

function installFinalizedVmIndex(
  chain: MockChainAdapter,
  resolve: (nameHashes: readonly string[]) => Promise<ReadonlyMap<string, ContextGraphAuthoritySnapshot>>,
) {
  const whenIdle = vi.fn(async () => undefined);
  const resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes = vi.fn(resolve);
  Object.assign(chain, {
    contextGraphAuthorityIndexRevisionReader: {
      resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes,
      readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
      whenIdle,
    },
  });
  return { resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes, whenIdle };
}

// DKGNode getter throws on peerId access without a real start(); stub it so the
// subscription bookkeeping path runs (mirrors core-fills-gap.test.ts).
function stubNode(agent: DKGAgent): void {
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWSelfPrimeTestPeer',
    libp2p: { getPeers: () => [] },
  };
}

function installVmReconcileScheduling(
  internals: AgentInternals,
  scheduling: VmReconcileSchedulingRuntime<boolean>,
): VmReconcileSchedulingRuntime<boolean> {
  internals.vmReconcileScheduling = scheduling;
  return scheduling;
}

/** Exercise admission through the real dispatcher and canonical authorization/binding owner. */
function targetDispatcher(internals: AgentInternals) {
  const triggered: string[] = [];
  const dispatcher = installVmReconcileScheduling(internals, new VmReconcileSchedulingRuntime(async (cg, source) => {
    await internals.resolveVmReconcileTarget(cg);
    triggered.push(`${source}:${cg}`);
    return true;
  }, () => undefined, { concurrency: 2, maxPending: 32 }));
  return { dispatcher, triggered };
}

describe('GH #1098 — VM reconcile sweep self-primes onChainId for a pre-subscribed CG', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) { await agent.stop().catch(() => undefined); agent = null; }
    vi.restoreAllMocks();
  });

  it('keeps accepted owner-signed unregistered subscriptions out of every VM sweep', async () => {
    const chain = new MockChainAdapter();
    const index = installFinalizedVmIndex(chain, async () => new Map());
    agent = await DKGAgent.create({ name: 'Rfc64UnregisteredVmDormant', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const contextGraphId = 'rfc64-unregistered-vm-dormant';
    internals.subscribedContextGraphs.set(contextGraphId, { subscribed: true });
    vi.spyOn(internals as any, 'hasAcceptedRfc64UnregisteredAuthorityV1')
      .mockImplementation((id: string) => id === contextGraphId);
    const legacyLookup = vi.spyOn(chain, 'resolveContextGraphIdByNameHash');
    const dispatch = vi.fn(async () => true);
    installVmReconcileScheduling(
      internals,
      new VmReconcileSchedulingRuntime(dispatch, () => undefined),
    );

    expect(internals.isVmReconcileTargetSelected(contextGraphId)).toBe(false);
    await internals.runVmReconcileSweep();
    await internals.runVmReconcileSweep();
    await internals.runVmReconcileSweep();
    await expect(internals.resolveVmReconcileTarget(contextGraphId))
      .rejects.toMatchObject({ code: 'ContextGraphNotFound' });

    expect(dispatch).not.toHaveBeenCalled();
    expect(index.resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes)
      .toHaveBeenCalledOnce();
    expect(index.whenIdle).toHaveBeenCalledOnce();
    expect(legacyLookup).not.toHaveBeenCalled();
  });

  it('keeps accepted unregistered reverse candidates out of sweeps but promotes a finalized transition', async () => {
    const chain = new MockChainAdapter();
    const contextGraphId = 'rfc64-unregistered-reverse-transition';
    const snapshot = finalizedVmSnapshot(contextGraphId);
    const index = installFinalizedVmIndex(chain, async (nameHashes) => new Map([
      [nameHashes[0]!, snapshot],
    ]));
    agent = await DKGAgent.create({ name: 'Rfc64UnregisteredReverseTransition', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const subscription = { subscribed: true };
    internals.subscribedContextGraphs.set(contextGraphId, subscription);
    (internals as any).bindSubscriptionReverseNameHashOnChainId(
      contextGraphId,
      subscription,
      '297',
      snapshot.nameHash,
    );
    vi.spyOn(internals as any, 'hasAcceptedRfc64UnregisteredAuthorityV1')
      .mockImplementation((id: string) => id === contextGraphId);
    vi.spyOn(agent, 'canReadContextGraph').mockResolvedValue(true);
    const legacyLookup = vi.spyOn(chain, 'resolveContextGraphIdByNameHash');
    const dispatch = vi.fn(async () => true);
    installVmReconcileScheduling(
      internals,
      new VmReconcileSchedulingRuntime(dispatch, () => undefined),
    );

    expect(internals.isVmReconcileTargetSelected(contextGraphId)).toBe(false);
    const target = await internals.resolveVmReconcileTarget(contextGraphId);

    expect(target).toMatchObject({
      kind: 'subscription',
      bindingKind: 'authoritative',
      onChainId: '298',
    });
    expect(internals.subscribedContextGraphs.get(contextGraphId)).toMatchObject({
      onChainId: '298',
      onChainHash: snapshot.nameHash,
    });
    // The accepted RFC-64 source intentionally remains stale-unregistered.
    // Once a finalized lookup installs an authoritative binding, the periodic
    // selector must admit it without waiting for an unrelated policy refresh.
    expect(internals.isVmReconcileTargetSelected(contextGraphId)).toBe(true);
    await internals.runVmReconcileSweep();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(index.resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes)
      .toHaveBeenCalledOnce();
    expect(legacyLookup).not.toHaveBeenCalled();
  });

  it('fails an indexed unbound subscription closed without reopening the legacy history scan', async () => {
    const chain = new MockChainAdapter();
    const index = installFinalizedVmIndex(chain, async () => new Map());
    agent = await DKGAgent.create({ name: 'Rfc64PendingAbsenceVmFence', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const contextGraphId = 'rfc64-pending-absence-vm-fence';
    internals.subscribedContextGraphs.set(contextGraphId, { subscribed: true });
    const legacyLookup = vi.spyOn(chain, 'resolveContextGraphIdByNameHash');
    const readAuthority = vi.spyOn(agent, 'canReadContextGraph');

    await expect(internals.resolveVmReconcileTarget(contextGraphId))
      .rejects.toMatchObject({ code: 'ContextGraphOnChainIdUnresolved' });

    expect(index.resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes)
      // The governed authority lane always supplies a signal, so a coordinator
      // close can cancel this read even when the caller passed none.
      .toHaveBeenCalledWith([
        (internals as any).contextGraphNameCommitment(contextGraphId),
      ], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(index.whenIdle).toHaveBeenCalledOnce();
    expect(legacyLookup).not.toHaveBeenCalled();
    expect(readAuthority).not.toHaveBeenCalled();
  });

  it('carries direct numeric subscription authority through subscribe and VM resolution', async () => {
    const chain = new MockChainAdapter();
    const persistedSubscriptions = new Map<string, ContextGraphSubscriptionRecord>();
    const index = installFinalizedVmIndex(chain, async () => {
      throw new Error('numeric authority must not reverse-resolve a name hash');
    });
    agent = await DKGAgent.create({
      name: 'NumericFinalizedSubscribeAuthority',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...persistedSubscriptions.values()].map((record) => ({ ...record })),
        save: async (record) => {
          persistedSubscriptions.set(record.id, { ...record });
        },
        delete: async (contextGraphId) => {
          persistedSubscriptions.delete(contextGraphId);
        },
      },
    });
    stubNode(agent);
    Object.assign(agent as any, {
      gossip: {
        subscribe: vi.fn(),
        onMessage: vi.fn(),
      },
    });
    const internals = agent as unknown as AgentInternals;
    vi.spyOn(agent as any, 'resolveLiveOnChainAccessPolicyState').mockResolvedValue({
      kind: 'available',
      accessPolicy: 0,
    });
    vi.spyOn(agent, 'canReadContextGraph').mockResolvedValue(true);
    const legacyLookup = vi.spyOn(chain, 'resolveContextGraphIdByNameHash');

    const authority = await agent.resolveContextGraphSubscriptionBootstrapAuthority('298', {
      allowSubscriptionFallback: false,
    });
    expect(authority).toMatchObject({
      outcome: 'allowed',
      source: 'registered-chain',
      onChainId: 298n,
    });
    const subscription = agent.subscribeToContextGraph('298', {
      onChainId: authority.onChainId?.toString(10),
    });
    const target = await internals.resolveVmReconcileTarget('298');

    expect(subscription).toMatchObject({ subscribed: true, onChainId: '298' });
    await vi.waitFor(() => expect(persistedSubscriptions.get('298'))
      .toMatchObject({ id: '298', onChainId: '298' }));
    expect(target).toMatchObject({
      kind: 'subscription',
      bindingKind: 'authoritative',
      onChainId: '298',
    });
    expect(index.resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes)
      .not.toHaveBeenCalled();
    expect(index.whenIdle).not.toHaveBeenCalled();
    expect(legacyLookup).not.toHaveBeenCalled();

    await agent.stop();
    agent = await DKGAgent.create({
      name: 'NumericFinalizedSubscribeAuthorityRestart',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...persistedSubscriptions.values()].map((record) => ({ ...record })),
        save: async (record) => {
          persistedSubscriptions.set(record.id, { ...record });
        },
        delete: async (contextGraphId) => {
          persistedSubscriptions.delete(contextGraphId);
        },
      },
    });
    stubNode(agent);
    Object.assign(agent as any, {
      gossip: {
        subscribe: vi.fn(),
        onMessage: vi.fn(),
      },
    });
    vi.spyOn(agent as any, 'resolveLiveOnChainAccessPolicyState').mockResolvedValue({
      kind: 'available',
      accessPolicy: 0,
    });
    vi.spyOn(agent, 'canReadContextGraph').mockResolvedValue(true);

    await agent.rehydrateContextGraphSubscriptions(null);
    const restartedInternals = agent as unknown as AgentInternals;
    const restartedTarget = await restartedInternals.resolveVmReconcileTarget('298');

    expect(agent.getSubscribedContextGraphs().get('298')).toMatchObject({
      subscribed: true,
      onChainId: '298',
    });
    expect(restartedTarget).toMatchObject({
      kind: 'subscription',
      bindingKind: 'authoritative',
      onChainId: '298',
    });
    expect(index.resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes)
      .not.toHaveBeenCalled();
    expect(legacyLookup).not.toHaveBeenCalled();
  });

  it('promotes exact active finalized evidence before applying the existing VM read policy', async () => {
    const chain = new MockChainAdapter();
    const contextGraphId = 'rfc64-finalized-vm-binding';
    const snapshot = finalizedVmSnapshot(contextGraphId);
    const index = installFinalizedVmIndex(chain, async (nameHashes) => new Map([
      [nameHashes[0]!, snapshot],
    ]));
    agent = await DKGAgent.create({ name: 'Rfc64FinalizedVmBinding', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    internals.subscribedContextGraphs.set(contextGraphId, { subscribed: true });
    const legacyLookup = vi.spyOn(chain, 'resolveContextGraphIdByNameHash');
    const readAuthority = vi.spyOn(agent, 'canReadContextGraph').mockResolvedValue(true);

    const target = await internals.resolveVmReconcileTarget(contextGraphId);

    expect(target).toMatchObject({
      kind: 'subscription',
      bindingKind: 'authoritative',
      onChainId: '298',
    });
    expect(internals.subscribedContextGraphs.get(contextGraphId)).toMatchObject({
      subscribed: true,
      onChainId: '298',
      onChainHash: snapshot.nameHash,
    });
    expect(readAuthority).toHaveBeenCalledWith(contextGraphId, {
      allowSubscriptionFallback: false,
    });
    expect(index.whenIdle).toHaveBeenCalledOnce();
    expect(legacyLookup).not.toHaveBeenCalled();
  });

  it('does not overwrite an authoritative binding installed during a finalized VM lookup', async () => {
    const chain = new MockChainAdapter();
    const contextGraphId = 'rfc64-finalized-vm-generation-fence';
    const snapshot = finalizedVmSnapshot(contextGraphId);
    const scan = deferred<ReadonlyMap<string, ContextGraphAuthoritySnapshot>>();
    installFinalizedVmIndex(chain, async () => scan.promise);
    agent = await DKGAgent.create({ name: 'Rfc64FinalizedVmGenerationFence', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const subscription = { subscribed: true };
    internals.subscribedContextGraphs.set(contextGraphId, subscription);
    vi.spyOn(agent, 'canReadContextGraph').mockResolvedValue(true);

    const target = internals.resolveVmReconcileTarget(contextGraphId);
    await Promise.resolve();
    internals.bindSubscriptionOnChainId(contextGraphId, subscription, '999');
    scan.resolve(new Map([[snapshot.nameHash, snapshot]]));

    await expect(target).rejects.toMatchObject({ code: 'VmReconcileQueueClosed' });
    expect(internals.subscribedContextGraphs.get(contextGraphId)?.onChainId).toBe('999');
  });

  it('rejects invalid finalized VM evidence without binding or falling back to legacy', async () => {
    const chain = new MockChainAdapter();
    const contextGraphId = 'rfc64-invalid-finalized-vm-binding';
    const invalid = Object.freeze({
      ...finalizedVmSnapshot(contextGraphId),
      active: false,
    });
    const index = installFinalizedVmIndex(chain, async (nameHashes) => new Map([
      [nameHashes[0]!, invalid],
    ]));
    agent = await DKGAgent.create({ name: 'Rfc64InvalidFinalizedVmBinding', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    internals.subscribedContextGraphs.set(contextGraphId, { subscribed: true });
    const legacyLookup = vi.spyOn(chain, 'resolveContextGraphIdByNameHash');
    const readAuthority = vi.spyOn(agent, 'canReadContextGraph');

    await expect(internals.resolveVmReconcileTarget(contextGraphId))
      .rejects.toThrow('Invalid finalized VM authority evidence');

    expect(internals.subscribedContextGraphs.get(contextGraphId)?.onChainId).toBeUndefined();
    expect(index.whenIdle).toHaveBeenCalledOnce();
    expect(legacyLookup).not.toHaveBeenCalled();
    expect(readAuthority).not.toHaveBeenCalled();
  });

  it('binds onChainId from the ontology quad, persists, and triggers reconcile for a subscribed-but-unbound CG', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'SelfPrimeSweep', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    // This test isolates binding/self-prime behavior. Its synthetic ontology
    // row has no matching live MockChain slot, so pin the independent read-
    // authorization prerequisite as satisfied.
    vi.spyOn(agent, 'canReadContextGraph').mockResolvedValue(true);

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

    const { dispatcher, triggered } = targetDispatcher(internals);

    // Precondition: unbound before the sweep (so the assertion below is meaningful).
    expect(internals.subscribedContextGraphs.get(LOCAL)?.onChainId).toBeUndefined();

    await internals.runVmReconcileSweep();
    await dispatcher.waitForIdle();

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
    vi.spyOn(agent, 'canReadContextGraph').mockResolvedValue(true);
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

    const { dispatcher, triggered } = targetDispatcher(internals);

    await internals.runVmReconcileSweep();
    await dispatcher.waitForIdle();

    expect(triggered).toEqual([]);
    for (const [localCgId] of invalidBindings) {
      expect(internals.subscribedContextGraphs.get(localCgId)?.onChainId).toBeUndefined();
    }
  });

  it('keeps a poisoned private subscription dormant while reconciling an authorized member', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'PrivateVmAuthorityFence', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const denied = 'private-poisoned-subscription';
    const member = 'private-authorized-member';
    internals.subscribedContextGraphs.set(denied, { subscribed: true, onChainId: '401' });
    internals.subscribedContextGraphs.set(member, { subscribed: true, onChainId: '402' });
    vi.spyOn(agent, 'canReadContextGraph').mockImplementation(async (contextGraphId, opts) => {
      expect(opts?.allowSubscriptionFallback).toBe(false);
      return contextGraphId === member;
    });

    const { dispatcher, triggered } = targetDispatcher(internals);

    await internals.runVmReconcileSweep();
    await dispatcher.waitForIdle();

    expect(triggered).toEqual([`periodic:${member}`]);
    await expect(internals.resolveVmReconcileTarget(denied))
      .rejects.toMatchObject({ code: 'ContextGraphNotFound' });
    await expect(internals.fetchContextGraphAssets(denied, [
      'did:dkg:mock:31337/0x000000000000000000000000000000000000c10a/1',
    ])).rejects.toMatchObject({ code: 'ContextGraphNotFound' });
  });

  it('sweeps only operator-selected accepted RFC-64 public CGs without creating a subscription', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'Rfc64SelectedVmSweep', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const selected = 'rfc64-selected-vm';
    const acceptedButUnselected = 'rfc64-accepted-only';
    const syncScopedButUnaccepted = 'rfc64-sync-only';
    const privateSelected = 'rfc64-private-selected';
    const serializedPolicy = (contextGraphId: string, accessPolicy = 0) => JSON.parse(JSON.stringify({
      policyEnvelope: {
        payload: { accessPolicy, contextGraphId },
      },
      targets: [],
    }));
    (internals as any).config.syncContextGraphs = [
      selected,
      syncScopedButUnaccepted,
      privateSelected,
    ];
    (internals as any).config.rfc64CatalogBootstrap = {
      acceptedPolicies: [
        serializedPolicy(selected),
        serializedPolicy(acceptedButUnselected),
        serializedPolicy(privateSelected, 1),
      ],
    };
    // Discovery may leave a passive bookkeeping row. That row is not member
    // intent and must neither block selected VM work nor be upgraded into a
    // subscription as a side effect of the sweep.
    const passiveDiscoveryRow = {
      subscribed: false,
      coreHosted: false,
      synced: false,
    };
    internals.subscribedContextGraphs.set(selected, passiveDiscoveryRow);

    const triggered: string[] = [];
    const scheduling = new VmReconcileSchedulingRuntime(async (cg, reason) => {
      triggered.push(`${reason}:${cg}`);
      return true;
    }, () => undefined);
    installVmReconcileScheduling(internals, scheduling);

    await internals.runVmReconcileSweep();

    expect(triggered).toEqual([`periodic:${selected}`]);
    expect(internals.subscribedContextGraphs.size).toBe(1);
    expect(internals.subscribedContextGraphs.get(selected)).toBe(passiveDiscoveryRow);
  });

  it('normalizes legacy RFC-64 selection and excludes member/core-owned targets', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'Rfc64LegacyVmSelection', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const config = (internals as any).config;
    const selected = ['legacy-z', 'legacy-a', 'legacy-member', 'legacy-core', 'legacy-private'];
    config.syncContextGraphs = selected;
    config.rfc64CatalogBootstrap = undefined;
    config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: selected.map((contextGraphId, index) => ({
        policyEnvelope: {
          payload: { accessPolicy: index === 4 ? 1 : 0, contextGraphId },
        },
        targets: [],
      })),
    };
    internals.subscribedContextGraphs.clear();
    internals.subscribedContextGraphs.set('legacy-member', { subscribed: true });
    internals.subscribedContextGraphs.set('legacy-core', {
      subscribed: false,
      coreHosted: true,
    });

    expect(internals.rfc64SelectedVmReconcileTargetIds()).toEqual(['legacy-a', 'legacy-z']);
  });

  it.each([false, true])(
    'keeps catalog-selected VM reconciliation active without a member subscription (kill=%s)',
    async (killSwitch) => {
      const chain = new MockChainAdapter();
      agent = await DKGAgent.create({
        name: `Rfc64CatalogVmSweep-${killSwitch}`,
        chainAdapter: chain,
      });
      stubNode(agent);
      const internals = agent as unknown as AgentInternals;
      const selected = `rfc64-catalog-vm-${killSwitch}`;
      const config = (internals as any).config;
      config.syncContextGraphs = [];
      config.rfc64CatalogExecutionPlan = resolveRfc64CatalogExecutionPlanV1({
        configuredContextGraphs: [],
        activation: {
          enabled: true,
          selectedContextGraphs: [selected],
          selectedPublicContextGraphs: [selected],
          rollout: {
            killSwitch,
            contextGraphModes: { [selected]: 'catalog' },
          },
        },
      });
      config.rfc64CatalogBootstrap = {
        acceptedPolicies: [{
          policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: selected } },
          targets: [],
        }],
      };
      internals.subscribedContextGraphs.clear();
      const dispatch = vi.fn(async (_cg: string, _reason: 'live' | 'periodic' | 'manual') => true);
      installVmReconcileScheduling(
        internals,
        new VmReconcileSchedulingRuntime(dispatch, () => undefined),
      );

      await internals.runVmReconcileSweep();

      expect(dispatch).toHaveBeenCalledWith(selected, 'periodic');
      expect(internals.subscribedContextGraphs.size).toBe(0);
      expect(config.syncContextGraphs).toEqual([]);
    },
  );

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

  it('gives explicit Edge subscriptions balanced recent VM slots without changing Core ordering', async () => {
    const target = {
      kind: 'subscription',
      sub: {
        syncMode: 'always-on',
        subscribed: true,
        synced: true,
        onChainId: '298',
      },
      onChainId: '298',
      onChainCgId: 298n,
      cursor: { watermark: 0, scanOrdinal: 0, ahead: new Map() },
      watermarkBefore: 0,
      bindingGeneration: 0,
      bindingKind: 'authoritative',
    };

    const edgeChain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'Rfc64EdgeSubscribedVmPriority',
      chainAdapter: edgeChain,
      nodeRole: 'edge',
    });
    stubNode(agent);
    let deps = (agent as any).createVmReconcileDeps(
      'edge-selected-cg',
      (agent as any).vmReconcileLifecycleGeneration,
      target,
    );
    expect(deps.recentOrdinalsPerPass).toBeGreaterThan(0);

    await agent.stop();
    agent = null;
    const coreChain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'Rfc64CoreHostedVmHistory',
      chainAdapter: coreChain,
      nodeRole: 'core',
    });
    stubNode(agent);
    deps = (agent as any).createVmReconcileDeps(
      'core-hosted-cg',
      (agent as any).vmReconcileLifecycleGeneration,
      {
        ...target,
        sub: { ...target.sub, coreHosted: true },
      },
    );
    expect(deps.recentOrdinalsPerPass).toBe(0);
  });

  it('preserves selected-only chain binding safety failures without creating cursor state', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'Rfc64SelectedVmAmbiguousBinding', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const selected = 'rfc64-selected-vm-ambiguous';
    (internals as any).config.syncContextGraphs = [selected];
    (internals as any).config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: {
          payload: { accessPolicy: 0, contextGraphId: selected },
        },
        targets: [],
      }],
    };
    const ambiguity = new Error('ambiguous name hash resolves to 2 numeric ids');
    vi.spyOn(chain, 'resolveContextGraphIdByNameHash').mockRejectedValue(ambiguity);

    await expect((internals as any).resolveVmReconcileTarget(selected))
      .rejects.toBe(ambiguity);
    expect((internals as any).selectedVmReconcileCursors.has(selected)).toBe(false);
    expect(internals.subscribedContextGraphs.size).toBe(0);
  });

  it('executes selected-only VM reconciliation with a dedicated durable cursor and no subscription-owned work', async () => {
    const chain = new MockChainAdapter();
    const selected = 'rfc64-selected-vm-execute';
    const savedSelectedCursor = vi.fn(async () => undefined);
    const replicationEvents: Array<Record<string, unknown>> = [];
    agent = await DKGAgent.create({
      name: 'Rfc64SelectedVmExecute',
      chainAdapter: chain,
      onReplicationEvent: (event) => { replicationEvents.push(event as unknown as Record<string, unknown>); },
    });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const config = (internals as any).config;
    config.syncContextGraphs = [selected];
    config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: selected } },
        targets: [],
      }],
    };
    config.contextGraphSubscriptionStore = {
      loadAll: async () => [],
      save: async () => undefined,
      delete: async () => undefined,
    };
    config.selectedVmReconcileCursorStore = {
      loadSelectedVmReconcileCursor: async () => null,
      saveSelectedVmReconcileCursor: savedSelectedCursor,
    };
    const passiveDiscoveryRow = {
      subscribed: false,
      coreHosted: false,
      synced: false,
    };
    internals.subscribedContextGraphs.set(selected, passiveDiscoveryRow);

    const resolveOnChainId = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockResolvedValue(298n);
    chain.getContextGraphKCCount = vi.fn(async () => 1n);
    Object.assign(chain, { getBlockNumber: vi.fn(async () => 100) });
    const reconcileOrdinal = vi.fn(async (
      _localCgId: string,
      _onChainCgId: bigint,
      _ordinal: number,
      _headBlock: number | undefined,
      options: { revalidateTarget?: () => Promise<boolean> },
    ) => {
      expect(await options.revalidateTarget?.()).toBe(true);
      return { status: 'reconciled' as const, blockNumber: 1 };
    });
    (internals as any).reconcileChainOrdinal = reconcileOrdinal;
    const persistSubscription = vi.fn(async () => undefined);
    (internals as any).persistContextGraphSubscriptionStrict = persistSubscription;
    const heal = vi.fn(async () => undefined);
    (internals as any).healStrandedScopedKCs = heal;
    const flush = vi.fn(async () => undefined);
    internals.store.flush = flush;

    const result = await (internals as any).executeVmReconcileForCg(selected, 'manual');

    expect(result).toMatchObject({
      contextGraphId: selected,
      onChainId: '298',
      watermarkBefore: 0,
      watermarkAfter: 1,
      reconciledOrdinals: 1,
    });
    expect(resolveOnChainId).toHaveBeenCalledTimes(2);
    expect(reconcileOrdinal).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(savedSelectedCursor).toHaveBeenCalledWith({
      deploymentId: chain.deploymentId,
      contextGraphId: selected,
      onChainContextGraphId: '298',
      nameHash: (internals as any).contextGraphNameCommitment(selected),
      watermark: 1,
    });
    expect((internals as any).selectedVmReconcileCursors.get(selected)).toMatchObject({
      record: { onChainContextGraphId: '298', watermark: 1 },
      cursor: { watermark: 1 },
    });
    expect(replicationEvents).toContainEqual(expect.objectContaining({
      contextGraphId: selected,
      onChainCgId: '298',
      action: 'cursor-advance',
      fromWatermark: 0,
      toWatermark: 1,
    }));
    expect(persistSubscription).not.toHaveBeenCalled();
    expect(heal).not.toHaveBeenCalled();
    expect(internals.subscribedContextGraphs.get(selected)).toBe(passiveDiscoveryRow);
  });

  it('fails closed before selected-only VM materialization when the chain binding changes', async () => {
    const chain = new MockChainAdapter();
    const selected = 'rfc64-selected-vm-pre-materialization-fence';
    const saveSelectedVmReconcileCursor = vi.fn(async () => undefined);
    agent = await DKGAgent.create({
      name: 'Rfc64SelectedVmPreMaterializationFence',
      chainAdapter: chain,
    });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const config = (internals as any).config;
    config.syncContextGraphs = [selected];
    config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: selected } },
        targets: [],
      }],
    };
    config.selectedVmReconcileCursorStore = {
      loadSelectedVmReconcileCursor: async () => null,
      saveSelectedVmReconcileCursor,
    };

    const resolveOnChainId = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockResolvedValueOnce(298n)
      .mockResolvedValueOnce(299n);
    chain.getContextGraphKCCount = vi.fn(async () => 1n);
    Object.assign(chain, { getBlockNumber: vi.fn(async () => 100) });
    chain.getContextGraphKCAt = vi.fn(async () => 42n);
    chain.getLatestMerkleRoot = vi.fn(async () => new Uint8Array(32).fill(7));
    chain.getLatestMerkleRootPublisher = vi.fn(async () => `0x${'11'.repeat(20)}`);
    const handleChainReconciledKC = vi.fn(async () => 'finalized' as const);
    (internals as any).getOrCreateFinalizationHandler = vi.fn(() => ({
      handleChainReconciledKC,
    }));
    const flush = vi.fn(async () => undefined);
    internals.store.flush = flush;

    const result = await (internals as any).executeVmReconcileForCg(selected, 'manual');

    expect(result).toMatchObject({
      contextGraphId: selected,
      onChainId: '298',
      watermarkBefore: 0,
      watermarkAfter: 0,
      reconciledOrdinals: 0,
    });
    expect(resolveOnChainId).toHaveBeenCalledTimes(2);
    expect(handleChainReconciledKC).not.toHaveBeenCalled();
    expect(saveSelectedVmReconcileCursor).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect((internals as any).selectedVmReconcileCursors.get(selected)).toMatchObject({
      record: { onChainContextGraphId: '298', watermark: 0 },
      cursor: { watermark: 0 },
    });
  });

  it('retains selected-only VM progress across passive discovery updates', async () => {
    const chain = new MockChainAdapter();
    const selected = 'rfc64-selected-vm-passive-discovery';
    agent = await DKGAgent.create({
      name: 'Rfc64SelectedVmPassiveDiscovery',
      chainAdapter: chain,
    });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const config = (internals as any).config;
    config.syncContextGraphs = [selected];
    config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: selected } },
        targets: [],
      }],
    };
    config.contextGraphSubscriptionStore = {
      loadAll: async () => [],
      save: async () => undefined,
      delete: async () => undefined,
    };
    vi.spyOn(chain, 'resolveContextGraphIdByNameHash').mockResolvedValue(298n);

    const target = await (internals as any).resolveVmReconcileTarget(selected);
    target.cursor.watermark = 17;
    target.selectedState.record = {
      ...target.selectedState.record,
      watermark: 17,
    };
    const selectedState = target.selectedState;

    (internals as any).setContextGraphSubscription(selected, {
      subscribed: false,
      coreHosted: false,
      synced: false,
    });
    (internals as any).setContextGraphSubscription(selected, {
      subscribed: false,
      coreHosted: false,
      synced: true,
    });

    expect((internals as any).selectedVmReconcileCursors.get(selected)).toBe(selectedState);
    expect(selectedState).toMatchObject({
      record: { onChainContextGraphId: '298', watermark: 17 },
      cursor: { watermark: 17 },
    });
  });

  it('hydrates a selected VM cursor after restart and resets it for a new numeric binding', async () => {
    const selected = 'rfc64-selected-vm-restart';
    const durableCursors = new Map<string, {
      deploymentId: string;
      contextGraphId: string;
      onChainContextGraphId: string;
      nameHash: string;
      watermark: number;
    }>();
    const selectedCursorStore = {
      loadSelectedVmReconcileCursor: async (
        deploymentId: string,
        contextGraphId: string,
        onChainId: string,
      ) => durableCursors.get(`${deploymentId}\0${contextGraphId}\0${onChainId}`) ?? null,
      saveSelectedVmReconcileCursor: async (record: {
        deploymentId: string;
        contextGraphId: string;
        onChainContextGraphId: string;
        nameHash: string;
        watermark: number;
      }) => {
        durableCursors.set(
          `${record.deploymentId}\0${record.contextGraphId}\0${record.onChainContextGraphId}`,
          record,
        );
      },
    };
    const configure = (internals: AgentInternals): void => {
      const config = (internals as any).config;
      config.syncContextGraphs = [selected];
      config.rfc64PublicCatalogBootstrap = {
        acceptedPublicPolicies: [{
          policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: selected } },
          targets: [],
        }],
      };
      config.selectedVmReconcileCursorStore = selectedCursorStore;
    };

    const firstChain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'Rfc64SelectedVmCursorWriter', chainAdapter: firstChain });
    stubNode(agent);
    let internals = agent as unknown as AgentInternals;
    configure(internals);
    vi.spyOn(firstChain, 'resolveContextGraphIdByNameHash').mockResolvedValue(298n);
    const firstTarget = await (internals as any).resolveVmReconcileTarget(selected);
    await (internals as any).persistVmReconcileWatermark(selected, 7, firstTarget);
    expect(durableCursors.get(
      `${firstChain.deploymentId}\0${selected}\0${'298'}`,
    )).toMatchObject({ watermark: 7 });

    await agent.stop();
    agent = null;
    const secondChain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'Rfc64SelectedVmCursorReader', chainAdapter: secondChain });
    stubNode(agent);
    internals = agent as unknown as AgentInternals;
    configure(internals);
    const resolveOnChainId = vi.spyOn(secondChain, 'resolveContextGraphIdByNameHash')
      .mockResolvedValueOnce(298n)
      .mockResolvedValueOnce(299n);

    const restartedTarget = await (internals as any).resolveVmReconcileTarget(selected);
    expect(restartedTarget).toMatchObject({
      kind: 'rfc64-selected',
      onChainId: '298',
      cursor: { watermark: 7 },
    });
    const oldGeneration = (internals as any).vmReconcileLifecycleGeneration;
    expect((internals as any).isVmReconcileTargetCurrent(
      selected,
      restartedTarget,
      oldGeneration,
    )).toBe(true);

    const reboundTarget = await (internals as any).resolveVmReconcileTarget(selected);
    expect(reboundTarget).toMatchObject({
      kind: 'rfc64-selected',
      onChainId: '299',
      cursor: { watermark: 0 },
    });
    expect((internals as any).isVmReconcileTargetCurrent(
      selected,
      restartedTarget,
      oldGeneration,
    )).toBe(false);
    expect((internals as any).isVmReconcileTargetCurrent(
      selected,
      reboundTarget,
      oldGeneration,
    )).toBe(true);
    expect(resolveOnChainId).toHaveBeenCalledTimes(2);
    expect(internals.subscribedContextGraphs.size).toBe(0);
  });

  it('starts from zero after a chain redeploy reuses the same local name and numeric id', async () => {
    const selected = 'rfc64-selected-vm-redeploy';
    const chain = new MockChainAdapter('mock:deployment-b');
    agent = await DKGAgent.create({
      name: 'Rfc64SelectedVmRedeployFence',
      chainAdapter: chain,
    });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const nameHash = (internals as any).contextGraphNameCommitment(selected) as string;
    const oldRecord = {
      deploymentId: 'mock:deployment-a',
      contextGraphId: selected,
      onChainContextGraphId: '298',
      nameHash,
      watermark: 41,
    };
    const durableCursors = new Map([
      [`${oldRecord.deploymentId}\0${selected}\0${oldRecord.onChainContextGraphId}`, oldRecord],
    ]);
    const loadSelectedVmReconcileCursor = vi.fn(async (
      deploymentId: string,
      contextGraphId: string,
      onChainId: string,
    ) => durableCursors.get(`${deploymentId}\0${contextGraphId}\0${onChainId}`) ?? null);
    const saveSelectedVmReconcileCursor = vi.fn(async (record: {
      deploymentId: string;
      contextGraphId: string;
      onChainContextGraphId: string;
      nameHash: string;
      watermark: number;
    }) => {
      durableCursors.set(
        `${record.deploymentId}\0${record.contextGraphId}\0${record.onChainContextGraphId}`,
        record,
      );
    });
    const config = (internals as any).config;
    config.syncContextGraphs = [selected];
    config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: selected } },
        targets: [],
      }],
    };
    config.contextGraphSubscriptionStore = {
      loadAll: async () => [],
      save: async () => undefined,
    };
    config.selectedVmReconcileCursorStore = {
      loadSelectedVmReconcileCursor,
      saveSelectedVmReconcileCursor,
    };
    vi.spyOn(chain, 'resolveContextGraphIdByNameHash').mockResolvedValue(298n);

    const target = await (internals as any).resolveVmReconcileTarget(selected);

    expect(loadSelectedVmReconcileCursor).toHaveBeenCalledWith(
      'mock:deployment-b',
      selected,
      '298',
    );
    expect(target).toMatchObject({
      kind: 'rfc64-selected',
      deploymentId: 'mock:deployment-b',
      onChainId: '298',
      nameHash,
      cursor: { watermark: 0 },
    });
    await (internals as any).persistVmReconcileWatermark(selected, 3, target);
    expect(saveSelectedVmReconcileCursor).toHaveBeenCalledWith({
      deploymentId: 'mock:deployment-b',
      contextGraphId: selected,
      onChainContextGraphId: '298',
      nameHash,
      watermark: 3,
    });
    expect(durableCursors.get(
      `mock:deployment-a\0${selected}\0${'298'}`,
    )).toMatchObject({ watermark: 41 });
  });

  it('fails selected target revalidation when the chain name-hash binding changes', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'Rfc64SelectedVmChainFence', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const selected = 'rfc64-selected-vm-chain-fence';
    const config = (internals as any).config;
    config.syncContextGraphs = [selected];
    config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: selected } },
        targets: [],
      }],
    };
    const resolveOnChainId = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockResolvedValueOnce(298n)
      .mockResolvedValueOnce(299n);
    const target = await (internals as any).resolveVmReconcileTarget(selected);

    await expect((internals as any).revalidateVmReconcileTarget(
      selected,
      target,
      (internals as any).vmReconcileLifecycleGeneration,
    )).resolves.toBe(false);
    expect(resolveOnChainId).toHaveBeenCalledTimes(2);
    expect(internals.subscribedContextGraphs.size).toBe(0);
  });

  it('resolves and revalidates selected-only VM targets through finalized snapshots only', async () => {
    const chain = new MockChainAdapter();
    const selected = 'rfc64-selected-vm-finalized-fence';
    let onChainId = '298';
    const index = installFinalizedVmIndex(chain, async (nameHashes) => new Map([
      [nameHashes[0]!, finalizedVmSnapshot(selected, onChainId)],
    ]));
    agent = await DKGAgent.create({ name: 'Rfc64SelectedVmFinalizedFence', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const config = (internals as any).config;
    config.syncContextGraphs = [selected];
    config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: selected } },
        targets: [],
      }],
    };
    const legacyLookup = vi.spyOn(chain, 'resolveContextGraphIdByNameHash');

    const target = await (internals as any).resolveVmReconcileTarget(selected);
    onChainId = '299';
    await expect((internals as any).revalidateVmReconcileTarget(
      selected,
      target,
      (internals as any).vmReconcileLifecycleGeneration,
    )).resolves.toBe(false);

    expect(target).toMatchObject({ kind: 'rfc64-selected', onChainId: '298' });
    expect(index.resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes)
      .toHaveBeenCalledTimes(2);
    expect(index.whenIdle).toHaveBeenCalledTimes(2);
    expect(legacyLookup).not.toHaveBeenCalled();
    expect(internals.subscribedContextGraphs.size).toBe(0);
  });

  it('keeps VM reconciliation armed when only the periodic peer-sync reconciler is off', async () => {
    agent = await DKGAgent.create({
      name: 'PeerSyncOffVmOn',
      chainAdapter: new MockChainAdapter(),
      syncReconcilerEnabled: false,
    });
    expect((agent as any).vmReconcileEnabled()).toBe(true);
  });

  it('keeps every VM reconcile entry point dormant when vmReconcilerEnabled is false', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'Rfc64SelectedVmDisabled',
      chainAdapter: chain,
      vmReconcilerEnabled: false,
    });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const selected = 'rfc64-selected-vm-disabled';
    const config = (internals as any).config;
    config.syncContextGraphs = [selected];
    config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{
        policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: selected } },
        targets: [],
      }],
    };
    const dispatch = vi.fn(async (_cg: string, _reason: 'live' | 'periodic' | 'manual') => true);
    installVmReconcileScheduling(
      internals,
      new VmReconcileSchedulingRuntime(dispatch, () => undefined),
    );
    const resolveOnChainId = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockResolvedValue(298n);

    expect((internals as any).vmReconcileEnabled()).toBe(false);
    await internals.runVmReconcileSweep();
    expect(dispatch).not.toHaveBeenCalled();
    await expect((internals as any).resolveVmReconcileTarget(selected))
      .rejects.toMatchObject({ name: 'VmReconcileUnavailableError' });
    expect(resolveOnChainId).not.toHaveBeenCalled();
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

  it('an ignored live event heals through the bounded periodic sweep once ontology metadata is available', async () => {
    // An unknown numeric event does no global lookup. The periodic safety net
    // still resolves and strictly persists all three already-present bindings.
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'KacgNudgeLive', chainAdapter: chain });
    stubNode(agent);
    vi.spyOn(agent, 'canReadContextGraph').mockResolvedValue(true);
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

    const { dispatcher, triggered } = targetDispatcher(internals);

    // The event names ON_HIT's on-chain id. None is bound yet.
    const reconciled = await internals.handleKARegisteredNudge(ON_HIT, 99n, createOperationContext('system'));

    expect(reconciled).toBeNull();
    expect(triggered).toEqual([]);
    expect(internals.subscribedContextGraphs.get(CG_HIT)?.onChainId).toBeUndefined();
    await internals.runVmReconcileSweep();
    await dispatcher.waitForIdle();
    expect(internals.subscribedContextGraphs.get(CG_HIT)?.onChainId).toBe(ON_HIT);
    expect(internals.subscribedContextGraphs.get(CG_MISS_A)?.onChainId).toBe(ON_MISS_A);
    expect(internals.subscribedContextGraphs.get(CG_MISS_B)?.onChainId).toBe(ON_MISS_B);
    expect(triggered).toEqual([CG_HIT, CG_MISS_A, CG_MISS_B].map((cg) => `periodic:${cg}`));
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
    const scheduling = new VmReconcileSchedulingRuntime(async (cg, source) => {
      triggered.push(`${source}:${cg}`);
      return true;
    }, () => undefined);
    installVmReconcileScheduling(internals, scheduling);

    const reconciled = await internals.handleKARegisteredNudge(ON_BOUND, 1n, createOperationContext('system'));
    await internals.vmReconcileScheduling.waitForIdle();
    expect(reconciled).toBe(CG_BOUND);
    expect(triggered).toEqual([`live:${CG_BOUND}`]);
  });

  it('releases an unbound discovery failure when a binding lands before the next periodic sweep', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'SelfPrimeBindingReleasesLiveHold', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'gh1098-late-binding';
    const onChainId = '8081';
    const sub = { subscribed: true };
    internals.subscribedContextGraphs.set(localCgId, sub);
    vi.spyOn(agent, 'canReadContextGraph').mockResolvedValue(true);
    internals.resolveContextGraphOnChainIdBinding = async () => null;
    const { dispatcher, triggered } = targetDispatcher(internals);

    await expect(dispatcher.dispatch(localCgId, 'periodic')).rejects.toBeDefined();
    expect(triggered).toEqual([]);

    internals.bindSubscriptionOnChainId(localCgId, sub, onChainId);
    await expect(internals.handleKARegisteredNudge(
      onChainId,
      1n,
      createOperationContext('system'),
    )).resolves.toBe(localCgId);
    await dispatcher.waitForIdle(localCgId);

    expect(triggered).toEqual([`live:${localCgId}`]);
  });
});

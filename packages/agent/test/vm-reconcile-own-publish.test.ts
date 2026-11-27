/**
 * The VM reconcile work that follows this node's own publish.
 *
 * After a confirmed publish the chain-event poller sees the KA's registration
 * and nudges a reconcile pass for the same graph. That pass only finds the copy
 * the publish stored (`chain-promote action=already`), yet it scanned the
 * graph's new ordinals and flushed the whole embedded store, and the next share
 * or publish waited behind it on the store's one worker.
 *
 * - The nudge for the node's own just-confirmed registration starts no pass;
 *   the periodic sweep reconciles the ordinal.
 * - Every successful pass awaits the storage barrier before saving a watermark.
 *   Storage itself avoids rewriting a generation already persisted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter, buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import { DKGEvent, createGraphKnowledgeAssetScope, createOperationContext, type KnowledgeAssetConfirmedEvent } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { wrapPublisherForTest, mockSealCtx } from '../../publisher/test/_helpers/seal.js';
import { mockChainStubACKProvider } from '../../publisher/test/_helpers/acks.js';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { packKnowledgeAssetIdFromIdentity } from '../src/ka-identity.js';
import { knowledgeAssetSharedMemoryGraph, knowledgeAssetVerifiedMemoryGraph, stageKnowledgeAssetInSharedMemory } from './_helpers/staged-knowledge-asset.js';
import { DKGAgent } from '../src/index.js';
import {
  VmReconcileSchedulingRuntime,
  reconcileContextGraph,
  type ChainReconcilerDeps,
  type OrdinalOutcome,
} from '../src/chain-reconciler.js';
import { createCursorState } from '../src/reconcile-cursor.js';

interface AgentInternals {
  handleKARegisteredNudge(onChainId: string, kaId: bigint, ctx: unknown): Promise<string | null>;
  rememberOwnConfirmedRegistration(event: KnowledgeAssetConfirmedEvent): void;
  subscribedContextGraphs: Map<string, { subscribed: boolean; coreHosted?: boolean; onChainId?: string }>;
  vmReconcileScheduling: VmReconcileSchedulingRuntime<boolean>;
  store: { flush?: (...args: unknown[]) => Promise<void> };
  config: Record<string, any>;
}

function stubNode(agent: DKGAgent): void {
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWOwnPublishTestPeer',
    libp2p: { getPeers: () => [] },
  };
}

function recordTriggers(internals: AgentInternals): string[] {
  const triggered: string[] = [];
  internals.vmReconcileScheduling = new VmReconcileSchedulingRuntime(async (cg, source) => {
    triggered.push(`${source}:${cg}`);
    return true;
  }, () => undefined);
  return triggered;
}

describe('reconcileContextGraph — what a pass wrote', () => {
  const deps = (outcomes: OrdinalOutcome[], headBlock?: number): ChainReconcilerDeps => ({
    getKCCount: async () => outcomes.length,
    getHeadBlock: async () => headBlock,
    reconcileOrdinal: async (_cg, _onChain, ordinal) => outcomes[ordinal]!,
    persistWatermark: () => undefined,
    confirmationDepth: 5,
    log: () => undefined,
  });

  it('tells copies it stored apart from copies already in VM', async () => {
    const result = await reconcileContextGraph(deps([
      { status: 'already', blockNumber: 100 },
      { status: 'reconciled', blockNumber: 100 },
      { status: 'pending' },
    ], 100), createCursorState(0), 'cg', 1n);
    // Both completions wait five blocks for the watermark; only ordinal 2 is still to do.
    expect(result).toMatchObject({ reconciled: 2, materialized: 1, pending: 1, watermark: 0 });
  });

  it('reports nothing written for a pass that only found copies already in VM', async () => {
    const result = await reconcileContextGraph(deps([
      { status: 'already', blockNumber: 100 },
      { status: 'already', blockNumber: 100 },
    ], 100), createCursorState(0), 'cg', 1n);
    expect(result).toMatchObject({ reconciled: 2, materialized: 0, pending: 0, watermark: 0 });
  });
});

describe('VM reconcile after this node\'s own publish', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) { await agent.stop().catch(() => undefined); agent = null; }
    vi.restoreAllMocks();
  });

  async function boundAgent(name: string) {
    agent = await DKGAgent.create({ name, chainAdapter: new MockChainAdapter() });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    internals.subscribedContextGraphs.set('vm-smoke', { subscribed: true, onChainId: '1217' });
    return { internals, triggered: recordTriggers(internals) };
  }

  it('starts no pass for the chain event of its own just-confirmed publish', async () => {
    const { internals, triggered } = await boundAgent('OwnPublishNudge');
    internals.rememberOwnConfirmedRegistration({
      contextGraphId: 'vm-smoke', onChainContextGraphId: 1217n, kaId: 150n, txHash: '0x01',
    });

    expect(await internals.handleKARegisteredNudge('1217', 150n, createOperationContext('system'))).toBe('vm-smoke');
    await internals.vmReconcileScheduling.waitForIdle();
    expect(triggered).toEqual([]);

    // Another node's KA in the same graph still reconciles at once, and so does
    // a replay of the own event once it has been used.
    await internals.handleKARegisteredNudge('1217', 151n, createOperationContext('system'));
    await internals.vmReconcileScheduling.waitForIdle();
    await internals.handleKARegisteredNudge('1217', 150n, createOperationContext('system'));
    await internals.vmReconcileScheduling.waitForIdle();
    expect(triggered).toEqual(['live:vm-smoke', 'live:vm-smoke']);
  });

  it('keeps the pass when the copy went to a sub-graph or another local graph', async () => {
    const { internals, triggered } = await boundAgent('OwnPublishNudgeOtherGraph');
    internals.rememberOwnConfirmedRegistration({
      contextGraphId: 'vm-smoke', subGraphName: 'part', onChainContextGraphId: 1217n, kaId: 160n, txHash: '0x02',
    });
    internals.rememberOwnConfirmedRegistration({
      contextGraphId: 'remapped-source', onChainContextGraphId: 1217n, kaId: 161n, txHash: '0x03',
    });

    await internals.handleKARegisteredNudge('1217', 160n, createOperationContext('system'));
    await internals.vmReconcileScheduling.waitForIdle();
    await internals.handleKARegisteredNudge('1217', 161n, createOperationContext('system'));
    await internals.vmReconcileScheduling.waitForIdle();
    expect(triggered).toEqual(['live:vm-smoke', 'live:vm-smoke']);
  });

  /** The selected-only target fixture of vm-reconcile-self-prime.test.ts, with one ordinal. */
  async function selectedTarget(name: string, outcome: OrdinalOutcome['status']) {
    const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 1217n });
    const selected = `own-publish-${name.toLowerCase()}`;
    await chain.createOnChainContextGraph({ nameHash: ethers.keccak256(ethers.toUtf8Bytes(selected)), accessPolicy: 0, publishPolicy: 1 });
    const saveSelectedVmReconcileCursor = vi.fn(async () => undefined);
    agent = await DKGAgent.create({ name, chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    internals.config.syncContextGraphs = [selected];
    internals.config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{ policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: selected } }, targets: [] }],
    };
    internals.config.selectedVmReconcileCursorStore = {
      loadSelectedVmReconcileCursor: async () => null,
      saveSelectedVmReconcileCursor,
    };
    vi.spyOn(chain, 'resolveContextGraphIdByNameHash').mockResolvedValue(1217n);
    chain.getContextGraphKCCount = vi.fn(async () => 1n);
    const head = { block: 100 };
    Object.assign(chain, { getBlockNumber: vi.fn(async () => head.block) });
    const originalOrdinal = agent.reconcileChainOrdinal.bind(agent);
    (internals as any).reconcileChainOrdinal = vi.fn(async (
      _cg: string, _onChain: bigint, _ordinal: number, headBlock: number | undefined,
    ) => {
      if (outcome === 'reconciled') await internals.store.insert([{
        subject: 'urn:observed:write', predicate: 'urn:observed:predicate', object: '"value"', graph: 'urn:observed:graph',
      }]);
      return outcome === 'pending' ? { status: 'pending' } : { status: outcome, blockNumber: headBlock ?? 0 };
    });
    (internals as any).healStrandedScopedKCs = vi.fn(async () => undefined);
    const flush = vi.fn(async () => undefined);
    internals.store.flush = flush;
    const pass = () => (internals as any).executeVmReconcileForCg(selected, 'manual');
    return { pass, flush, head, saveSelectedVmReconcileCursor, internals, chain, selected, originalOrdinal };
  }

  it('awaits the storage barrier even for an already-local pass, before any watermark', async () => {
    const { pass, flush, head, saveSelectedVmReconcileCursor } = await selectedTarget('AlreadyLocal', 'already');

    // The ordinal is complete but not yet five blocks deep: no watermark, nothing written.
    await expect(pass()).resolves.toMatchObject({ watermarkBefore: 0, watermarkAfter: 0 });
    expect(flush).toHaveBeenCalledOnce();
    expect(saveSelectedVmReconcileCursor).not.toHaveBeenCalled();

    head.block = 106;
    await expect(pass()).resolves.toMatchObject({ watermarkBefore: 0, watermarkAfter: 1 });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(saveSelectedVmReconcileCursor).toHaveBeenCalledOnce();
    expect(flush.mock.invocationCallOrder[1]!)
      .toBeLessThan(saveSelectedVmReconcileCursor.mock.invocationCallOrder[0]!);
  });

  it('still flushes a pass that stored a copy itself, before any watermark', async () => {
    const { pass, flush, saveSelectedVmReconcileCursor } = await selectedTarget('StoredCopy', 'reconciled');

    await expect(pass()).resolves.toMatchObject({ watermarkBefore: 0, watermarkAfter: 0 });
    expect(flush).toHaveBeenCalledOnce();
    expect(saveSelectedVmReconcileCursor).not.toHaveBeenCalled();
  });
  async function realCopyFixture(name: string) {
    const f = await selectedTarget(name, 'already');
    agent!.reconcileChainOrdinal = f.originalOrdinal;
    const store = (f.internals as any).store;
    const author = '0x9277a1a194fcadbb60d8df0c472e7909ead50e33';
    const kaId = packKnowledgeAssetIdFromIdentity({ agentAddress: author, kaNumber: 1n });
    const triple = { subject: 'urn:durability:asset', predicate: 'http://schema.org/name', object: '"durable"' };
    const scope = createGraphKnowledgeAssetScope(buildKnowledgeAssetUal(f.chain.chainId, author, 1n), '1');
    f.chain.getLatestMerkleRootAuthor = async () => author;
    f.chain.__registerKC({ kaId, contextGraphId: 1217n,
      merkleRootHex: ethers.hexlify(computeFlatKCRootV10([{ ...triple, graph: '' }], [])), chunks: [] });
    const stage = () => stageKnowledgeAssetInSharedMemory({ store, contextGraphId: f.selected, scope,
      triples: [triple], shareOperationId: 'durability-share' });
    return { ...f, store, scope, triple, stage };
  }

  it('recovers a confirmed publish after its local VM write fails and its live nudge is suppressed', async () => {
    const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const chain = new MockChainAdapter('mock:31337', wallet.address, { initialContextGraphId: 1217n });
    chain.seedIdentity(wallet.address, 1n);
    chain.minimumRequiredSignatures = 1;
    chain.signMessage = async message => {
      const sig = ethers.Signature.from(await wallet.signMessage(message));
      return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
    };
    const selected = 'own-failed-vm-write';
    await chain.createOnChainContextGraph({ nameHash: ethers.keccak256(ethers.toUtf8Bytes(selected)), accessPolicy: 0, publishPolicy: 1 });
    const head = { block: 100 };
    Object.assign(chain, { getBlockNumber: async () => head.block });
    const saveCursor = vi.fn(async () => undefined);
    agent = await DKGAgent.create({ name: 'OwnFailedVmWrite', listenHost: '127.0.0.1', chainAdapter: chain,
      syncContextGraphs: [selected], rfc64CatalogActivation: { enabled: false }, syncReconcilerEnabled: true,
      selectedVmReconcileCursorStore: { loadSelectedVmReconcileCursor: async () => null, saveSelectedVmReconcileCursor: saveCursor },
    });
    const internal = agent as any;
    internal.config.rfc64PublicCatalogBootstrap = {
      acceptedPublicPolicies: [{ policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: selected } }, targets: [] }],
    };
    await agent.start(); // Installs the production KC_CONFIRMED listener.
    clearTimeout(internal.vmReconcileStartupTimer); clearInterval(internal.vmReconcileTimer);
    internal.vmReconcileStartupTimer = null; internal.vmReconcileTimer = null;
    internal.subscribedContextGraphs.set(selected, { subscribed: true, onChainId: '1217' });
    const execute = vi.spyOn(agent, 'executeVmReconcileForCg');
    const events: KnowledgeAssetConfirmedEvent[] = [];
    internal.eventBus.on(DKGEvent.KC_CONFIRMED, (event: KnowledgeAssetConfirmedEvent) => events.push(event));
    const store = internal.store;
    const insert = store.insert.bind(store);
    let failed = false;
    const insertFailure = vi.spyOn(store, 'insert').mockImplementation(async (quads: any, options: any) => {
      if (!failed && quads.some((quad: any) => quad.graph.includes('/_verifiable_memory/'))) {
        failed = true;
        expect(events).toHaveLength(1); // Failure is after receipt confirmation.
        throw new Error('injected post-confirmation VM write failure');
      }
      return insert(quads, options);
    });
    const publisher = wrapPublisherForTest(internal.publisher, { author: wallet,
      ctx: mockSealCtx({ chainId: await chain.getEvmChainId(), kav10Address: await chain.getKnowledgeAssetsLifecycleAddress() }),
      v10ACKProvider: mockChainStubACKProvider(),
    });
    const triple = { subject: 'urn:own-failed:asset', predicate: 'http://schema.org/name', object: '"recover me"' };
    await expect(publisher.publish({ contextGraphId: selected, onChainContextGraphId: 1217n,
      quads: [{ ...triple, graph: '' }] })).rejects.toThrow('injected post-confirmation VM write failure');
    insertFailure.mockRestore();
    expect(failed).toBe(true); expect(events).toHaveLength(1);
    const kaId = events[0]!.kaId!;
    const scope = createGraphKnowledgeAssetScope(buildKnowledgeAssetUal(chain.chainId, wallet.address, kaId & ((1n << 96n) - 1n)), '1');
    const vmGraph = knowledgeAssetVerifiedMemoryGraph(selected, scope);
    const hasCopy = () => store.query(`ASK { GRAPH <${vmGraph}> { <${triple.subject}> <${triple.predicate}> ${triple.object} } }`);
    await expect(hasCopy()).resolves.toMatchObject({ type: 'boolean', value: false });
    await internal.handleKARegisteredNudge('1217', kaId, createOperationContext('system'));
    await internal.vmReconcileScheduling.waitForIdle();
    expect(execute).not.toHaveBeenCalled();
    // The shared assertion is available to the periodic materializer, as from a successful share.
    await stageKnowledgeAssetInSharedMemory({ store, contextGraphId: selected, scope, triples: [triple], shareOperationId: 'failed-own-publish-share' });
    await agent.runVmReconcileSweep();
    await expect(hasCopy()).resolves.toMatchObject({ type: 'boolean', value: true });
    expect(execute).toHaveBeenCalled();
    head.block = 106;
    await agent.runVmReconcileSweep();
    await expect(execute.mock.results.at(-1)!.value).resolves.toMatchObject({ watermarkAfter: 1 });
  });

  it.each([false, true])('flushes real metadata repairs behind a held watermark (flush failure=%s)', async failFlush => {
    const f = await realCopyFixture(`MetadataRepair${failFlush}`);
    await f.stage();
    await f.store.insert([{ ...f.triple, graph: knowledgeAssetVerifiedMemoryGraph(f.selected, f.scope) }]);
    await f.store.dropGraph(knowledgeAssetSharedMemoryGraph(f.selected, f.scope));
    const handler = (agent as any).getOrCreateFinalizationHandler();
    const finalize = vi.spyOn(handler, 'handleChainReconciledKC');
    if (failFlush) f.flush.mockRejectedValueOnce(new Error('durability barrier failed'));
    if (failFlush) await expect(f.pass()).rejects.toThrow('durability barrier failed');
    else await expect(f.pass()).resolves.toMatchObject({ watermarkBefore: 0, watermarkAfter: 0 });
    expect(finalize).toHaveBeenCalled();
    await expect(finalize.mock.results[0]!.value).resolves.toBe('already-confirmed');
    expect(f.flush).toHaveBeenCalledOnce();
    expect(f.saveSelectedVmReconcileCursor).not.toHaveBeenCalled();
    await expect(f.store.query(`ASK { GRAPH <did:dkg:context-graph:${f.selected}/_meta> {
      <${f.scope.ual}> <http://dkg.io/ontology/status> "confirmed" } }`)).resolves.toMatchObject({ type: 'boolean', value: true });
  });

  it('retries a failed durability barrier when the next pass is read-only already', async () => {
    const f = await realCopyFixture('RetryFailedBarrier');
    await f.stage();
    await f.store.insert([{ ...f.triple, graph: knowledgeAssetVerifiedMemoryGraph(f.selected, f.scope) }]);
    await f.store.dropGraph(knowledgeAssetSharedMemoryGraph(f.selected, f.scope));
    f.flush.mockRejectedValueOnce(new Error('disk full'));
    await expect(f.pass()).rejects.toThrow('disk full');
    // No new writes or watermark are needed on retry; the earlier repair is
    // still visible in memory but has never crossed a successful barrier.
    agent!.reconcileChainOrdinal = vi.fn(async () => ({ status: 'already', blockNumber: 100 }));
    let release!: () => void;
    f.flush.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    let finished = false;
    const retry = f.pass().then((result: unknown) => { finished = true; return result; });
    await vi.waitFor(() => expect(f.flush).toHaveBeenCalledTimes(2));
    expect(finished).toBe(false);
    expect(f.saveSelectedVmReconcileCursor).not.toHaveBeenCalled();
    release();
    await expect(retry).resolves.toMatchObject({ watermarkBefore: 0, watermarkAfter: 0 });
    await f.pass();
    expect(f.flush).toHaveBeenCalledTimes(3); // Storage decides whether another snapshot is needed.
  });

  it('flushes fetched writes when real recovery revalidation reports already', async () => {
    const f = await realCopyFixture('FetchedAlready');
    const internals = f.internals as any;
    const peer = '12D3KooWRecoveryDurabilityPeer';
    internals.node.libp2p.getConnections = () => [{ remotePeer: { toString: () => peer } }];
    internals.preferredSyncPeers.set(f.selected, peer);
    internals.resolveCuratorPeerIdsForCg = async () => ({ peerIds: [peer], curatorIsLocal: false, legacyTripleResolved: false });
    internals.ensurePeerConnected = async () => {};
    internals.selectCatchupPeers = (peers: unknown[]) => peers;
    internals.waitForSyncProtocol = async () => true;
    internals.ensurePeerAdmittedForRecovery = async () => true;
    const ordinal = vi.fn(f.originalOrdinal);
    agent!.reconcileChainOrdinal = ordinal;
    const fetch = vi.fn(async (_peer: string, _cg: string, _selection: unknown, options: { onWorkStarted?: () => void }) => {
      options.onWorkStarted?.();
      await f.stage();
      // Model a fetched confirmed copy with the real materialization transaction.
      await expect(f.originalOrdinal(f.selected, 1217n, 0, 100)).resolves.toMatchObject({ status: 'reconciled' });
      return { admission: 'work-started', disposition: 'found', result: {
        fetchedDataTriples: 1, fetchedMetaTriples: 8, insertedTriples: 9,
        failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
      } };
    });
    internals.syncExactKnowledgeAssetsFromPeerDetailed = fetch;
    let release!: () => void;
    f.flush.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    let finished = false;
    const running = f.pass().then((result: unknown) => { finished = true; return result; });
    await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    expect(f.saveSelectedVmReconcileCursor).not.toHaveBeenCalled();
    release();
    await expect(running).resolves.toMatchObject({ watermarkBefore: 0, watermarkAfter: 0 });
    const outcomes = await Promise.all(ordinal.mock.results.map(result => result.value));
    expect(outcomes.map(outcome => outcome.status)).toEqual(['pending', 'already']);
  });

});

import { readHeldGraphScopedAssets } from '../src/sync/requester/durable-data-holdings.js';
import { createGraphScopedDurableManifestPlan } from '../src/sync/durable-integrity.js';
import { afterEach, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer, GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata, workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { getSyncCheckpointKey } from '../src/sync/checkpoint/state.js';
import { classifyDurableProgress } from '../src/sync/durable-progress.js';
import { stubLifecycleFetch } from './_helpers/sync-fetch-coalescing.js';
import { continueContextGraphSubscriptionLine } from '../src/context-graph-subscription-policy.js';

const CG = '323', PEER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const agents: DKGAgent[] = [];
afterEach(async () => { for (const agent of agents.splice(0)) await agent.stop(); vi.restoreAllMocks(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

it.each(['chain', 'worker'].flatMap(phase =>
  ['clean', 'deactivate', 'recreate', 'equivalent', 'drop-graph', 'remove-subgraph'].map(change => [phase, change] as const)).concat(['corrupt-before', 'unbound', 'binding-save-fails', 'cleanup-retry', 'newer-swm'].map(change => ['preexisting', change] as const)))(
  'fences held readiness through production recovery at %s: %s', async (phase, change) => {
    const chain = new MockChainAdapter('hardhat:31337');
    const savedBindings: string[] = [];
    const save = vi.fn(async (record: { onChainId?: string }) => {
      if (record.onChainId && change === 'binding-save-fails') throw new Error('subscription persistence failed');
      if (record.onChainId) savedBindings.push(record.onChainId);
    });
    const agent = await DKGAgent.create({ name: 'HeldProduction', listenHost: '127.0.0.1', chainAdapter: chain,
      contextGraphSubscriptionStore: { loadAll: async () => [], save, delete: async () => {} },
      rfc64CatalogActivation: { enabled: true, rollout: { killSwitch: true, defaultMode: 'legacy', contextGraphModes: { [CG]: 'legacy' } } } });
    agents.push(agent);
    await agent.start();
    const internal = agent as any;
    // The remote transport/admission is simulated; the recovery owner, execution,
    // authority, worker, mutation-observed store and both fences are production code.
    vi.spyOn(internal.networkAdmissionCoordinator, 'ensureAdmitted').mockResolvedValue(true);
    vi.spyOn(internal, 'ensurePeerConnected').mockResolvedValue(undefined);
    vi.spyOn(internal, 'ensurePeerAdmittedForRecovery').mockResolvedValue(true);
    const unbound = change === 'unbound' || change === 'binding-save-fails';
    const subscription = { syncMode: 'always-on' as const, subscribed: true, synced: false, ...(unbound ? {} : { onChainId: CG }) };
    const persist = vi.spyOn(internal, 'persistContextGraphSyncStateStrict');
    internal.subscribedContextGraphs.set(CG, subscription);
    const ual = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ef/7';
    const graph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, '1'), 'reports');
    const data: Quad[] = [{ subject: 'urn:held:subject', predicate: 'urn:held:value', object: '"held"', graph }];
    const root = computeFlatKCRootV10(data, []);
    const meta = generateGraphKnowledgeAssetMetadata({ ual, contextGraphId: CG, merkleRoot: root,
      publisherPeerId: 'publisher-peer', accessPolicy: 'public', timestamp: new Date(0), assertionVersion: '1',
      publicTripleCount: 1, privateTripleCount: 0, assertionGraph: graph, subGraphName: 'reports',
    }, { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
      batchId: 0n, materializedVersion: { blockNumber: 1, txIndex: 0 },
    } } });
    await internal.store.insert([...data, ...meta]);
    expect(internal.store).not.toHaveProperty('mutationOwner');
    expect(await readHeldGraphScopedAssets(internal.store, { contextGraphId: CG, descriptors: createGraphScopedDurableManifestPlan(meta, CG)!.descriptors })).toEqual(new Set([ual]));
    if (change === 'corrupt-before') {
      await internal.store.delete(data);
      await internal.store.insert([{ ...data[0]!, object: '"tampered"' }]);
    }
    const cleanup = change === 'cleanup-retry' || change === 'newer-swm';
    const swmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, createGraphKnowledgeAssetScope(ual, '1'), 'reports');
    const retire = vi.spyOn(internal, 'retireFinalizedSwmTwinCandidate');
    if (cleanup) {
      const ns = 'http://dkg.io/ontology/';
      const swmMeta = `did:dkg:context-graph:${CG}/reports/_shared_memory_meta`;
      const head = `${ual}#dkg-swm-head`, operation = `urn:dkg:share:${CG}:held-twin`;
      const version = change === 'newer-swm' ? '2' : '1';
      const integer = (value: string | number) => `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
      const row = (subject: string, predicate: string, object: string): Quad => ({ subject, predicate: ns + predicate, object, graph: swmMeta });
      await internal.store.insert([
        ...data.map(quad => ({ ...quad, graph: swmGraph, ...(change === 'newer-swm' ? { object: '"newer"' } : {}) })),
        row(head, 'contentScopeVersion', integer(GRAPH_KA_CONTENT_SCOPE_VERSION)), row(head, 'kaUal', ual),
        row(head, 'assertionVersion', integer(version)), row(head, 'assertionGraph', swmGraph),
        row(head, 'shareOperationId', '"held-twin"'),
        row(operation, 'shareOperationId', '"held-twin"'), row(operation, 'kaUal', ual),
        row(operation, 'assertionVersion', integer(version)),
        row(operation, 'publicQuadsDigest', `"${workspacePublicQuadsDigest(data)}"`),
        row(operation, 'publicQuadsCount', integer(1)), row(operation, 'privateTripleCount', integer(0)),
      ]);
      if (change === 'cleanup-retry') retire.mockRejectedValueOnce(new Error('temporary cleanup failure'));
    }
    const entered = deferred(), release = deferred();
    vi.spyOn(chain, 'getLatestMerkleRoot').mockImplementation(async () => {
      if (phase === 'chain') { entered.resolve(); await release.promise; }
      return root;
    });
    const processBatch = internal.processDurableBatchInWorker.bind(internal);
    vi.spyOn(internal, 'processDurableBatchInWorker').mockImplementation(async (...args: unknown[]) => {
      const processed = await processBatch(...args);
      if (phase === 'worker') { entered.resolve(); await release.promise; }
      return processed;
    });
    vi.spyOn(chain, 'getMerkleRootCount').mockResolvedValue(1n);
    vi.spyOn(chain, 'getKAContextGraphId').mockResolvedValue(323n);
    let dataRequests = 0;
    stubLifecycleFetch(agent, async call => {
      if (call.phase === 'data') dataRequests++;
      const quads = call.phase === 'meta' ? meta : (change === 'corrupt-before' || unbound) && call.phase === 'data' ? data : [];
      return { quads, bytesReceived: quads.length * 100, resumedFromOffset: 0, nextOffset: quads.length,
        checkpointKey: getSyncCheckpointKey(PEER, CG, false, call.phase), completed: true, timedOut: false };
    });
    expect(await internal.canUseLegacyDurableSyncForContextGraphV1(CG)).toBe(true);
    const run = agent.syncDurableRecoveryContextGraph(CG, {
      candidatePeerIds: [PEER], restrictToCandidatePeerIds: true, candidatesAreSyncCapable: true,
    });
    if (unbound) {
      const recovered = await run;
      expect(dataRequests).toBeGreaterThan(0);
      expect(recovered.result.verifiedHeldAssets ?? 0).toBe(0);
      expect(persist).toHaveBeenCalledWith(CG, expect.objectContaining({ onChainId: CG }), 'on-chain id binding', expect.any(Function));
      expect(recovered.outcome === 'terminal').toBe(change === 'unbound');
      expect(savedBindings).toEqual(change === 'unbound' ? [CG] : []);
      expect(internal.subscribedContextGraphs.get(CG).onChainId).toBe(change === 'unbound' ? CG : undefined);
      expect(internal.syncCheckpoints.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.terminal === true).toBe(change === 'unbound');
      return;
    }
    if (cleanup) {
      const recovered = await run;
      expect(recovered.outcome).toBe('terminal');
      expect(recovered.result.verifiedHeldAssets).toBe(1);
      expect(await internal.store.countQuads(swmGraph)).toBe(1);
      if (change === 'cleanup-retry') {
        expect(retire).toHaveBeenCalledTimes(1);
        const replay = await agent.syncDurableRecoveryContextGraph(CG, {
          candidatePeerIds: [PEER], restrictToCandidatePeerIds: true, candidatesAreSyncCapable: true,
        });
        expect(replay.outcome).toBe('terminal');
        expect(replay.result.verifiedHeldAssets).toBe(1);
        expect(retire).toHaveBeenCalledTimes(2);
        expect(await internal.store.countQuads(swmGraph)).toBe(0);
      } else {
        expect(retire).not.toHaveBeenCalled();
        const rows = await internal.store.query(`SELECT ?object WHERE { GRAPH <${swmGraph}> { ?subject ?predicate ?object } }`);
        expect(rows.bindings).toEqual([{ object: '"newer"' }]);
      }
      expect(dataRequests).toBe(0);
      return;
    }
    if (change === 'corrupt-before') {
      const recovered = await run;
      expect(dataRequests).toBeGreaterThan(0);
      expect(recovered.result.verifiedHeldAssets ?? 0).toBe(0);
      expect(recovered.outcome).toBe('terminal');
      const rows = await internal.store.query(`SELECT ?object WHERE { GRAPH <${graph}> { ?subject ?predicate ?object } }`);
      expect(rows.bindings).toEqual([{ object: '"held"' }]);
      return;
    }
    try {
      await Promise.race([entered.promise, run.then(result => { throw new Error('Recovery ended before the paused verification: ' + JSON.stringify(result)); })]);
      if (change === 'deactivate') {
        const next = { ...subscription, subscribed: false }; continueContextGraphSubscriptionLine(subscription, next);
        internal.subscribedContextGraphs.set(CG, next);
      } else if (change === 'recreate') {
        internal.subscribedContextGraphs.delete(CG); internal.subscribedContextGraphs.set(CG, { ...subscription });
      } else if (change === 'equivalent') {
        const next = { ...subscription, name: 'renamed' }; continueContextGraphSubscriptionLine(subscription, next);
        internal.subscribedContextGraphs.set(CG, next);
      } else if (change === 'drop-graph') await internal.store.dropGraph(graph);
      else if (change === 'remove-subgraph') await agent.removeSubGraph(CG, 'reports');
    } finally { release.resolve(); }
    const recovered = await run;
    const valid = change === 'clean' || change === 'equivalent';
    expect(recovered.outcome === 'terminal').toBe(valid);
    expect(recovered.result.verifiedHeldAssets ?? 0).toBe(valid ? 1 : 0);
    expect(classifyDurableProgress(recovered.result, { complete: recovered.result.complete }).completedReadinessCleanly).toBe(valid);
    expect(internal.syncCheckpoints.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.terminal === true).toBe(valid);
    expect(dataRequests).toBe(0);
    if (change === 'drop-graph' || change === 'remove-subgraph') expect(await internal.store.countQuads(graph)).toBe(0);
  }, 15_000,
);

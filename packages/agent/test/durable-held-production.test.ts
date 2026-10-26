import { readHeldGraphScopedAssets } from '../src/sync/requester/durable-data-holdings.js';
import { createGraphScopedDurableManifestPlan } from '../src/sync/durable-integrity.js';
import { afterEach, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
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
  ['clean', 'deactivate', 'recreate', 'equivalent', 'drop-graph', 'remove-subgraph'].map(change => [phase, change] as const)).concat([['preexisting', 'corrupt-before']]))(
  'fences held readiness through production recovery at %s: %s', async (phase, change) => {
    const chain = new MockChainAdapter('hardhat:31337');
    const agent = await DKGAgent.create({ name: 'HeldProduction', listenHost: '127.0.0.1', chainAdapter: chain,
      rfc64CatalogActivation: { enabled: true, rollout: { killSwitch: true, defaultMode: 'legacy', contextGraphModes: { [CG]: 'legacy' } } } });
    agents.push(agent);
    await agent.start();
    const internal = agent as any;
    // The remote transport/admission is simulated; the recovery owner, execution,
    // authority, worker, mutation-observed store and both fences are production code.
    vi.spyOn(internal.networkAdmissionCoordinator, 'ensureAdmitted').mockResolvedValue(true);
    vi.spyOn(internal, 'ensurePeerConnected').mockResolvedValue(undefined);
    vi.spyOn(internal, 'ensurePeerAdmittedForRecovery').mockResolvedValue(true);
    const subscription = { syncMode: 'always-on' as const, subscribed: true, synced: false, onChainId: CG };
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
    expect(internal.store.mutationOwner.contentFence).toBeDefined();
    expect(await readHeldGraphScopedAssets(internal.store, { contextGraphId: CG, descriptors: createGraphScopedDurableManifestPlan(meta, CG)!.descriptors })).toEqual(new Set([ual]));
    if (change === 'corrupt-before') {
      await internal.store.delete(data);
      await internal.store.insert([{ ...data[0]!, object: '"tampered"' }]);
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
      const quads = call.phase === 'meta' ? meta : change === 'corrupt-before' && call.phase === 'data' ? data : [];
      return { quads, bytesReceived: quads.length * 100, resumedFromOffset: 0, nextOffset: quads.length,
        checkpointKey: getSyncCheckpointKey(PEER, CG, false, call.phase), completed: true, timedOut: false };
    });
    expect(await internal.canUseLegacyDurableSyncForContextGraphV1(CG)).toBe(true);
    const run = agent.syncDurableRecoveryContextGraph(CG, {
      candidatePeerIds: [PEER], restrictToCandidatePeerIds: true, candidatesAreSyncCapable: true,
    });
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

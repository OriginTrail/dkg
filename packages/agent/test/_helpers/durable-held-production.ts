import { readHeldGraphScopedAssets } from './held-asset-membership.js';
import { partitionVerifiedGraphScopedAssets } from '../../src/sync/requester/verified-asset-preparation.js';
import { materializeVerifiedGraphScopedAsset } from '../../src/sync/requester/graph-scoped-materialization.js';
import { createGraphScopedDurableManifestPlan } from '../../src/sync/durable-integrity.js';
import { expect, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer, GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata, workspacePublicQuadsDigest, replaceLocallyTrustedKnowledgeAssetControlEnvelope, overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1 } from '@origintrail-official/dkg-publisher';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../../src/dkg-agent.js';
import { getSyncCheckpointKey } from '../../src/sync/checkpoint/state.js';
import { stubLifecycleFetch } from './sync-fetch-coalescing.js';

export const CG = '323', PEER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const agents: DKGAgent[] = [];
export async function stopHeldProductionAgents() { for (const agent of agents.splice(0)) await agent.stop(); }
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

export async function createHeldProductionHarness(options: { finalizedCleanup?: boolean; unbound?: boolean; failBindingSave?: boolean; localAccessPolicy?: 'public' | 'ownerOnly' } = {}) {
  const chain = new MockChainAdapter('hardhat:31337');
  const savedBindings: string[] = [];
  const save = vi.fn(async (record: { onChainId?: string }) => {
    if (record.onChainId && options.failBindingSave) throw new Error('subscription persistence failed');
    if (record.onChainId) savedBindings.push(record.onChainId);
  });
  const markPublished = vi.fn(async () => {});
  const agent = await DKGAgent.create({ name: 'HeldProduction', listenHost: '127.0.0.1', chainAdapter: chain,
    ...(options.finalizedCleanup ? { publicSnapshotStore: {
      putSnapshot: async () => { throw new Error('no snapshot writes expected'); }, getSnapshot: async () => null,
      lifecycle: { finalizedCleanupEnabled: true as const, operationLease: async () => () => {},
        snapshotExists: async () => true, markPublished },
    } } : {}),
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
  const unbound = options.unbound === true;
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
  // Seed the local owner's controls separately, as real publication does.
  await replaceLocallyTrustedKnowledgeAssetControlEnvelope(internal.store, ual,
    { assertionVersion: '1', merkleRoot: root },
    { accessPolicy: options.localAccessPolicy ?? 'public', publisherPeerId: 'publisher-peer', allowedPeers: [] });
  await internal.store.insert([...data, ...meta.filter(q => q.predicate !== 'http://www.w3.org/ns/prov#wasAttributedTo')
    .map(q => q.predicate === 'http://dkg.io/ontology/accessPolicy'
      ? { ...q, object: JSON.stringify(options.localAccessPolicy ?? 'public') } : q)]);
  expect(internal.store).not.toHaveProperty('mutationOwner');
  expect(await readHeldGraphScopedAssets(internal.store, { contextGraphId: CG, descriptors: createGraphScopedDurableManifestPlan(meta, CG)!.descriptors })).toEqual(new Set([ual]));
  const swmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, createGraphKnowledgeAssetScope(ual, '1'), 'reports');
  const retireTwin = internal.retireFinalizedSwmTwinCandidate.bind(internal);
  const retire = vi.spyOn(internal, 'retireFinalizedSwmTwinCandidate');
  const seedSwmTwin = async (version: '1' | '2') => {
    const ns = 'http://dkg.io/ontology/';
    const swmMeta = `did:dkg:context-graph:${CG}/reports/_shared_memory_meta`;
    const head = `${ual}#dkg-swm-head`, operation = `urn:dkg:share:${CG}:held-twin`;
    const integer = (value: string | number) => `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
    const row = (subject: string, predicate: string, object: string): Quad => ({ subject, predicate: ns + predicate, object, graph: swmMeta });
    await internal.store.insert([
      ...data.map(quad => ({ ...quad, graph: swmGraph, ...(version === '2' ? { object: '"newer"' } : {}) })),
      row(head, 'contentScopeVersion', integer(GRAPH_KA_CONTENT_SCOPE_VERSION)), row(head, 'kaUal', ual),
      row(head, 'assertionVersion', integer(version)), row(head, 'assertionGraph', swmGraph),
      row(head, 'shareOperationId', '"held-twin"'),
      { subject: operation, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: ns + 'WorkspaceOperation', graph: swmMeta },
      row(operation, 'shareOperationId', '"held-twin"'), row(operation, 'kaUal', ual),
      row(operation, 'assertionVersion', integer(version)),
      row(operation, 'publicQuadsDigest', `"${workspacePublicQuadsDigest(data)}"`),
      row(operation, 'publicQuadsCount', integer(1)), row(operation, 'privateTripleCount', integer(0)),
    ]);
  };
  const entered = deferred(), release = deferred();
  let phase: 'chain' | 'worker' | 'reconcile' | undefined;
  let fetchData = false;
  vi.spyOn(chain, 'getLatestMerkleRoot').mockImplementation(async () => {
    if (phase === 'chain') { entered.resolve(); await release.promise; }
    return root;
  });
  retire.mockImplementation(async (...args: unknown[]) => {
    if (phase === 'reconcile') { entered.resolve(); await release.promise; }
    return retireTwin(...args);
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
    const quads = call.phase === 'meta' ? meta : fetchData && call.phase === 'data' ? data : [];
    return { quads, bytesReceived: quads.length * 100, resumedFromOffset: 0, nextOffset: quads.length,
      checkpointKey: getSyncCheckpointKey(PEER, CG, false, call.phase), completed: true, timedOut: false };
  });
  expect(await internal.canUseLegacyDurableSyncForContextGraphV1(CG)).toBe(true);
  const run = () => agent.syncDurableRecoveryContextGraph(CG, {
    candidatePeerIds: [PEER], restrictToCandidatePeerIds: true, candidatesAreSyncCapable: true,
  });
  return { agent, internal, chain, markPublished, savedBindings, persist, subscription, ual, graph, data, meta, root, swmGraph, retire,
    seedSwmTwin, entered, release, run, dataRequests: () => dataRequests,
    pause: (at: 'chain' | 'worker' | 'reconcile') => { phase = at; }, fetchMissingData: () => { fetchData = true; } };
}

/** Seed a previously authenticated replica through the normal publication path. */
export async function storeConfirmedPrefix(store: TripleStore, contextGraphId: string, data: Quad[], meta: Quad[]): Promise<void> {
  const asset = partitionVerifiedGraphScopedAssets(contextGraphId, data, meta, [data[0]!.graph]).assets[0]!;
  const metadataQuads = overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1(asset.metadataQuads,
    { ual: asset.ual, metaGraph: asset.metaGraph, subGraphName: asset.subGraphName, receivedAt: new Date(0) },
    { status: 'confirmed', materializedVersion: { blockNumber: 1, txIndex: 0 }, confirmation: { kind: 'finalized-materialization' } });
  expect(await materializeVerifiedGraphScopedAsset({ store, asset: { ...asset, metadataQuads } })).toBe('applied');
}

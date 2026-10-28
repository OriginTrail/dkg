import { afterEach, expect, it, vi } from 'vitest';
import { createOperationContext, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { createGraphScopedDurableManifestPlan, graphScopedDurableManifestPrefixAtOffset } from '../src/sync/durable-integrity.js';
import { getSyncCheckpointKey } from '../src/sync/checkpoint/state.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { stubLifecycleFetch } from './_helpers/sync-fetch-coalescing.js';
import { CG, PEER, createHeldProductionHarness, stopHeldProductionAgents, storeConfirmedPrefix } from './_helpers/durable-held-production.js';

afterEach(async () => { await stopHeldProductionAgents(); vi.restoreAllMocks(); });

it('keeps a proven VM prefix while materializing a suffix and retiring its SWM twin', async () => {
  const h = await createHeldProductionHarness({ finalizedCleanup: true });
  await h.internal.store.delete(h.data); // The suffix is missing locally, but still has a matching SWM twin.
  await h.seedSwmTwin('1');
  const ual = h.ual.replace(/\/7$/, '/1');
  const graph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, '1'), 'reports');
  const data = h.data.map(q => ({ ...q, graph, subject: 'urn:prefix:stored' }));
  const meta = generateGraphKnowledgeAssetMetadata({ ual, contextGraphId: CG,
    merkleRoot: computeFlatKCRootV10(data, []), publisherPeerId: 'publisher-peer', accessPolicy: 'public',
    timestamp: new Date(0), assertionVersion: '1', publicTripleCount: data.length, privateTripleCount: 0,
    assertionGraph: graph, subGraphName: 'reports',
  }, { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
    batchId: 0n, materializedVersion: { blockNumber: 1, txIndex: 0 },
  } } });
  await storeConfirmedPrefix(h.internal.store, CG, data, meta);
  const generation = [...meta, ...h.meta];
  const manifest = createGraphScopedDurableManifestPlan(generation, CG)!;
  expect(manifest.descriptors[0]!.ual).toBe(ual);
  const key = getSyncCheckpointKey(PEER, CG, false, 'data');
  h.internal.syncCheckpoints.setManifestBoundOffset(key, data.length, manifest.manifestDigest, Date.now(),
    graphScopedDurableManifestPrefixAtOffset(manifest, data.length)!.prefixDigest);
  stubLifecycleFetch(h.agent, async call => ({
    quads: call.phase === 'meta' ? generation : h.data,
    manifestDigest: call.phase === 'data' ? manifest.manifestDigest : undefined,
    bytesReceived: 1000, resumedFromOffset: call.phase === 'data' ? data.length : 0,
    nextOffset: call.phase === 'data' ? data.length + h.data.length : generation.length,
    checkpointKey: getSyncCheckpointKey(PEER, CG, false, call.phase), completed: true, timedOut: false,
  }));
  const { result } = await LifecycleSyncMethods.prototype.runLegacyDurableSyncDetailed.call(
    h.agent, createOperationContext('sync'), PEER, [CG],
  );
  expect(result.complete).toBe(true);
  expect(result.failedPhases).toBe(0);
  expect(h.retire).toHaveBeenCalledOnce();
  expect(h.markPublished).toHaveBeenCalled();
  expect(await h.internal.store.countQuads(h.swmGraph)).toBe(0);
  expect(await h.internal.store.countQuads(graph)).toBe(data.length);
  expect(await h.internal.store.countQuads(h.graph)).toBe(h.data.length);
  expect(h.internal.syncCheckpoints.get(key)?.terminal).toBe(true);
}, 15_000);

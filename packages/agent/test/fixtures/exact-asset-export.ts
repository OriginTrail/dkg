import { vi } from 'vitest';
import { MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { BlazegraphStore, type Quad, type QueryOptions } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { createSyncResponderSnapshotBudget } from '../../src/sync/responder/snapshot-budget.js';
import { createBoundedExactAssetExportCache } from '../../src/sync/responder/exact-asset-export-cache.js';

export function exactAssetExportFixture(rows = 10_000, literal = 'bounded-value', contextGraphId = 'bounded-export-public') {
  const assetUal = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/1';
  const graph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(assetUal, 1));
  const payload: Quad[] = Array.from({ length: rows }, (_, index) => ({
    graph, subject: `urn:asset:${index.toString().padStart(5, '0')}`,
    predicate: 'urn:predicate', object: JSON.stringify(`${literal}:${index}`),
  }));
  const meta = generateGraphKnowledgeAssetMetadata({
    ual: assetUal, contextGraphId, assertionGraph: graph, assertionVersion: '1',
    merkleRoot: computeFlatKCRootV10(payload, []), publisherPeerId: 'publisher',
    accessPolicy: 'public', timestamp: new Date(0), publicTripleCount: rows, privateTripleCount: 0,
  }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: {
    txHash: `0x${'11'.repeat(32)}`, batchId: 1n, blockNumber: 1, blockTimestamp: 0,
    publisherAddress: '0x00000000000000000000000000000000000000ab', chainId: '31337',
  } } });
  const store = new BlazegraphStore('http://127.0.0.1:1/unused');
  const reads: Array<{ query: string; options?: QueryOptions }> = [];
  const query = vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    reads.push({ query: sparql, options });
    return options?.source === 'sync.responder.exactAssetExport.metadata'
      ? { type: 'bindings', bindings: meta.map((quad) => ({ predicate: quad.predicate, object: quad.object })) }
      : { type: 'bindings', bindings: payload.map((quad) => ({ s: quad.subject, p: quad.predicate, o: quad.object })) };
  });
  const budget = createSyncResponderSnapshotBudget({
    maxRows: 100_000, maxBytesEstimate: 384 * 1024 * 1024,
    maxSnapshotRows: 100_000, maxSnapshotBytesEstimate: 128 * 1024 * 1024,
  });
  return { contextGraphId, assetUal, graph, expectedRows: rows, payload, meta, store, query, reads, budget,
    cache: createBoundedExactAssetExportCache({ store, budget }) };
}

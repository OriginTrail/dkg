import { describe, expect, it } from 'vitest';
import { knowledgeAssetLayerGraphUri, MemoryLayer, createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import { bulkChunkHash, type BulkGraphRequest } from '../src/sync/bulk-graph-contract.js';
import { fixture, cg } from './helpers/bulk-graph-fixture.js';

const orders: (keyof BulkGraphRequest)[][] = [
  ['contextGraphId', 'version', 'snapshotDigest', 'assetUals'],
  ['assetUals', 'snapshotDigest', 'contextGraphId', 'version'],
];
const reorder = (request: BulkGraphRequest, order: (keyof BulkGraphRequest)[]): BulkGraphRequest =>
  Object.fromEntries(order.map(key => [key, request[key]])) as unknown as BulkGraphRequest;

it('canonicalizes request fields while retaining asset selection order in the directory hash', () => {
  const request: BulkGraphRequest = {
    version: 1, contextGraphId: cg, snapshotDigest: 'a'.repeat(64),
    assetUals: [1, 2].map(id => `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${id}`),
  };
  const digest = bulkChunkHash(request).digest('hex');
  for (const order of orders) expect(bulkChunkHash(reorder(request, order)).digest('hex')).toBe(digest);
  expect(bulkChunkHash({ ...request, assetUals: [...request.assetUals].reverse() }).digest('hex')).not.toBe(digest);
});

describe('reordered requests through the real bulk responder and verified receiver', () => {
  for (const order of orders) {
    it(`completes when ${order[0]} is serialized first`, async () => {
      const f = await fixture(2);
      const outbound = reorder(f.request, order);
      expect(Object.keys(outbound)).toEqual(order);
      const result = await f.run(outbound);
      expect(result.committedAssetUals).toEqual(f.uals);
      expect(result.metrics.receivedAssets).toBe(2);
      expect(result.metrics.verifiedAssets).toBe(2);
      expect(result.metrics.committedAssets).toBe(2);
      for (const ual of f.uals) expect(await f.target.countQuads(
        knowledgeAssetLayerGraphUri(cg, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, 1)),
      )).toBeGreaterThan(0);
    }, 30_000);
  }
});

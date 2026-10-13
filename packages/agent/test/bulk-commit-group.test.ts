import { describe, expect, it, vi } from 'vitest';
import { createOperationContext, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { quadsToNQuads } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';
import { createAssetPayloadVerifier } from '../src/sync/requester/asset-payload-verifier.js';
import { BulkCommitGroup } from '../src/sync/requester/bulk-commit-group.js';
import { encodeNegotiatedExactSyncResponse } from '../src/sync/wire-compression.js';
import { estimateQuadHeapBytes } from '../src/sync/memory-telemetry.js';

// Isolate the independent heap fence. In the production profile the 8 MiB
// expanded target flushes these assets earlier; that path has receiver tests.
vi.mock('../src/sync/bulk-graph-contract.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/sync/bulk-graph-contract.js')>(),
  BULK_GROUP_EXPANDED_BYTES: 100 * 1024 * 1024,
}));

describe('bulk group independent parsed heap fence', () => {
  it('splits real verified assets before 64 MiB or eight members', async () => {
    const worker = new SyncVerifyWorker(), assets = [], stages = [];
    const cg = 'heap-fixture', address = '0x0000000000000000000000000000000000000001';
    const uals = [1, 2, 3].map(id => `did:dkg:base:84532/${address}/${id}`);
    const verify = createAssetPayloadVerifier({ contextGraphId: cg, assetUals: uals,
      ctx: createOperationContext('sync'), parseAndFilter: worker.parseAndFilter.bind(worker),
      processDurableBatchInWorker: (data, meta, _ctx, accept, mode) => worker.processDurableBatch(data, meta, accept, mode),
    });
    try {
      for (const [index, ual] of uals.entries()) {
        const graph = knowledgeAssetLayerGraphUri(cg, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, 1));
        const data = Array.from({ length: 90_000 }, (_, n) => ({ graph, subject: `urn:s:${n}`, predicate: 'urn:p', object: '"x"' }));
        const root = computeFlatKCRootV10(data, []);
        const meta = generateGraphKnowledgeAssetMetadata({ contextGraphId: cg, ual, assertionGraph: graph,
          assertionVersion: 1, publicTripleCount: data.length, privateTripleCount: 0, merkleRoot: root,
          authorAddress: address, publisherPeerId: 'fixture', accessPolicy: 'public', allowedPeers: [], timestamp: new Date(),
        }, { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
          batchId: BigInt(index + 1), materializedVersion: { blockNumber: 1, txIndex: 0 },
        } } });
        const plain = Buffer.from(quadsToNQuads(data)), metadata = Buffer.from(quadsToNQuads(meta));
        const body = await encodeNegotiatedExactSyncResponse(plain, { request: {
          responseEncoding: 'gzip-nquads-v1', assetUals: [ual], phase: 'data',
        } });
        assets.push(await verify({ assetIndex: index, assetUal: ual, metadataBytes: metadata,
          dataBytes: plain }));
        stages.push({ index, path: 'fixture-consumed', chunks: Math.ceil(body.length / 65536), header: {
          encodedBytes: body.length, plainBytes: plain.length, offset: 0, digest: '0'.repeat(64), metadata: metadata.toString('base64'),
        } });
      }
      const heaps = assets.map(a => [...a.dataQuads, ...a.metadataQuads].reduce((n, q) => n + estimateQuadHeapBytes(q), 0));
      expect(heaps.every(n => n < 32 * 1024 * 1024)).toBe(true);
      expect(heaps.reduce((a, b) => a + b, 0)).toBeGreaterThan(64 * 1024 * 1024);
      const groups: number[] = [];
      const group = new BulkCommitGroup(async members => {
        groups.push(members.length);
        const heap = members.reduce((n, m) => n + heaps[uals.indexOf(m.asset.ual)]!, 0);
        expect(heap).toBeLessThanOrEqual(64 * 1024 * 1024);
      });
      for (const [index, asset] of assets.entries()) await group.append(asset, stages[index]!);
      await group.flush();
      expect(groups).toEqual([2, 1]);
    } finally { await worker.close(); }
  }, 60_000);
});

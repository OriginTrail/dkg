import { describe, expect, it, vi } from 'vitest';
import { MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { createGraphMembershipSnapshot } from '../src/sync/graph-membership-snapshot.js';
import { readExactDataSessionPage } from '../src/sync/responder/exact-data-session.js';
import {
  createResponderPageOnlyExactDataSessionMemo as createResponderPageOnlyExactGraphPlanMemo,
  createResponderSyncRowListMemo,
  readDurableDataPage,
} from '../src/sync/responder/graph-plan.js';
import type { ExactAssetExportCache, ExactAssetExportLease } from '../src/sync/responder/exact-asset-export-cache.js';
import { createSyncResponderSnapshotBudget } from '../src/sync/responder/snapshot-budget.js';

async function fixture() {
  const contextGraphId = 'exact-session-owner';
  const assetUal = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/1';
  const graph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(assetUal, 1));
  const payload: Quad[] = Array.from({ length: 4 }, (_, index) => ({ graph,
    subject: `urn:owner:${index}`, predicate: 'urn:value', object: `"${index}"` }));
  const metadata = generateGraphKnowledgeAssetMetadata({
    ual: assetUal, contextGraphId, assertionGraph: graph, assertionVersion: '1',
    merkleRoot: computeFlatKCRootV10(payload, []), publisherPeerId: 'publisher',
    accessPolicy: 'public', timestamp: new Date(0), publicTripleCount: payload.length, privateTripleCount: 0,
  }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: {
    txHash: `0x${'11'.repeat(32)}`, batchId: 1n, blockNumber: 1, blockTimestamp: 0,
    publisherAddress: '0x00000000000000000000000000000000000000ab', chainId: '31337',
  } } });
  const store = new OxigraphStore();
  await store.insert([...metadata, ...payload]);
  const query = vi.spyOn(store, 'query');
  const budget = createSyncResponderSnapshotBudget({ maxRows: 10_000, maxBytesEstimate: 8 * 1024 * 1024,
    maxSnapshotRows: 1, maxSnapshotBytesEstimate: 4 * 1024 * 1024 });
  const params = { store, contextGraphId, assetUals: [assetUal], sinceBatchId: null,
    graphMembership: createGraphMembershipSnapshot([]), exactGraphReadMode: 'page-only' as const,
    exactGraphPlanMemo: createResponderPageOnlyExactGraphPlanMemo(60_000, 8, budget),
    exactGraphPlanCacheKey: 'owner-session', offset: 0, limit: 2 };
  return { store, graph, payload, params, query, budget, async changeMetadata() {
    await store.insert([{ graph: `did:dkg:context-graph:${contextGraphId}/_meta`, subject: assetUal,
      predicate: 'urn:changed-metadata', object: '"changed"' }]);
  }, async close() { query.mockRestore(); await store.close(); } };
}

describe('exact DATA session owner boundaries', () => {
  it('releases an unadopted response lease when the source changes during its read', async () => {
    const f = await fixture();
    try {
      const release = vi.fn();
      const lease: ExactAssetExportLease = { identity: 'validated-identity', release,
        rows: f.payload.map(q => ({ s: q.subject, p: q.predicate, o: q.object, g: q.graph })),
        assertCurrent: vi.fn(async () => {}) };
      const acquire = vi.fn(async () => { await f.changeMetadata(); return lease; });
      const params = { ...f.params, maxPageBytes: 4096, exactAssetExportCache: { acquire } as unknown as ExactAssetExportCache };
      await expect(readExactDataSessionPage(params)).rejects.toThrow(/store revision changed/);
      expect(release).toHaveBeenCalledOnce();
      await expect(readExactDataSessionPage({ ...params, offset: 2 })).rejects.toThrow(/store revision changed/);
      expect(acquire).toHaveBeenCalledOnce();
      expect(f.query.mock.calls.some(([, options]) => options?.source === 'sync.responder.readExactGraphRowsPage')).toBe(false);
    } finally { await f.close(); }
  });

  it('keeps one retained manifest and bounded cursor reader after intrinsic snapshot fallback', async () => {
    const f = await fixture();
    try {
      const params = { ...f.params, rowListMemo: createResponderSyncRowListMemo(60_000, 8, { phase: 'durable_data', budget: f.budget }),
        refreshRowList: true };
      const first = await readDurableDataPage(params);
      const last = await readDurableDataPage({ ...params, offset: 2, refreshRowList: false });
      expect([...first, ...last].map(row => row.s)).toEqual(f.payload.map(row => row.subject));
      expect(await readDurableDataPage({ ...params, offset: 4, refreshRowList: false })).toEqual([]);
      expect(f.query.mock.calls.filter(([, options]) => options?.source === 'sync.responder.readGraphScopedVmManifest')).toHaveLength(1);
      expect(f.query.mock.calls.some(([sparql, options]) => options?.source === 'sync.responder.readExactGraphRowsPage'
        && sparql.includes('FILTER'))).toBe(true);
      const retained = await params.exactGraphPlanMemo.get('owner-session', async () => { throw new Error('must retain session'); }, { requireExisting: true });
      expect(retained!.graphPlan.cursors.size).toBeLessThanOrEqual(512);
      await f.changeMetadata();
      await expect(readDurableDataPage({ ...params, offset: 2, refreshRowList: false })).rejects.toThrow(/store revision changed/);
    } finally { await f.close(); }
  });
});

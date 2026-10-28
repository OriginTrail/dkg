import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { SparqlHttpStore, type Quad } from '@origintrail-official/dkg-storage';
import { startOxigraphSparqlEndpoint } from '../../storage/test/helpers/oxigraph-sparql-endpoint.js';
import { createBoundedExactAssetExportCache } from '../src/sync/responder/exact-asset-export-cache.js';
import { createSyncResponderSnapshotBudget } from '../src/sync/responder/snapshot-budget.js';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import { serializeResponderRows } from '../src/sync/responder/graph-plan.js';
import { EXACT_SYNC_GZIP_ENCODING, decodeNegotiatedExactSyncResponse } from '../src/sync/wire-compression.js';
import { SYNC_BYTE_BUDGET_PAGE_MODE } from '../src/dkg-agent-constants.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';

function asset(contextGraphId: string, index: number, count = 600) {
  const ual = `did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/${index}`;
  const graph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, 1));
  const payload: Quad[] = Array.from({ length: count }, (_, row) => ({ graph,
    subject: `urn:recovered:${index}:${String(row).padStart(5, '0')}`, predicate: 'urn:value', object: `"${row}"` }));
  const meta = generateGraphKnowledgeAssetMetadata({
    ual, contextGraphId, assertionGraph: graph, assertionVersion: '1', merkleRoot: computeFlatKCRootV10(payload, []),
    publisherPeerId: 'publisher', accessPolicy: 'public', timestamp: new Date(0), publicTripleCount: count, privateTripleCount: 0,
  }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: {
    txHash: `0x${'11'.repeat(32)}`, batchId: BigInt(index), blockNumber: 1, blockTimestamp: 0,
    publisherAddress: '0x00000000000000000000000000000000000000ab', chainId: '31337',
  } } });
  return { contextGraphId, ual, graph, payload, meta };
}

function text(quads: readonly Quad[]) {
  return serializeResponderRows(quads.map(q => ({ s: q.subject, p: q.predicate, o: q.object, g: q.graph })));
}

/** Real HTTP mutation/decoding lifecycle; only the test endpoint owns delayed completion. */
async function fixture() {
  const endpoint = await startOxigraphSparqlEndpoint();
  let failUpdate = true;
  const pending: string[] = [];
  const updates = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (failUpdate) { pending.push(body); res.writeHead(500); res.end('transient endpoint failure'); }
      else { endpoint.store.update(body); res.writeHead(204); res.end(); }
    });
  });
  await new Promise<void>(resolve => updates.listen(0, '127.0.0.1', resolve));
  const address = updates.address();
  if (!address || typeof address === 'string') throw new Error('Test endpoint not listening');
  const store = new SparqlHttpStore({ queryEndpoint: endpoint.queryEndpoint,
    updateEndpoint: `http://127.0.0.1:${address.port}/update` });
  const query = vi.spyOn(store, 'query');
  let handler!: (data: Uint8Array, peer: string) => Promise<Uint8Array>;
  registerSyncHandler({ register: (_protocol, callback) => { handler = callback; },
    protocolSync: '/test/indeterminate-exact', syncDeniedResponse: 'denied', syncPageSize: 500,
    sharedMemoryTtlMs: 0, store, peerId: 'source', parseSyncRequest: bytes => JSON.parse(new TextDecoder().decode(bytes)),
    authorizeSyncRequest: async () => true, logWarn: () => {}, logDebug: () => {} });
  return { endpoint, store, query,
    seed: (a: ReturnType<typeof asset>) => endpoint.store.load(text([...a.meta, ...a.payload]), { format: 'application/n-quads' }),
    async fail(update = 'INSERT DATA { GRAPH <urn:unrelated> { <urn:a> <urn:b> "late" } }') {
      await expect(store.update(update)).rejects.toThrow(/failed \(500\)/);
      expect(pending).toHaveLength(1);
      expect(store.getWriteRevision('')).toMatchObject({ stable: false });
    },
    finishLate() { endpoint.store.update(pending.shift()!); },
    allowWrites() { failUpdate = false; },
    async page(a: ReturnType<typeof asset>, token: string, offset = 0, gzip = true) {
      const request: SyncRequestEnvelope = { contextGraphId: a.contextGraphId, includeSharedMemory: false, phase: 'data',
        assetUals: [a.ual], syncSessionId: token, offset, limit: 500, pageRowsHint: 512,
        pageMode: SYNC_BYTE_BUDGET_PAGE_MODE, ...(gzip ? { responseEncoding: EXACT_SYNC_GZIP_ENCODING } : {}) };
      const bytes = await handler(new TextEncoder().encode(JSON.stringify(request)), 'requester');
      return new TextDecoder().decode((await decodeNegotiatedExactSyncResponse(bytes, { allowCompression: gzip })).bytes);
    },
    payloadReads: () => query.mock.calls.filter(([, options]) => options?.source === 'sync.responder.exactAssetExport.payload').length,
    async close() { await store.close(); await new Promise<void>(resolve => updates.close(() => resolve())); await endpoint.close(); },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('exact export recovery after an indeterminate unscoped HTTP update', () => {
  it('invalidates a retained stable plan and serves an unrelated healthy asset with fresh verified exports without restart', async () => {
    const f = await fixture();
    try {
      const old = asset('before-unscoped-failure', 1), healthy = asset('unrelated-healthy', 2);
      f.seed(old); f.seed(healthy);
      expect((await f.page(old, 'before')).split('\n')).toHaveLength(512);
      await f.fail();
      await expect(f.page(old, 'before', 512)).rejects.toThrow(/store revision changed/);
      const first = await f.page(healthy, 'after');
      const last = await f.page(healthy, 'after', 512);
      expect(`${first}\n${last}`).toBe(text(healthy.payload));
      expect(await f.page(healthy, 'after', 600)).toBe('');
      expect(f.payloadReads()).toBe(4); // old page plus one complete export per recovered page, including EOF
      f.allowWrites();
      await f.store.insert([{ graph: 'urn:another', subject: 'urn:s', predicate: 'urn:p', object: '"ok"' }]);
      expect(f.store.getWriteRevision(healthy.graph).stable).toBe(false);
      await expect(f.page(healthy, 'plain-after', 0, false)).rejects.toThrow(/unstable/);
    } finally { await f.close(); }
  });

  it('recomputes row and encoded exports instead of reusing pre-failure or unstable caches', async () => {
    const f = await fixture();
    try {
      const a = asset('uncached-recovery', 3, 10); f.seed(a);
      const budget = createSyncResponderSnapshotBudget({ maxRows: 100_000, maxBytesEstimate: 384 * 1024 * 1024,
        maxSnapshotRows: 100_000, maxSnapshotBytesEstimate: 128 * 1024 * 1024 });
      const cache = createBoundedExactAssetExportCache({ store: f.store, budget });
      const request = { contextGraphId: a.contextGraphId, assetUal: a.ual, graph: a.graph, expectedRows: a.payload.length };
      const warm = await cache.acquireEncoded(request); await warm!.assertCurrent(); warm!.release();
      const hit = await cache.acquireEncoded(request); expect(hit!.wholePayloadExports).toBe(0);
      await f.fail();
      await expect(hit!.assertCurrent()).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
      hit!.release();
      for (let i = 0; i < 2; i += 1) {
        const encoded = await cache.acquireEncoded(request); expect(encoded!.wholePayloadExports).toBe(1);
        await encoded!.assertCurrent(); encoded!.release();
      }
      expect(cache.stats()).toMatchObject({ exports: 3, cacheHits: 0, encodedCacheHits: 1, encodedCacheEntries: 1 });
      // Pre-failure entries keep their ordinary TTL; no unstable entry is added.
      expect(budget.stats().snapshots).toBe(2);
    } finally { await f.close(); }
  });

  it('refuses same-count wrong-root DATA after late remote completion even when local revisions and metadata are unchanged', async () => {
    const f = await fixture();
    try {
      const changed = asset('late-data-change', 4), healthy = asset('late-unrelated', 5); f.seed(changed); f.seed(healthy);
      const row = changed.payload[550]!;
      await f.fail(`DELETE DATA { GRAPH <${changed.graph}> { <${row.subject}> <${row.predicate}> ${row.object} } };\nINSERT DATA { GRAPH <${changed.graph}> { <${row.subject}> <${row.predicate}> "wrong-root" } }`);
      expect((await f.page(changed, 'recover')).split('\n')).toHaveLength(512);
      const revision = f.store.getWriteRevision(changed.graph);
      f.finishLate();
      expect(f.store.getWriteRevision(changed.graph)).toEqual(revision);
      expect(await f.store.countQuads(changed.graph)).toBe(600);
      await expect(f.page(changed, 'recover', 512)).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_INVALID' });
      await expect(f.page(changed, 'fresh-after-late')).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_INVALID' });
      const first = await f.page(healthy, 'unrelated');
      const last = await f.page(healthy, 'unrelated', 512);
      expect(`${first}\n${last}`).toBe(text(healthy.payload));
    } finally { await f.close(); }
  });

  it.each(['underflow', 'surplus'] as const)('refuses %s payload counts during uncached recovery', async countChange => {
    const f = await fixture();
    try {
      const a = asset(`recovery-count-${countChange}`, 6, 10); f.seed(a); await f.fail();
      if (countChange === 'underflow') {
        const row = a.payload[0]!;
        f.endpoint.store.update(`DELETE DATA { GRAPH <${a.graph}> { <${row.subject}> <${row.predicate}> ${row.object} } }`);
      } else f.endpoint.store.update(`INSERT DATA { GRAPH <${a.graph}> { <urn:extra> <urn:value> "surplus" } }`);
      await expect(f.page(a, 'bad-count')).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_INVALID' });
    } finally { await f.close(); }
  });

  it('rejects a recovered plan after a further local write even when the verified body is unchanged', async () => {
    const f = await fixture();
    try {
      const a = asset('recovery-local-source-fence', 8); f.seed(a); await f.fail();
      expect((await f.page(a, 'recovered')).split('\n')).toHaveLength(512);
      const reads = f.payloadReads(), revision = f.store.getWriteRevision(a.graph);
      f.allowWrites();
      await f.store.insert([a.payload[0]!]); // idempotent DATA; the actual local source lifecycle still advances
      expect(f.store.getWriteRevision(a.graph).generation).toBeGreaterThan(revision.generation);
      expect(f.store.getWriteRevision(a.graph).stable).toBe(false);
      await expect(f.page(a, 'recovered', 512)).rejects.toThrow(/store revision changed/);
      expect(f.payloadReads()).toBe(reads);
      expect((await f.page(a, 'fresh-after-write')).split('\n')).toHaveLength(512);
    } finally { await f.close(); }
  });

  it.each(['non-canonical', 'over-profile'] as const)('refuses %s metadata counts without ordinary store fallback', async countProfile => {
    const f = await fixture();
    try {
      const a = asset(`recovery-profile-${countProfile}`, 9, 10); f.seed(a); await f.fail();
      const value = countProfile === 'non-canonical' ? '10.0' : '16385';
      f.endpoint.store.update(`DELETE WHERE { GRAPH <${a.meta[0]!.graph}> { <${a.ual}> <http://dkg.io/ontology/publicTripleCount> ?o } };\nINSERT DATA { GRAPH <${a.meta[0]!.graph}> { <${a.ual}> <http://dkg.io/ontology/publicTripleCount> "${value}" } }`);
      if (countProfile === 'non-canonical') await expect(f.page(a, 'invalid-count')).rejects.toThrow(/invalid publicTripleCount/);
      else await expect(f.page(a, 'over-profile')).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_UNAVAILABLE' });
      expect(f.payloadReads()).toBe(0);
      expect(f.query.mock.calls.some(([, options]) => options?.source === 'sync.responder.readExactGraphRowsPage')).toBe(false);
    } finally { await f.close(); }
  });

  it('refuses changed retained metadata and a capability refusal instead of switching to store paging', async () => {
    const f = await fixture();
    try {
      const a = asset('recovery-metadata-change', 7); f.seed(a); await f.fail();
      expect((await f.page(a, 'retained')).split('\n')).toHaveLength(512);
      const metaGraph = a.meta[0]!.graph;
      f.endpoint.store.update(`DELETE WHERE { GRAPH <${metaGraph}> { <${a.ual}> <http://dkg.io/ontology/accessPolicy> ?o } };\nINSERT DATA { GRAPH <${metaGraph}> { <${a.ual}> <http://dkg.io/ontology/accessPolicy> "private" } }`);
      await expect(f.page(a, 'retained', 512)).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
      await expect(f.page(a, 'fresh-private')).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_UNAVAILABLE' });
      expect(f.query.mock.calls.some(([, options]) => options?.source === 'sync.responder.readExactGraphRowsPage')).toBe(false);
    } finally { await f.close(); }
  });
});

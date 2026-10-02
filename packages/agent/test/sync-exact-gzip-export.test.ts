import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { BlazegraphStore, OxigraphStore, type Quad, type QueryOptions } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { SYNC_BYTE_BUDGET_PAGE_MODE, SYNC_PAGE_SIZE } from '../src/dkg-agent-constants.js';
import { buildSyncRequestEnvelope, type SyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { fetchSyncPages } from '../src/sync/requester/page-fetch.js';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';
import { decodeNegotiatedExactSyncResponse, EXACT_SYNC_GZIP_ENCODING, isExactSyncGzipFrame } from '../src/sync/wire-compression.js';

function cell(value: string): Record<string, string> {
  if (!value.startsWith('"')) return { type: 'uri', value };
  const parsed = /^("(?:[^"\\]|\\.)*")(?:(?:\^\^<([^>]+)>)|@([\w-]+))?$/.exec(value);
  if (!parsed) throw new Error('Invalid test literal');
  return { type: 'literal', value: JSON.parse(parsed[1]!),
    ...(parsed[2] ? { datatype: parsed[2] } : {}), ...(parsed[3] ? { 'xml:lang': parsed[3] } : {}) };
}

/** Genuine bounded HTTP decoding and SPARQL results; authorization remains an explicit test port. */
async function fixture(rowCount = 10_000) {
  const contextGraphId = 'gzip-export-public';
  const assetUal = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/9';
  const graph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(assetUal, 1));
  const data: Quad[] = Array.from({ length: rowCount }, (_, index) => ({
    graph, subject: `urn:export:subject:${index.toString().padStart(5, '0')}`, predicate: 'urn:export:value',
    object: JSON.stringify(`${'public repeated corpus value '.repeat(7)}${index}`),
  }));
  const meta = generateGraphKnowledgeAssetMetadata({
    ual: assetUal, contextGraphId, assertionGraph: graph, assertionVersion: '1',
    merkleRoot: computeFlatKCRootV10(data, []), publisherPeerId: 'publisher',
    accessPolicy: 'public', timestamp: new Date(0), publicTripleCount: data.length, privateTripleCount: 0,
  }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: {
    txHash: `0x${'11'.repeat(32)}`, batchId: 9n,
  } } });
  const backing = new OxigraphStore();
  await backing.insert([...data, ...meta]);
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const result = await backing.query(Buffer.concat(chunks).toString('utf8'));
      if (result.type !== 'bindings') throw new Error('Test server accepts SELECT only');
      res.setHeader('Content-Type', 'application/sparql-results+json');
      res.end(JSON.stringify({ head: { vars: Object.keys(result.bindings[0] ?? {}) }, results: {
        bindings: result.bindings.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)]))),
      } }));
    } catch { res.statusCode = 500; res.end('test-store-failure'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test HTTP address absent');
  const store = new BlazegraphStore(`http://127.0.0.1:${address.port}/sparql`);
  const physicalReads: Array<{ source?: string; query: string; options?: QueryOptions; elapsedMs: number }> = [];
  const query = store.query.bind(store);
  vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    const start = performance.now();
    const result = await query(sparql, options);
    physicalReads.push({ source: options?.source, query: sparql, options, elapsedMs: performance.now() - start });
    return result;
  });
  let handler!: (bytes: Uint8Array, peer: string, options?: { signal?: AbortSignal }) => Promise<Uint8Array>;
  const authorize = vi.fn(async (_request: SyncRequestEnvelope) => true);
  registerSyncHandler({
    register: (_protocol, callback) => { handler = callback; }, protocolSync: '/test/gzip-sync',
    syncDeniedResponse: 'denied', syncPageSize: SYNC_PAGE_SIZE, sharedMemoryTtlMs: 0,
    store, peerId: 'source', parseSyncRequest: (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
    authorizeSyncRequest: authorize, logWarn: () => {}, logDebug: () => {},
  });
  const base: SyncRequestEnvelope = {
    contextGraphId, includeSharedMemory: false, phase: 'data', offset: 0, limit: SYNC_PAGE_SIZE,
    pageMode: SYNC_BYTE_BUDGET_PAGE_MODE, pageRowsHint: 8192, assetUals: [assetUal],
    syncSessionId: 'gzip-export-session', responseEncoding: EXACT_SYNC_GZIP_ENCODING,
    requesterSignatureR: 'signed-cold-request', requesterSignatureVS: 'signed-cold-request',
  };
  const invoke = (request: SyncRequestEnvelope) => handler(new TextEncoder().encode(JSON.stringify(request)), 'requester');
  return { contextGraphId, assetUal, graph, data, meta, backing, physicalReads, authorize, base, invoke, handler,
    async close() { vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await backing.close(); } };
}

describe('native exact compressed export integration', () => {
  it('transfers a real 10K fixture through HTTP export, compressed page requester and production Merkle worker', async () => {
    const f = await fixture();
    const worker = new SyncVerifyWorker();
    const bodies: Uint8Array[] = [];
    const envelopes: SyncRequestEnvelope[] = [];
    try {
      const fetched = await fetchSyncPages({
        ctx: { operationId: 'gzip-fixture', operationName: 'sync' }, remotePeerId: 'source',
        contextGraphId: f.contextGraphId, graphUri: f.graph, includeSharedMemory: false, phase: 'data',
        deadline: Date.now() + 30_000, syncPageTimeoutMs: 10_000, syncRouterAttempts: 1, syncPageRetryAttempts: 1,
        syncPageSize: 8192, syncDeniedResponse: 'denied', protocolSync: '/test/gzip-sync', debugSyncProgress: false,
        checkpointStore: new MemorySyncCheckpointStore(), ephemeralRequesterState: true,
        assetUals: [f.assetUal], responseEncoding: EXACT_SYNC_GZIP_ENCODING,
        buildSyncRequest: async (cg, offset, limit, swm, peer, phase, snapshot, since, token, recovery, assets) => {
          const bytes = await buildSyncRequestEnvelope({ contextGraphId: cg, offset, limit, includeSharedMemory: swm,
            targetPeerId: peer, requesterPeerId: 'requester', phase, snapshotRef: snapshot, sinceBatchId: since,
            syncSessionId: token, recovery, assetUals: assets, needsAuth: true,
            computeSyncDigest: () => new Uint8Array(32), getIdentityId: async () => 1n,
            signMessage: async () => ({ r: new Uint8Array(32).fill(1), vs: new Uint8Array(32).fill(2) }) });
          envelopes.push(JSON.parse(new TextDecoder().decode(bytes)));
          return bytes;
        },
        send: async (_peer, _protocol, bytes) => { const body = await f.handler(bytes, 'requester'); bodies.push(body); return body; },
        parseAndFilter: worker.parseAndFilter.bind(worker), logWarn: () => {}, logInfo: () => {}, logDebug: () => {},
      });
      expect(fetched.quads).toHaveLength(10_000);
      expect(fetched.nextOffset).toBe(10_000);
      expect(bodies.filter((body) => body.byteLength > 0)).toHaveLength(2);
      expect(bodies.at(-1)?.byteLength).toBe(0);
      expect(bodies.filter((body) => body.byteLength > 0).every(isExactSyncGzipFrame)).toBe(true);
      expect(envelopes.every((value) => value.requesterSignatureR && value.responseEncoding === EXACT_SYNC_GZIP_ENCODING)).toBe(true);
      expect(f.authorize).toHaveBeenCalledTimes(bodies.length);
      expect(f.physicalReads.filter((read) => read.source === 'sync.responder.exactAssetExport.payload')).toHaveLength(3);
      expect(f.physicalReads.filter((read) => read.source === 'sync.responder.readExactGraphRowsPage')).toHaveLength(0);
      const metadata = await f.invoke({ ...f.base, phase: 'meta' });
      const decoded = await decodeNegotiatedExactSyncResponse(metadata, { allowCompression: true });
      const parsedMeta = await worker.parseAndFilter(new TextDecoder().decode(decoded.bytes), `did:dkg:context-graph:${f.contextGraphId}/_meta`, f.contextGraphId);
      const verified = await worker.verify(fetched.quads, parsedMeta.quads, false);
      expect(verified.rejected).toBe(0);
      expect(verified.data).toHaveLength(10_000);
      const corrupted = fetched.quads.map((quad, index) => index === 0 ? { ...quad, object: '"tampered"' } : quad);
      expect((await worker.verify(corrupted, parsedMeta.quads, false)).data).toHaveLength(0);
    } finally { await worker.close(); await f.close(); }
  });

  it('expires a retained second page after metadata mutation and retains authorization on that request', async () => {
    const f = await fixture();
    try {
      const first = await f.invoke(f.base);
      const decoded = await decodeNegotiatedExactSyncResponse(first, { allowCompression: true });
      expect(decoded.rows).toBe(8192);
      await f.backing.insert([{ graph: f.meta[0]!.graph, subject: f.assetUal,
        predicate: 'urn:metadata:mutation', object: '"new source generation"' }]);
      await expect(f.invoke({ ...f.base, offset: 8192 })).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED',
        message: expect.stringMatching(/sync session.*expired/i) });
      expect(f.authorize).toHaveBeenCalledTimes(2);
      expect(f.physicalReads.filter((read) => read.source === 'sync.responder.exactAssetExport.payload')).toHaveLength(1);
    } finally { await f.close(); }
  });

  it('keeps an unnegotiated plain request on the old 512-row and 64-row physical read path', async () => {
    const f = await fixture(700);
    try {
      const body = await f.invoke({ ...f.base, responseEncoding: undefined });
      expect(isExactSyncGzipFrame(body)).toBe(false);
      expect(new TextDecoder().decode(body).split('\n')).toHaveLength(512);
      expect(f.physicalReads.filter((read) => read.source === 'sync.responder.exactAssetExport.payload')).toHaveLength(0);
      const reads = f.physicalReads.filter((read) => read.source === 'sync.responder.readExactGraphRowsPage');
      expect(reads).toHaveLength(8);
      expect(reads.every((read) => Number(/LIMIT\s+(\d+)/i.exec(read.query)?.[1]) <= 64)).toBe(true);
      expect(f.authorize).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it('rejects a same-count body mutation before emitting a second compressed page', async () => {
    const f = await fixture();
    try {
      await f.invoke(f.base);
      await f.backing.delete([f.data[0]!]);
      await f.backing.insert([{ ...f.data[0]!, object: '"changed without updating the root"' }]);
      await expect(f.invoke({ ...f.base, offset: 8192 })).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_INVALID' });
      expect(f.authorize).toHaveBeenCalledTimes(2);
      expect(f.physicalReads.filter((read) => read.source === 'sync.responder.exactAssetExport.payload')).toHaveLength(2);
    } finally { await f.close(); }
  });

  it('reauthorizes every compressed continuation before any payload or metadata cache lookup', async () => {
    const f = await fixture();
    try {
      await f.invoke(f.base);
      const priorReads = f.physicalReads.length;
      f.authorize.mockResolvedValue(false);
      const denied = await f.invoke({ ...f.base, offset: 8192 });
      expect(new TextDecoder().decode(denied)).toBe('denied');
      expect(isExactSyncGzipFrame(denied)).toBe(false);
      expect(f.physicalReads).toHaveLength(priorReads);
      expect(f.authorize).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });
});

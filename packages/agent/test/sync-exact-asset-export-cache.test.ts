import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, compareCodePoint, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { BlazegraphStore, StoreResponseTooLargeError, type Quad, type QueryOptions } from '@origintrail-official/dkg-storage';
import { decodeSparqlJsonQueryResult } from '@origintrail-official/dkg-storage/dist/sparql-json-query-result.js';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata, readConfirmedGraphKnowledgeAssetMetadataEnvelope } from '@origintrail-official/dkg-publisher';
import { createSyncResponderSnapshotBudget, SyncRowSnapshotBudgetError } from '../src/sync/responder/snapshot-budget.js';
import { createBoundedExactAssetExportCache, EXACT_ASSET_EXPORT_MAX_ROWS, EXACT_ASSET_EXPORT_MAX_STORE_BYTES,
  EXACT_ASSET_ENCODED_CACHE_MAX_BYTES, type ExactAssetExportCache } from '../src/sync/responder/exact-asset-export-cache.js';
import * as wireCompression from '../src/sync/wire-compression.js';

function fixture(rows = 10_000, literal = 'bounded-value', contextGraphId = 'bounded-export-public') {
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
    txHash: `0x${'11'.repeat(32)}`, batchId: 1n,
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

afterEach(() => vi.restoreAllMocks());

function useLegacyMetadata(f: ReturnType<typeof fixture>) {
  // Only the canonical confirmed immutable envelope; no publisher policy hint.
  const predicates = new Set(['contentScopeVersion', 'assertionVersion', 'publicTripleCount',
    'privateTripleCount', 'batchId', 'merkleRoot', 'assertionGraph', 'kaUal', 'status']
    .map(name => `http://dkg.io/ontology/${name}`));
  f.meta.splice(0, f.meta.length, ...f.meta.filter(quad => predicates.has(quad.predicate)));
}

function anonymizedLegacyMetadata() {
  const source = readFileSync(new URL('./fixtures/legacy-public-metadata.fixture.json', import.meta.url), 'utf8');
  const captured = JSON.parse(source) as { contextGraphId: string; assetUal: string; bindings: unknown[] };
  // Use the same term validation/serialization as the production HTTP adapter.
  const result = decodeSparqlJsonQueryResult(JSON.stringify({
    head: { vars: ['predicate', 'object'] }, results: { bindings: captured.bindings },
  }));
  if (result.type !== 'bindings') throw new Error('Anonymized metadata SELECT absent');
  const identity = createHash('sha256').update(JSON.stringify(result.bindings
    .map(row => [row.predicate!, row.object!])
    .sort((a, b) => compareCodePoint(a[0]!, b[0]!) || compareCodePoint(a[1]!, b[1]!)))).digest('hex');
  const store = new BlazegraphStore('http://127.0.0.1:1/unused');
  const noCapturedData = Object.assign(new Error('Fixture contains anonymized metadata only'), { code: 'FIXTURE_NO_CAPTURED_DATA' });
  const query = vi.spyOn(store, 'query').mockImplementation(async (_sparql, options) => {
    // This fixture deliberately supplies no DATA, synthetic or captured.
    if (options?.source?.endsWith('.payload')) throw noCapturedData;
    return result;
  });
  const budget = createSyncResponderSnapshotBudget({ maxRows: 750_000,
    maxBytesEstimate: 384 * 1024 * 1024, maxSnapshotRows: 250_000,
    maxSnapshotBytesEstimate: 128 * 1024 * 1024 });
  const request = { contextGraphId: captured.contextGraphId, assetUal: captured.assetUal,
    graph: `did:dkg:context-graph:${captured.contextGraphId}/_verifiable_memory/0x1111111111111111111111111111111111111111/1`,
    expectedRows: 10_000, expectedIdentity: identity };
  return { source, result, identity, store, query, budget, request, noCapturedData,
    cache: createBoundedExactAssetExportCache({ store, budget }) };
}

describe('anonymized legacy public metadata without payload DATA', () => {
  it('validates the anonymized 14-row fixture with the production serializer and confirmed envelope parser', async () => {
    const f = anonymizedLegacyMetadata();
    expect(createHash('sha256').update(f.source).digest('hex')).toBe('9415223ca9fda9cd18a8d7583962f4c63f21a3fd618e15e83b1f040abe384dc0');
    expect(f.result.bindings).toHaveLength(14);
    expect(f.identity).toBe('532baa74d402126f1d30a986f3a88428d93232de75dd710591c115ff2f090dbb');
    expect(f.result.bindings.some(row => row.predicate === 'http://dkg.io/ontology/accessPolicy')).toBe(false);
    expect(f.request.assetUal).toBe('did:dkg:base:8453/0x1111111111111111111111111111111111111111/1');
    const parsed = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(f.store,
      { contextGraphId: f.request.contextGraphId, ual: f.request.assetUal });
    expect(parsed.state).toBe('confirmed');
    if (parsed.state !== 'confirmed') throw new Error('Anonymized confirmed envelope absent');
    expect(parsed.envelope).toMatchObject({ assertionVersion: '1', publicTripleCount: 10_000,
      privateTripleCount: 0, assertionGraph: f.request.graph,
      transactionHash: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
      batchId: 12345n });
    expect(Buffer.from(parsed.envelope.merkleRoot).toString('hex')).toBe('abababababababababababababababababababababababababababababababab');
    expect(f.query.mock.calls.some(([, options]) => options?.source?.endsWith('.payload'))).toBe(false);
  });

  it.each(['absent', 'false'] as const)('refuses the anonymized legacy policy when trusted authority is %s', async grant => {
    const f = anonymizedLegacyMetadata(), authorizeMissingAccessPolicy = vi.fn(async () => false), onFallback = vi.fn();
    expect(await f.cache.acquireEncoded({ ...f.request, onFallback,
      ...(grant === 'false' ? { authorizeMissingAccessPolicy } : {}) })).toBeNull();
    expect(onFallback.mock.calls).toEqual([['non-public', undefined]]);
    expect(authorizeMissingAccessPolicy).toHaveBeenCalledTimes(grant === 'false' ? 1 : 0);
    expect(f.query.mock.calls.some(([, options]) => options?.source?.endsWith('.payload'))).toBe(false);
    expect(f.budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
  });

  it('requires fresh public authority before a metadata-fixture attempt can reach the local DATA sentinel', async () => {
    const f = anonymizedLegacyMetadata();
    let isPublic = true;
    const authorizeMissingAccessPolicy = vi.fn(async () => isPublic);
    const request = { ...f.request, authorizeMissingAccessPolicy };
    // A grant passes the policy gate only. No body exists to verify or retain.
    await expect(f.cache.acquireEncoded(request)).rejects.toBe(f.noCapturedData);
    expect(f.query.mock.calls.filter(([, options]) => options?.source?.endsWith('.payload'))).toHaveLength(1);
    expect(f.cache.stats().exports).toBe(0);
    expect(f.cache.stats().encodedCacheEntries).toBe(0);
    expect(f.budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
    isPublic = false;
    expect(await f.cache.acquireEncoded(request)).toBeNull();
    expect(authorizeMissingAccessPolicy).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls.filter(([, options]) => options?.source?.endsWith('.payload'))).toHaveLength(1);
  });

  it('rejects metadata fixture identity drift before consulting the trusted public grant', async () => {
    const f = anonymizedLegacyMetadata(), authorizeMissingAccessPolicy = vi.fn(async () => true);
    f.query.mockResolvedValue({ type: 'bindings', bindings: f.result.bindings.map(row =>
      row.predicate === 'http://dkg.io/ontology/publishedAt' ? { ...row, object: '"changed"' } : row) });
    await expect(f.cache.acquireEncoded({ ...f.request, authorizeMissingAccessPolicy })).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
    expect(authorizeMissingAccessPolicy).not.toHaveBeenCalled();
    expect(f.query.mock.calls.some(([, options]) => options?.source?.endsWith('.payload'))).toBe(false);
  });
});

describe('legacy missing KA policy authority', () => {
  it.each(['acquire', 'acquireEncoded'] as const)('keeps %s strict without a trusted local grant', async method => {
    const f = fixture(20); useLegacyMetadata(f);
    const onFallback = vi.fn();
    expect(await f.cache[method]({ ...f, onFallback })).toBeNull();
    expect(onFallback.mock.calls).toEqual([['non-public', undefined]]);
    expect(f.reads.some(read => read.options?.source?.endsWith('.payload'))).toBe(false);
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('serves a verified legacy assertion cold and warm only with fresh authority at every metadata fence', async () => {
    const f = fixture(20); useLegacyMetadata(f);
    const authorizeMissingAccessPolicy = vi.fn(async () => true), onFallback = vi.fn();
    const request = { ...f, authorizeMissingAccessPolicy, onFallback };
    const cold = await f.cache.acquireEncoded(request);
    expect(cold!.wholePayloadExports).toBe(1);
    expect(authorizeMissingAccessPolicy).toHaveBeenCalledTimes(2);
    await cold!.assertCurrent(); cold!.release();
    expect(authorizeMissingAccessPolicy).toHaveBeenCalledTimes(3);
    const warm = await f.cache.acquireEncoded(request);
    expect(warm!.wholePayloadExports).toBe(0);
    expect(warm!.body).toEqual(cold!.body);
    await warm!.assertCurrent(); warm!.release();
    expect(authorizeMissingAccessPolicy).toHaveBeenCalledTimes(5);
    expect(f.reads.filter(read => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
    expect(f.cache.stats().encodedCacheEntries).toBe(1);
    expect(onFallback).not.toHaveBeenCalled();
    expect(await f.cache.acquireEncoded({ ...f, onFallback })).toBeNull();
    expect(onFallback.mock.calls).toEqual([['non-public', undefined]]);
    expect(f.cache.stats().encodedCacheHits).toBe(1);
  });

  it.each(['false', 'throw', 'cancel'] as const)('does not grant legacy access when authority returns %s', async failure => {
    const f = fixture(1); useLegacyMetadata(f);
    const controller = new AbortController(), denied = new Error('Authority read failed');
    const authorizeMissingAccessPolicy = vi.fn(async () => {
      if (failure === 'throw') throw denied;
      if (failure === 'cancel') { controller.abort(denied); return true; }
      return false;
    });
    const result = f.cache.acquireEncoded({ ...f, signal: controller.signal, authorizeMissingAccessPolicy });
    if (failure === 'false') expect(await result).toBeNull();
    else await expect(result).rejects.toBe(denied);
    expect(authorizeMissingAccessPolicy).toHaveBeenCalledOnce();
    expect(f.reads.some(read => read.options?.source?.endsWith('.payload'))).toBe(false);
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it.each(['private', 'unknown', 'duplicate-public', 'public-and-private'] as const)('never overrides an explicit %s policy', async policy => {
    const f = fixture(1);
    const publicQuad = f.meta.find(quad => quad.predicate === 'http://dkg.io/ontology/accessPolicy')!;
    if (policy === 'duplicate-public') f.meta.push({ ...publicQuad });
    else if (policy === 'public-and-private') f.meta.push({ ...publicQuad, object: '"private"' });
    else publicQuad.object = JSON.stringify(policy);
    const authorizeMissingAccessPolicy = vi.fn(async () => true);
    expect(await f.cache.acquireEncoded({ ...f, authorizeMissingAccessPolicy })).toBeNull();
    expect(authorizeMissingAccessPolicy).not.toHaveBeenCalled();
    expect(f.reads.some(read => read.options?.source?.endsWith('.payload'))).toBe(false);
  });

  it('never uses the legacy grant for a confirmed private commitment', async () => {
    const f = fixture(1); useLegacyMetadata(f);
    f.meta.find(quad => quad.predicate === 'http://dkg.io/ontology/privateTripleCount')!.object = '"1"';
    f.meta.push({ ...f.meta[0]!, predicate: 'http://dkg.io/ontology/privateMerkleRoot', object: `"0x${'11'.repeat(32)}"` });
    const authorizeMissingAccessPolicy = vi.fn(async () => true);
    expect(await f.cache.acquireEncoded({ ...f, authorizeMissingAccessPolicy })).toBeNull();
    expect(authorizeMissingAccessPolicy).not.toHaveBeenCalled();
    expect(f.reads.some(read => read.options?.source?.endsWith('.payload'))).toBe(false);
  });

  it.each(['cold', 'warm'] as const)('rejects %s completion when fresh CG authority becomes private', async mode => {
    const f = fixture(20); useLegacyMetadata(f);
    const authorizeMissingAccessPolicy = vi.fn(async () => true);
    const request = { ...f, authorizeMissingAccessPolicy };
    if (mode === 'warm') {
      const cold = await f.cache.acquireEncoded(request); await cold!.assertCurrent(); cold!.release();
    }
    const lease = await f.cache.acquireEncoded(request);
    authorizeMissingAccessPolicy.mockResolvedValue(false);
    try { await expect(lease!.assertCurrent()).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' }); }
    finally { lease!.release(); }
    expect(f.cache.stats().encodedCacheEntries).toBe(mode === 'warm' ? 1 : 0);
    expect(f.budget.stats().bytesEstimate).toBe(f.cache.stats().encodedCacheBytes);
  });

  it('checks the complete metadata identity before considering a legacy authority grant', async () => {
    const f = fixture(20); useLegacyMetadata(f);
    const authorizeMissingAccessPolicy = vi.fn(async () => true), request = { ...f, authorizeMissingAccessPolicy };
    const cold = await f.cache.acquireEncoded(request); await cold!.assertCurrent(); cold!.release();
    const calls = authorizeMissingAccessPolicy.mock.calls.length;
    f.meta.push({ ...f.meta[0]!, predicate: 'urn:changed-immutable-metadata', object: '"changed"' });
    await expect(f.cache.acquireEncoded({ ...request, expectedIdentity: cold!.identity })).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
    expect(authorizeMissingAccessPolicy).toHaveBeenCalledTimes(calls);
    expect(f.cache.stats().encodedCacheHits).toBe(0);
  });

  it('still rejects a corrupt body despite a successful legacy authority grant', async () => {
    const f = fixture(20); useLegacyMetadata(f); f.payload[0]!.object = '"corrupted"';
    await expect(f.cache.acquireEncoded({ ...f, authorizeMissingAccessPolicy: async () => true })).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_INVALID' });
    expect(f.cache.stats().encodedCacheEntries).toBe(0);
    expect(f.budget.stats().snapshots).toBe(0);
  });
});

describe('bounded exact asset export ownership', () => {
  it.each([
    { maxBytesEstimate: 32 * 1024 * 1024, maxSnapshotBytesEstimate: 128 * 1024 * 1024, reason: 'global_bytes' },
    { maxBytesEstimate: 384 * 1024 * 1024, maxSnapshotBytesEstimate: 32 * 1024 * 1024, reason: 'snapshot_bytes' },
  ] as const)('reports build refusal with its request-scoped $reason quota', async limits => {
    const f = fixture(1);
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 100_000, maxSnapshotRows: 100_000, ...limits,
    });
    const cache = createBoundedExactAssetExportCache({ store: f.store, budget });
    const onFallback = vi.fn();
    expect(await cache.acquireEncoded({ ...f, onFallback })).toBeNull();
    expect(onFallback.mock.calls).toEqual([['build-admission', limits.reason]]);
    expect(cache.stats().fallbacks).toEqual({ 'build-admission': 1 });
    expect(f.reads.some(read => read.options?.source?.endsWith('.payload'))).toBe(false);
    expect(budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
  });

  it('reports an oversize attempted query despite absence of its fulfilled payload stage', async () => {
    const f = fixture(1), normal = f.query.getMockImplementation()!;
    const onFallback = vi.fn(), onStage = vi.fn();
    f.query.mockImplementation(async (sparql, options) => {
      if (options?.source?.endsWith('.payload')) {
        throw new StoreResponseTooLargeError(EXACT_ASSET_EXPORT_MAX_STORE_BYTES, EXACT_ASSET_EXPORT_MAX_STORE_BYTES + 1);
      }
      return normal(sparql, options);
    });
    expect(await f.cache.acquireEncoded({ ...f, onFallback, onStage })).toBeNull();
    expect(f.query.mock.calls.some(([, options]) => options?.source?.endsWith('.payload'))).toBe(true);
    expect(onFallback.mock.calls).toEqual([['store-byte-profile', undefined]]);
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(['export-metadata-before']);
    expect(f.budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
  });

  it.each(['throw', 'reject'] as const)('preserves refusal when its observation %s fails', async failure => {
    const f = fixture(1);
    const onFallback = vi.fn(() => {
      if (failure === 'throw') throw new Error('Observation failure');
      return Promise.reject(new Error('Observation failure'));
    });
    expect(await f.cache.acquireEncoded({ ...f, expectedRows: EXACT_ASSET_EXPORT_MAX_ROWS + 1, onFallback })).toBeNull();
    expect(onFallback.mock.calls).toEqual([['row-profile', undefined]]);
    expect(f.cache.stats().fallbacks).toEqual({ 'row-profile': 1 });
    expect(f.reads).toHaveLength(0);
    await Promise.resolve();
  });

  it('keeps concurrently observed refusal reasons bound to their own requests', async () => {
    const f = fixture(1), normal = f.query.getMockImplementation()!;
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    f.query.mockImplementation(async (sparql, options) => {
      if (options?.source?.endsWith('.payload')) {
        entered(); await held;
        throw new StoreResponseTooLargeError(EXACT_ASSET_EXPORT_MAX_STORE_BYTES, EXACT_ASSET_EXPORT_MAX_STORE_BYTES + 1);
      }
      return normal(sparql, options);
    });
    const oversized = vi.fn(), overRows = vi.fn();
    const first = f.cache.acquireEncoded({ ...f, onFallback: oversized });
    try {
      await started;
      expect(await f.cache.acquireEncoded({ ...f, expectedRows: EXACT_ASSET_EXPORT_MAX_ROWS + 1, onFallback: overRows })).toBeNull();
      expect(overRows.mock.calls).toEqual([['row-profile', undefined]]);
      expect(oversized).not.toHaveBeenCalled();
      finish();
      expect(await first).toBeNull();
      expect(oversized.mock.calls).toEqual([['store-byte-profile', undefined]]);
      expect(overRows).toHaveBeenCalledOnce();
      expect(f.cache.stats().fallbacks).toEqual({ 'row-profile': 1, 'store-byte-profile': 1 });
      expect(f.budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
    } finally { finish(); await first; }
  });

  it('reports warm response admission pressure and preserves the retained body for a later response', async () => {
    const f = fixture(1), onFallback = vi.fn();
    const cold = await f.cache.acquireEncoded({ ...f, onFallback });
    await cold!.assertCurrent(); cold!.release();
    const ids = Array.from({ length: 3 }, () => Symbol('other-pinned-response'));
    for (const id of ids) f.budget.admit({ id, key: 'bounded-fixture', rows: 0,
      bytesEstimate: 96 * 1024 * 1024, phase: 'durable_data', onEvict: () => {} });
    try {
      expect(await f.cache.acquireEncoded({ ...f, onFallback })).toBeNull();
      expect(onFallback.mock.calls).toEqual([['response-admission', 'global_bytes']]);
      expect(f.cache.stats().encodedCacheEntries).toBe(1);
      expect(f.reads.filter(read => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
    } finally { for (const id of ids) f.budget.remove(id); }
    const warm = await f.cache.acquireEncoded({ ...f, onFallback });
    expect(warm!.wholePayloadExports).toBe(0);
    await warm!.assertCurrent(); warm!.release();
    expect(onFallback).toHaveBeenCalledOnce();
    expect(f.budget.stats()).toEqual({ snapshots: 1, rows: 0, bytesEstimate: f.cache.stats().encodedCacheBytes });
  });

  it('observes export substages while preserving bounded reads and the final metadata fence', async () => {
    const f = fixture(20);
    const onStage = vi.fn();
    const lease = await f.cache.acquire({ ...f, onStage });
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([
      'export-metadata-before', 'export-store-payload-query',
      'export-canonical-preparation-root', 'export-metadata-after',
    ]);
    expect(onStage.mock.calls.every(([, duration]) => Number.isFinite(duration) && duration >= 0)).toBe(true);
    expect(lease!.rows).toHaveLength(20);
    expect(f.reads.filter(read => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
    expect(f.reads.filter(read => read.options?.source?.endsWith('.metadata'))).toHaveLength(2);
    f.meta.push({ graph: f.meta[0]!.graph, subject: f.assetUal, predicate: 'urn:fence-change', object: '"changed"' });
    await expect(lease!.assertCurrent()).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
    expect(f.reads.filter(read => read.options?.source?.endsWith('.metadata'))).toHaveLength(3);
    lease!.release();
    expect(f.budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
  });

  it.each(['throw', 'reject'] as const)('keeps observer %s failures outside export and lease ownership', async mode => {
    const f = fixture(20);
    const onStage = vi.fn((_stage: string, _durationMs: number) => {
      if (mode === 'throw') throw new Error('observational failure');
      return Promise.reject(new Error('observational failure'));
    });
    const lease = await f.cache.acquire({ ...f, onStage });
    expect(onStage).toHaveBeenCalledTimes(4);
    expect(lease!.rows).toHaveLength(20);
    await lease!.assertCurrent();
    lease!.release();
    await Promise.resolve();
    expect(f.budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
  });

  it('exports a genuine 10k-root fixture in one bounded physical payload read', async () => {
    const f = fixture();
    const lease = await f.cache.acquire(f);
    expect(lease?.rows).toHaveLength(10_000);
    expect(f.reads.filter((read) => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
    expect(f.reads.find((read) => read.options?.source?.endsWith('.payload'))).toMatchObject({
      options: { maxResponseBytes: EXACT_ASSET_EXPORT_MAX_STORE_BYTES, priority: 'background' },
    });
    expect(f.reads.find((read) => read.options?.source?.endsWith('.payload'))!.query).toContain('LIMIT 10001');
    expect(f.reads.some(read => /COUNT\(|ORDER BY|OFFSET/.test(read.query))).toBe(false);
    expect(Object.isFrozen(lease!.rows)).toBe(true);
    expect(Object.isFrozen(lease!.rows[0])).toBe(true);
    await lease!.assertCurrent();
    expect(f.budget.stats().bytesEstimate).toBeGreaterThan(64 * 1024 * 1024);
    lease!.release(); lease!.release();
    expect(f.budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
  });

  it('recomputes every page on a revisionless Blazegraph store and fences the session metadata', async () => {
    const f = fixture(300);
    const first = await f.cache.acquire(f);
    first!.release();
    const second = await f.cache.acquire({ ...f, expectedIdentity: first!.identity });
    second!.release();
    expect(f.reads.filter((read) => read.options?.source?.endsWith('.payload'))).toHaveLength(2);
    f.meta.push({ graph: f.meta[0]!.graph, subject: f.assetUal, predicate: 'urn:changed-control', object: '"changed"' });
    await expect(f.cache.acquire({ ...f, expectedIdentity: first!.identity })).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
  });

  it('reuses only a stable source/meta revision and rejects mutation after acquisition', async () => {
    const f = fixture(300);
    let generation = 1;
    Object.assign(f.store, { getWriteRevision: () => ({ generation, stable: true }) });
    const cache = createBoundedExactAssetExportCache({ store: f.store, budget: f.budget, maxEntries: 1 });
    const first = await cache.acquire(f); first!.release();
    const second = await cache.acquire(f);
    expect(f.reads.filter((read) => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
    generation += 1;
    await expect(second!.assertCurrent()).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
    second!.release();
    const third = await cache.acquire(f); third!.release();
    expect(f.reads.filter((read) => read.options?.source?.endsWith('.payload'))).toHaveLength(2);
  });

  it('expires a retained identity when metadata changes into a fast-profile refusal', async () => {
    const f = fixture(20);
    const first = await f.cache.acquire(f);
    first!.release();
    f.meta.find((quad) => quad.predicate === 'http://dkg.io/ontology/accessPolicy')!.object = '"private"';
    await expect(f.cache.acquire({ ...f, expectedIdentity: first!.identity })).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
    expect(f.reads.filter((read) => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
  });

  it('keeps malformed cold metadata an integrity error before any authority grant or payload read', async () => {
    const f = fixture(20), authorizeMissingAccessPolicy = vi.fn(async () => true);
    f.query.mockResolvedValue({ type: 'bindings', bindings: [{ predicate: 'urn:missing-object' }] });
    await expect(f.cache.acquire({ ...f, authorizeMissingAccessPolicy })).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_INVALID' });
    expect(authorizeMissingAccessPolicy).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledOnce();
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it.each(['byte-limit', 'row-limit', 'non-bindings', 'malformed-binding'] as const)(
    'expires retained metadata on an unreadable %s profile', async (kind) => {
      const f = fixture(20);
      const first = await f.cache.acquire(f);
      first!.release();
      const normal = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (sparql, options) => {
        if (options?.source !== 'sync.responder.exactAssetExport.metadata') return normal(sparql, options);
        if (kind === 'byte-limit') throw new StoreResponseTooLargeError(64 * 1024, 64 * 1024 + 1);
        if (kind === 'row-limit') return { type: 'bindings', bindings: Array.from({ length: 129 }, () => ({ predicate: 'urn:overflow', object: '"overflow"' })) };
        if (kind === 'non-bindings') return { type: 'boolean', value: true };
        return { type: 'bindings', bindings: [{ predicate: 'urn:missing-object' }] };
      });
      await expect(f.cache.acquire({ ...f, expectedIdentity: first!.identity })).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
      expect(f.reads.filter((read) => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
      expect(f.budget.stats().snapshots).toBe(0);
    },
  );

  it('refuses a larger row profile before any payload or metadata query', async () => {
    const f = fixture(1);
    expect(await f.cache.acquire({ ...f, expectedRows: EXACT_ASSET_EXPORT_MAX_ROWS + 1 })).toBeNull();
    expect(f.reads).toHaveLength(0);
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('treats a canonical-size fast-profile refusal as fallback rather than invalid content', async () => {
    const f = fixture(80, 'x'.repeat(60_000));
    expect(await f.cache.acquire(f)).toBeNull();
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('falls back on physical response byte overflow and retains no budget charge', async () => {
    const f = fixture(1);
    const normal = f.query.getMockImplementation()!;
    f.query.mockImplementation((sparql, options) => options?.source?.endsWith('.payload')
      ? Promise.reject(new StoreResponseTooLargeError(EXACT_ASSET_EXPORT_MAX_STORE_BYTES, EXACT_ASSET_EXPORT_MAX_STORE_BYTES + 1))
      : normal(sparql, options));
    expect(await f.cache.acquire(f)).toBeNull();
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('fails closed on a same-count corrupt body instead of serving or caching it', async () => {
    const f = fixture(10);
    f.payload[0]!.object = '"corrupt"';
    await expect(f.cache.acquire(f)).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_INVALID' });
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it.each([null, { type: 'bindings', bindings: null }, { type: 'bindings', bindings: [null] },
    { type: 'bindings', bindings: [{ s: 'urn:s', p: 'urn:p' }] }, { type: 'bindings', bindings: [] },
  ])('preserves the export integrity error and releases the build for malformed payload %j', async result => {
    const f = fixture(1);
    const normal = f.query.getMockImplementation()!;
    f.query.mockImplementation((sparql, options) => options?.source?.endsWith('.payload')
      ? Promise.resolve(result as never) : normal(sparql, options));
    await expect(f.cache.acquire(f)).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_INVALID' });
    expect(f.reads.filter(read => read.options?.source?.endsWith('.metadata'))).toHaveLength(1);
    expect(f.query.mock.calls.filter(([, options]) => options?.source?.endsWith('.payload'))).toHaveLength(1);
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('rejects distinct raw rows that serialize to the same canonical triple', async () => {
    const f = fixture(2);
    f.payload[0]!.object = '"1"^^urn:type';
    f.payload[1] = { ...f.payload[0]!, object: '"1"^^<urn:type>' };
    await expect(f.cache.acquire(f)).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_INVALID' });
    expect(f.cache.stats().exports).toBe(0);
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it.each(['blank-nodes', 'heap-profile'] as const)('retains the exporter %s refusal without count queries or fallback', async reason => {
    const f = reason === 'heap-profile' ? fixture(1000, 'bounded', 'x'.repeat(20_000)) : fixture(1);
    if (reason === 'blank-nodes') f.payload[0]!.object = '_:local';
    const onFallback = vi.fn();
    expect(await f.cache.acquire({ ...f, onFallback })).toBeNull();
    expect(onFallback).toHaveBeenCalledWith(reason, undefined);
    expect(f.reads.filter(read => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
    expect(f.reads.filter(read => read.options?.source?.endsWith('.metadata'))).toHaveLength(1);
    expect(f.reads.some(read => /COUNT\(|ORDER BY|OFFSET/.test(read.query))).toBe(false);
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('does not dispatch a payload when shared memory admission rejects the build', async () => {
    const f = fixture(1);
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 100_000, maxBytesEstimate: 32 * 1024 * 1024,
      maxSnapshotRows: 100_000, maxSnapshotBytesEstimate: 32 * 1024 * 1024,
    });
    const cache = createBoundedExactAssetExportCache({ store: f.store, budget });
    expect(await cache.acquire(f)).toBeNull();
    expect(f.reads.filter((read) => read.options?.source?.endsWith('.payload'))).toHaveLength(0);
    expect(budget.stats().snapshots).toBe(0);
  });

  it('holds physical ownership and its reservation when cancellation arrives during a query', async () => {
    const f = fixture(10);
    const normal = f.query.getMockImplementation()!;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    f.query.mockImplementation(async (sparql, options) => {
      if (options?.source?.endsWith('.payload')) { started(); await held; }
      return normal(sparql, options);
    });
    const controller = new AbortController();
    const onStage = vi.fn((_stage: string, _durationMs: number) => { throw new Error('observational failure during cancellation'); });
    let settled = false;
    const work = f.cache.acquire({ ...f, signal: controller.signal, onStage }).finally(() => { settled = true; });
    const observed = work.catch((error) => error);
    await entered; controller.abort(Object.assign(new Error('test cancellation'), { name: 'AbortError' }));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(['export-metadata-before']);
    expect(f.budget.stats().bytesEstimate).toBe(80 * 1024 * 1024);
    finish();
    expect(await observed).toMatchObject({ name: 'AbortError' });
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(['export-metadata-before', 'export-store-payload-query']);
    expect(f.budget.stats().snapshots).toBe(0);
  });
});

async function warmEncoded(f: ReturnType<typeof fixture>, cache: ExactAssetExportCache = f.cache) {
  const lease = await cache.acquireEncoded(f);
  if (!lease) throw new Error('Encoded fixture refused');
  try { await lease.assertCurrent(); return lease.body.slice(); }
  finally { lease.release(); }
}

describe('bounded verified encoded asset retention', () => {
  it.each(['rows', 'store-bytes', 'canonical-bytes'] as const)('preserves the cold %s profile instead of retaining oversized bytes', async profile => {
    const f = profile === 'canonical-bytes' ? fixture(80, 'x'.repeat(60_000)) : fixture(30);
    const encode = vi.spyOn(wireCompression, 'encodeNegotiatedExactSyncResponse');
    if (profile === 'store-bytes') {
      const query = f.query.getMockImplementation()!;
      f.query.mockImplementation((sparql, options) => options?.source?.endsWith('.payload')
        ? Promise.reject(new StoreResponseTooLargeError(EXACT_ASSET_EXPORT_MAX_STORE_BYTES, EXACT_ASSET_EXPORT_MAX_STORE_BYTES + 1))
        : query(sparql, options));
    }
    const request = profile === 'rows' ? { ...f, expectedRows: EXACT_ASSET_EXPORT_MAX_ROWS + 1 } : f;
    expect(await f.cache.acquireEncoded(request)).toBeNull();
    expect(encode).not.toHaveBeenCalled();
    expect(f.cache.stats().encodedCacheEntries).toBe(0);
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('preserves the real 16 MiB inflated-wire cap even when a compact canonical body fits', async () => {
    // The graph IRI is repeated on the wire but excluded from the canonical
    // root. Unicode makes its UTF-8 wire size exceed the codec cap while the
    // existing row heap and graph-free canonical construction remain bounded.
    const f = fixture(10_000, 'bounded-value', '界'.repeat(1_200));
    await expect(f.cache.acquireEncoded(f)).rejects.toThrow('decoded page exceeds bounded transport profile');
    expect(f.cache.stats().encodedCacheEntries).toBe(0);
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('reuses a revisionless verified body with fresh complete metadata and a final fence', async () => {
    const f = fixture(300);
    const body = await warmEncoded(f);
    expect(f.cache.stats()).toMatchObject({ exports: 1, encodedCacheEntries: 1, encodedCacheHits: 0 });
    expect(f.budget.stats()).toMatchObject({ snapshots: 1, rows: 0,
      bytesEstimate: f.cache.stats().encodedCacheBytes });
    const before = f.reads.length;
    const onStage = vi.fn();
    const hit = await f.cache.acquireEncoded({ ...f, onStage });
    expect(hit).toMatchObject({ wholePayloadExports: 0, encodingDurationMs: 0 });
    expect(hit!.body).toEqual(body);
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(['export-metadata-before']);
    expect(f.reads.slice(before).map(read => read.options?.source)).toEqual(['sync.responder.exactAssetExport.metadata']);
    await hit!.assertCurrent();
    expect(f.reads.slice(before).map(read => read.options?.source)).toEqual([
      'sync.responder.exactAssetExport.metadata', 'sync.responder.exactAssetExport.metadata',
    ]);
    hit!.release(); hit!.release();
    expect(f.reads.filter(read => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
    // Legacy row reads deliberately retain their revisionless cold behavior.
    const legacy = await f.cache.acquire(f); legacy!.release();
    expect(f.reads.filter(read => read.options?.source?.endsWith('.payload'))).toHaveLength(2);
    expect(f.cache.stats()).toMatchObject({ cacheHits: 0, encodedCacheHits: 1 });
  });

  it('never promotes an unfenced or caller-corrupted cold response', async () => {
    const f = fixture(30);
    const unfenced = await f.cache.acquireEncoded(f); unfenced!.release();
    expect(f.cache.stats().encodedCacheEntries).toBe(0);
    const corrupted = await f.cache.acquireEncoded(f);
    corrupted!.body[corrupted!.body.length - 1] ^= 0xff;
    await expect(corrupted!.assertCurrent()).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_INVALID' });
    corrupted!.release();
    expect(f.cache.stats().encodedCacheEntries).toBe(0);
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('isolates warm response mutation from every retained body copy', async () => {
    const f = fixture(30), body = await warmEncoded(f);
    const first = await f.cache.acquireEncoded(f);
    first!.body.fill(0); first!.release();
    const second = await f.cache.acquireEncoded(f);
    expect(second!.body).toEqual(body);
    expect(second!.body.buffer).not.toBe(first!.body.buffer);
    const decoded = await wireCompression.decodeNegotiatedExactSyncResponse(second!.body, { allowCompression: true });
    expect(decoded.bytes.byteLength).toBe(second!.plainBytes);
    await second!.assertCurrent(); second!.release();
    expect(f.cache.stats().encodedCacheHits).toBe(2);
  });

  it('serves the earlier immutable verified copy after revisionless DATA-only corruption', async () => {
    const f = fixture(30), body = await warmEncoded(f);
    f.payload[0]!.object = '"local-corruption"';
    const warm = await f.cache.acquireEncoded(f);
    expect(warm!.body).toEqual(body);
    await warm!.assertCurrent(); warm!.release();
    expect(f.reads.filter(read => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
    // This is deliberately not proof that present DATA matches the root.
    await expect(f.cache.acquire(f)).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_INVALID' });
  });

  it.each(['accessPolicy', 'merkleRoot', 'assertionVersion', 'publicTripleCount', 'assertionGraph'])(
    'refuses a retained session when fresh %s changes', async predicate => {
      const f = fixture(30);
      await warmEncoded(f);
      const lease = await f.cache.acquireEncoded(f);
      f.meta.find(quad => quad.predicate === `http://dkg.io/ontology/${predicate}`)!.object = '"changed"';
      await expect(lease!.assertCurrent()).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
      lease!.release();
      await expect(f.cache.acquireEncoded({ ...f, expectedIdentity: lease!.identity }))
        .rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
      expect(f.reads.filter(read => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
    },
  );

  it('refuses fresh private metadata without reading or returning retained DATA', async () => {
    const f = fixture(30);
    await warmEncoded(f);
    f.meta.find(quad => quad.predicate === 'http://dkg.io/ontology/accessPolicy')!.object = '"private"';
    expect(await f.cache.acquireEncoded(f)).toBeNull();
    expect(f.cache.stats().encodedCacheHits).toBe(0);
    expect(f.reads.filter(read => read.options?.source?.endsWith('.payload'))).toHaveLength(1);
  });

  it('misses on any complete metadata change and on a valid assertion version/graph change', async () => {
    const f = fixture(30);
    await warmEncoded(f);
    f.meta.push({ graph: f.meta[0]!.graph, subject: f.assetUal, predicate: 'urn:full-identity', object: '"new"' });
    await warmEncoded(f);
    const graph = knowledgeAssetLayerGraphUri(f.contextGraphId, MemoryLayer.VerifiableMemory,
      createGraphKnowledgeAssetScope(f.assetUal, 2));
    const meta = generateGraphKnowledgeAssetMetadata({ ual: f.assetUal, contextGraphId: f.contextGraphId,
      assertionGraph: graph, assertionVersion: '2', merkleRoot: computeFlatKCRootV10(f.payload, []),
      publisherPeerId: 'publisher', accessPolicy: 'public', timestamp: new Date(0),
      publicTripleCount: f.expectedRows, privateTripleCount: 0,
    }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: {
      txHash: `0x${'11'.repeat(32)}`, batchId: 1n,
    } } });
    f.meta.splice(0, f.meta.length, ...meta);
    const version = await f.cache.acquireEncoded({ ...f, graph });
    expect(version!.wholePayloadExports).toBe(1);
    await version!.assertCurrent(); version!.release();
    expect(f.reads.filter(read => read.options?.source?.endsWith('.payload'))).toHaveLength(3);
    expect(f.cache.stats().encodedCacheHits).toBe(0);
  });

  it('retains stable revision fences and rebuilds after a source revision changes', async () => {
    const f = fixture(30);
    let generation = 1;
    Object.assign(f.store, { getWriteRevision: () => ({ generation, stable: true }) });
    const cache = createBoundedExactAssetExportCache({ store: f.store, budget: f.budget });
    await warmEncoded(f, cache);
    const hit = await cache.acquireEncoded(f);
    generation += 1;
    await expect(hit!.assertCurrent()).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
    hit!.release();
    await warmEncoded(f, cache);
    expect(f.reads.filter(read => read.options?.source?.endsWith('.payload'))).toHaveLength(2);
  });

  it('expires idle entries and refuses retention above a shrunken byte limit', async () => {
    const f = fixture(30);
    let now = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const cache = createBoundedExactAssetExportCache({ store: f.store, budget: f.budget, encodedTtlMs: 50 });
    await warmEncoded(f, cache);
    now += 51;
    expect(cache.stats().encodedCacheEntries).toBe(0);
    expect(f.budget.stats().snapshots).toBe(0);
    const noRetention = createBoundedExactAssetExportCache({ store: f.store, budget: f.budget, encodedMaxBytes: 1 });
    await warmEncoded(f, noRetention);
    expect(noRetention.stats().encodedCacheEntries).toBe(0);
    expect(f.budget.stats().snapshots).toBe(0);
    expect(() => createBoundedExactAssetExportCache({ store: f.store, budget: f.budget,
      encodedMaxBytes: EXACT_ASSET_ENCODED_CACHE_MAX_BYTES + 1 })).toThrow(RangeError);
  });

  it('evicts idle entries by its own bound but keeps active entries pinned', async () => {
    const f = fixture(30);
    const cache = createBoundedExactAssetExportCache({ store: f.store, budget: f.budget, encodedMaxEntries: 1 });
    const body = await warmEncoded(f, cache);
    const active = await cache.acquireEncoded(f);
    f.meta.push({ graph: f.meta[0]!.graph, subject: f.assetUal, predicate: 'urn:cache-generation', object: '"second"' });
    await warmEncoded(f, cache);
    expect(cache.stats().encodedCacheEntries).toBe(1);
    active!.release();
    f.meta.pop();
    const original = await cache.acquireEncoded(f);
    expect(original!.wholePayloadExports).toBe(0); expect(original!.body).toEqual(body); original!.release();
    f.meta.push({ graph: f.meta[0]!.graph, subject: f.assetUal, predicate: 'urn:cache-generation', object: '"third"' });
    await warmEncoded(f, cache);
    expect(cache.stats().encodedCacheEntries).toBe(1);
    f.meta.pop();
    const evicted = await cache.acquireEncoded(f);
    expect(evicted!.wholePayloadExports).toBe(1); evicted!.release();
  });

  it('shares global pressure eviction and never evicts a physically active response', async () => {
    const f = fixture(30);
    await warmEncoded(f);
    const hit = await f.cache.acquireEncoded(f);
    const pressure = [Symbol('pressure-1'), Symbol('pressure-2'), Symbol('pressure-3')];
    const admit = (id: symbol) => f.budget.admit({ id, key: 'pressure', rows: 0,
      bytesEstimate: 128 * 1024 * 1024, phase: 'durable_data', onEvict: () => {} });
    admit(pressure[0]!); admit(pressure[1]!);
    expect(() => admit(pressure[2]!)).toThrow(SyncRowSnapshotBudgetError);
    expect(f.cache.stats().encodedCacheEntries).toBe(1);
    await hit!.assertCurrent(); hit!.release();
    admit(pressure[2]!);
    expect(f.cache.stats().encodedCacheEntries).toBe(0);
    for (const id of pressure) f.budget.remove(id);
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('fits 147 MiB of idle bytes with two responses and evicts 35 MiB before a third cold build', () => {
    const f = fixture(1), mib = 1024 * 1024;
    const idle = new Set<symbol>();
    for (let index = 0; index < 147; index += 1) {
      const id = Symbol('retained-compressed-mib');
      idle.add(id);
      f.budget.admit({ id, key: 'retained-compressed', rows: 0, bytesEstimate: mib,
        phase: 'durable_data', onEvict: () => { idle.delete(id); } });
      f.budget.release(id);
    }
    const responses = [Symbol('response-1'), Symbol('response-2')];
    for (const id of responses) f.budget.admit({ id, key: 'physical-response', rows: 0,
      bytesEstimate: 96 * mib, phase: 'durable_data', onEvict: () => { throw new Error('Active response evicted'); } });
    expect(f.budget.stats().bytesEstimate).toBe(339 * mib);
    const build = Symbol('third-cold-build');
    f.budget.admit({ id: build, key: 'physical-build', rows: 2, bytesEstimate: 80 * mib,
      phase: 'durable_data', onEvict: () => { throw new Error('Active build evicted'); } });
    expect(idle.size).toBe(112);
    expect(f.budget.stats().bytesEstimate).toBe(384 * mib);
    for (const id of [...idle, ...responses, build]) f.budget.remove(id);
    expect(f.budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
  });

  it('keeps physical codec ownership charged until a cancelled encoder settles', async () => {
    const f = fixture(30), controller = new AbortController();
    const encode = wireCompression.encodeNegotiatedExactSyncResponse;
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(wireCompression, 'encodeNegotiatedExactSyncResponse').mockImplementation(async (bytes, options) => {
      entered(); await held; return encode(bytes, options);
    });
    let settled = false;
    const pending = f.cache.acquireEncoded({ ...f, signal: controller.signal }).finally(() => { settled = true; });
    const observed = pending.catch(error => error);
    await started;
    controller.abort(Object.assign(new Error('cancelled codec'), { name: 'AbortError' }));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.budget.stats().bytesEstimate).toBeGreaterThan(96 * 1024 * 1024);
    expect(f.cache.stats().encodedCacheEntries).toBe(0);
    finish();
    expect(await observed).toMatchObject({ name: 'AbortError' });
    expect(f.budget.stats().snapshots).toBe(0);
  });

  it('keeps a cancelled warm source fence physically owned until its query settles', async () => {
    const f = fixture(30), controller = new AbortController();
    await warmEncoded(f);
    const hit = await f.cache.acquireEncoded({ ...f, signal: controller.signal });
    const query = f.query.getMockImplementation()!;
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    f.query.mockImplementation(async (sparql, options) => {
      if (options?.source === 'sync.responder.exactAssetExport.metadata') { entered(); await held; }
      return query(sparql, options);
    });
    let settled = false;
    const pending = hit!.assertCurrent().finally(() => { settled = true; hit!.release(); });
    const observed = pending.catch(error => error);
    await started;
    controller.abort(Object.assign(new Error('cancelled warm fence'), { name: 'AbortError' }));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.budget.stats().bytesEstimate).toBe(96 * 1024 * 1024 + f.cache.stats().encodedCacheBytes);
    finish();
    expect(await observed).toMatchObject({ name: 'AbortError' });
    expect(f.budget.stats()).toEqual({ snapshots: 1, rows: 0, bytesEstimate: f.cache.stats().encodedCacheBytes });
  });
});

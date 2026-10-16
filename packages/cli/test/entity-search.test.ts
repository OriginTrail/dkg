import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { startOxigraphSparqlEndpoint } from '../../storage/test/helpers/oxigraph-sparql-endpoint.js';
import { OxigraphStore, SparqlHttpStore, SharedMemoryLiteralBlobStore, StoreResponseTooLargeError } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../../query/src/dkg-query-engine.js';
import { EntityGraphReader, indexKey, parseSpec } from '../src/entity-search/documents.js';
import { parseIndexRequest, parseSearchRequest, parseReadinessRequest } from '../src/entity-search/requests.js';
import { EntityIndexStore } from '../src/entity-search/store.js';
import { EntitySearchService } from '../src/entity-search/service.js';
import { LocalEntityEmbedder } from '../src/entity-search/embedding.js';
import { handleEntityRoutes } from '../src/daemon/routes/entities.js';
import { configureApiQueryPriority } from '../src/daemon/api-query-priority.js';
import { requestAuthentication } from './_helpers/request-authentication.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

const spec = { contextGraphId: 'catalog', view: 'verifiable-memory' as const,
  textPredicates: ['urn:description'], types: ['urn:Topic'] };
const partition = 'did:dkg:context-graph:catalog/_verifiable_memory/a';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture(count = 3, capacity = 100_000, http = false, blobs = false) {
  const dir = mkdtempSync(join(tmpdir(), 'entity-search-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const endpoint = http ? await startOxigraphSparqlEndpoint() : undefined;
  if (endpoint) cleanup.push(() => endpoint.close());
  const inner = endpoint ? new SparqlHttpStore({ queryEndpoint: endpoint.queryEndpoint, updateEndpoint: endpoint.updateEndpoint }) : new OxigraphStore();
  const graph = blobs ? new SharedMemoryLiteralBlobStore(inner, { blobDir: join(dir, 'blobs'), thresholdBytes: 40 }) : inner;
  cleanup.push(() => graph.close());
  const engine = new DKGQueryEngine(graph);
  let permitted = true;
  let allowedCaller: string | undefined;
  const agent = { query: vi.fn(async (sparql, options) => {
    if (!permitted || (allowedCaller !== undefined && options?.callerAgentAddress !== allowedCaller)) throw Object.assign(new Error('denied'), { code: 'QUERY_ACCESS_DENIED' });
    return engine.query(sparql, options);
  }) };
  for (let i = 0; i < count; i++) await graph.insert([
    { graph: partition, subject: `urn:entity:${i}`, predicate: 'urn:description', object: JSON.stringify(i === 0 ? 'ocean science' : 'mountain climbing') },
    { graph: partition, subject: `urn:entity:${i}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:Topic' },
  ]);
  await graph.insert([{ graph: 'did:dkg:context-graph:other/_verifiable_memory/a', subject: 'urn:secret', predicate: 'urn:description', object: '"ocean science"' },
    { graph: 'did:dkg:context-graph:other/_verifiable_memory/a', subject: 'urn:secret', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:Topic' }]);
  const embedder = { fingerprint: 'test-model-v1', dimensions: 2, ready: vi.fn(async () => true),
    embed: vi.fn(async (text: string) => text.includes('ocean') ? [1, 0] : [0, 1]) };
  const store = new EntityIndexStore(dir, capacity); cleanup.push(() => store.close());
  const service = new EntitySearchService(store, embedder), reader = new EntityGraphReader(agent as never, 'reader');
  const index = (restart = false) => service.index(parseIndexRequest({ ...spec, restart }), reader, AbortSignal.timeout(5000), performance.now() + 5000);
  const search = (query = 'ocean') => service.search(parseSearchRequest({ indexId: indexKey(parseSpec(spec), embedder.fingerprint), contextGraphId: spec.contextGraphId, query, limit: 2 }),
    reader, AbortSignal.timeout(5000), performance.now() + 5000);
  return { dir, graph, endpoint, agent, embedder, store, service, reader, index, search, deny: () => { permitted = false; }, restrictTo: (caller: string) => { allowedCaller = caller; } };
}

describe('entity discovery using current scoped graph content', () => {
  it('indexes RDF identities, searches, and uses returned identities in a subsequent SPARQL query', async () => {
    const f = await fixture(); const indexed = await f.index();
    expect(indexed).toMatchObject({ indexedEntities: 3, scanComplete: true, graphComplete: null });
    const result = await f.search();
    expect(result.entities[0]).toMatchObject({ entityUri: 'urn:entity:0', sourceGraph: partition, score: 1 });
    expect(result).toMatchObject({ exhaustive: false, coverage: 'local-indexed-subset', freshness: 'candidates-revalidated' });
    const rows = await f.reader.query(spec, `SELECT ?description WHERE { VALUES ?entity { <${result.entities[0].entityUri}> }
      GRAPH <${result.entities[0].sourceGraph}> { ?entity <urn:description> ?description } }`, AbortSignal.timeout(1000), performance.now() + 1000);
    expect(rows).toEqual([{ description: '"ocean science"' }]);
    expect(f.agent.query.mock.calls.every(([, o]) => o.contextGraphId === 'catalog' && o.callerAgentAddress === 'reader' && o.accessDenied === 'error')).toBe(true);
  });
  it('does not serve stale, deleted, or newly forbidden content from stored vectors', async () => {
    const f = await fixture(); await f.index();
    await f.graph.delete([{ graph: partition, subject: 'urn:entity:0', predicate: 'urn:description', object: '"ocean science"' }]);
    expect((await f.search()).entities.some(v => v.entityUri === 'urn:entity:0')).toBe(false);
    expect((await f.search()).staleCandidates).toBe(1);
    f.deny(); await expect(f.search()).rejects.toMatchObject({ code: 'QUERY_ACCESS_DENIED' });
  });
  it('skips a dropped partition while returning surviving authorized candidates', async () => {
    const f = await fixture(1);
    const surviving = 'did:dkg:context-graph:catalog/_verifiable_memory/b';
    await f.graph.insert([
      { graph: surviving, subject: 'urn:survivor', predicate: 'urn:description', object: '"ocean survivor"' },
      { graph: surviving, subject: 'urn:survivor', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:Topic' },
    ]);
    await f.index();
    await f.graph.dropGraph(partition);
    expect(await f.search()).toMatchObject({ staleCandidates: 1, entities: [{ entityUri: 'urn:survivor' }] });
    f.deny(); await expect(f.search()).rejects.toMatchObject({ code: 'QUERY_ACCESS_DENIED' });
  });
  it('resumes keyset pages, reuses unchanged embeddings, and prunes old entries only at a completed scan', async () => {
    const f = await fixture(10); expect(await f.index()).toMatchObject({ scanComplete: false, indexedEntities: 8 });
    expect(await f.index()).toMatchObject({ scanComplete: true, indexedEntities: 10 });
    expect(f.embedder.embed).toHaveBeenCalledTimes(10);
    await f.index(true); await f.index(); expect(f.embedder.embed).toHaveBeenCalledTimes(10);
    await f.graph.delete([{ graph: partition, subject: 'urn:entity:0', predicate: 'urn:description', object: '"ocean science"' }]);
    await f.index(true); expect(await f.index()).toMatchObject({ indexedEntities: 9 });
  });
  it('keeps empty and unfinished indexes distinguishable and authenticates even empty reads', async () => {
    const f = await fixture(0); await f.index(); expect((await f.search()).entities).toEqual([]);
    f.deny(); await expect(f.search()).rejects.toMatchObject({ code: 'QUERY_ACCESS_DENIED' });
  });
  it('refuses a changed model, malformed vectors, late synchronous work, and SPARQL injection', async () => {
    const f = await fixture(); await f.index();
    f.embedder.fingerprint = 'different';
    const id = indexKey(parseSpec(spec), 'test-model-v1');
    await expect(f.service.search(parseSearchRequest({ indexId: id, contextGraphId: 'catalog', query: 'ocean', limit: 2 }), f.reader, AbortSignal.timeout(1000), performance.now() + 1000))
      .rejects.toMatchObject({ code: 'ENTITY_EMBEDDING_MODEL_CHANGED' });
    f.embedder.fingerprint = 'test-model-v1'; f.embedder.embed.mockResolvedValue([NaN, 1]);
    await expect(f.search()).rejects.toMatchObject({ code: 'ENTITY_EMBEDDING_INVALID' });
    await expect(f.service.search(parseSearchRequest({ indexId: id, contextGraphId: 'catalog', query: 'ocean', limit: 2 }), f.reader, new AbortController().signal, performance.now() - 1))
      .rejects.toMatchObject({ code: 'QUERY_DEADLINE_EXCEEDED' });
    expect(() => parseSpec({ ...spec, textPredicates: ['urn:p> } SERVICE <http://invalid> {'] })).toThrow('ENTITY_INVALID_REQUEST');
    expect(() => parseSpec({ ...spec, textPredicates: ['urn:p' + String.fromCharCode(1)] })).toThrow('ENTITY_INVALID_REQUEST');
  });
  it('re-embeds content changes and preserves the checkpoint on embedding failure', async () => {
    const f = await fixture(); await f.index();
    await f.graph.insert([{ graph: partition, subject: 'urn:entity:0', predicate: 'urn:description', object: '"new ocean facts"' }]);
    expect((await f.search()).staleCandidates).toBe(1);
    f.embedder.embed.mockRejectedValueOnce(new Error('offline'));
    await expect(f.index(true)).rejects.toThrow('offline');
    expect(f.store.state(indexKey(parseSpec(spec), f.embedder.fingerprint))?.cursor).toBe(null);
    await f.index(); expect((await f.search()).entities[0].text).toContain('new ocean facts');
  });
});

function request(f, body, kind: 'anonymous' | 'nodeOperator' | 'agent' = 'anonymous', path = '/api/entities/search', agentAddress = 'allowed-agent') {
  const req = Object.assign(new EventEmitter(), { method: 'POST', aborted: false, __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)) });
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, statusCode: 0, body: '',
    writeHead(status: number) { this.statusCode = status; return this; }, end(body: string) { this.body = body; this.writableEnded = true; } });
  return { res, ctx: { req, res, path, agent: f.agent, entitySearch: f.service, authentication: requestAuthentication(kind === 'agent' ? { kind, agentAddress } : { kind }) } as unknown as RequestContext };
}
it('requires operator authority to index and exposes bounded typed search outcomes', async () => {
  const f = await fixture();
  const denied = request(f, spec, 'anonymous', '/api/entities/index'); await handleEntityRoutes(denied.ctx); expect(denied.res.statusCode).toBe(403);
  const allowed = request(f, spec, 'nodeOperator', '/api/entities/index'); await handleEntityRoutes(allowed.ctx); expect(allowed.res.statusCode).toBe(200);
  const body = { contextGraphId: 'catalog', indexId: JSON.parse(allowed.res.body).indexId, query: 'ocean' };
  const read = request(f, body); await handleEntityRoutes(read.ctx); expect(JSON.parse(read.res.body).entities[0].entityUri).toBe('urn:entity:0');
  const invalid = request(f, { ...body, limit: 99 }); await handleEntityRoutes(invalid.ctx); expect(invalid.res.statusCode).toBe(400);
  f.deny(); const revoked = request(f, body); await handleEntityRoutes(revoked.ctx); expect(revoked.res.statusCode).toBe(403);
});
it.each(['background', 'normal'])('honors configured %s priority for entity reads and keeps indexing background', async priority => {
  const f = await fixture();
  const logger = { info: vi.fn(), warn: vi.fn() };
  configureApiQueryPriority(priority, logger);
  cleanup.push(() => { configureApiQueryPriority(undefined, logger); });
  const indexed = await f.index();
  for (const operation of ['index', 'search', 'readiness']) {
    f.agent.query.mockClear();
    const call = request(f, { ...spec, indexId: indexed.indexId, query: 'ocean' }, 'nodeOperator', `/api/entities/${operation}`);
    await handleEntityRoutes(call.ctx);
    expect(call.res.statusCode).toBe(200);
    expect(f.agent.query).toHaveBeenCalled();
    expect(f.agent.query.mock.calls.every(([, options]) => options.priority === (operation === 'index' ? 'background' : priority))).toBe(true);
  }
});
it('changes persisted index identity for every embedding-semantic configuration change', () => {
  const config = { provider: 'ollama' as const, model: 'test', digest: 'a'.repeat(64), dimensions: 2,
    documentPrefix: 'document: ', queryPrefix: 'query: ' };
  const identity = (change = {}) => {
    const provider = new LocalEntityEmbedder({ ...config, ...change });
    return { fingerprint: provider.fingerprint, indexId: indexKey(parseSpec(spec), provider.fingerprint) };
  };
  const original = identity();
  expect(identity()).toEqual(original);
  for (const change of [{ model: 'other' }, { digest: 'b'.repeat(64) }, { dimensions: 3 },
    { documentPrefix: 'passage: ' }, { queryPrefix: 'question: ' }]) {
    const changed = identity(change);
    expect(changed.fingerprint).not.toBe(original.fingerprint);
    expect(changed.indexId).not.toBe(original.indexId);
  }
});
it('local inference pins the model digest and dimensions and refuses remote inference URLs', async () => {
  const config = { provider: 'ollama' as const, model: 'test', digest: 'a'.repeat(64), dimensions: 2 };
  expect(() => new LocalEntityEmbedder({ ...config, baseURL: 'http://example.org' })).toThrow('ENTITY_EMBEDDING_CONFIG_INVALID');
  const provider = new LocalEntityEmbedder(config);
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ models: [{ name: 'test:latest', digest: config.digest }] }))
    .mockResolvedValueOnce(Response.json({ embeddings: [[1, 0]] }))
    .mockResolvedValueOnce(Response.json({ models: [{ name: 'test:latest', digest: config.digest }] }))
    .mockResolvedValueOnce(Response.json({ models: [] }));
  vi.stubGlobal('fetch', fetch);
  expect(await provider.embed('science', 'query', AbortSignal.timeout(1000))).toEqual([1, 0]);
  await expect(provider.embed('science', 'query', AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'ENTITY_EMBEDDING_MODEL_CHANGED' });
});

it('checks current model residency and permits explicit warm-up only under current graph authority', async () => {
  const f = await fixture(); const indexed = await f.index(); f.embedder.embed.mockClear();
  const body = { contextGraphId: 'catalog', indexId: indexed.indexId };
  const check = async (extra = {}) => {
    const r = request(f, { ...body, ...extra }, 'nodeOperator', '/api/entities/readiness');
    await handleEntityRoutes(r.ctx); return { status: r.res.statusCode, body: JSON.parse(r.res.body) };
  };
  f.embedder.ready.mockResolvedValue(false);
  expect(await check()).toMatchObject({ status: 200, body: { ready: false } });
  expect(f.embedder.embed).not.toHaveBeenCalled();
  f.embedder.ready.mockResolvedValue(true);
  expect(await check({ warmup: true })).toMatchObject({ status: 200, body: { ready: true, indexedEntities: 3 } });
  expect(f.embedder.embed).toHaveBeenCalledTimes(1);
  f.embedder.ready.mockResolvedValue(false);
  expect((await check()).body.ready).toBe(false); // A previous warm-up is not permanent readiness.
  f.deny();
  expect(await check({ warmup: true })).toMatchObject({ status: 403, body: { code: 'QUERY_ACCESS_DENIED' } });
  expect(f.embedder.embed).toHaveBeenCalledTimes(1);
});

it('bounds preparation, rejects expired work and releases admission on failure', async () => {
  const f = await fixture(); const indexed = await f.index();
  let release!: (v: number[]) => void;
  f.embedder.embed.mockReturnValueOnce(new Promise<number[]>(resolve => { release = resolve; }));
  const preparing = f.service.readiness(parseReadinessRequest({ indexId: indexed.indexId, contextGraphId: 'catalog', warmup: true }), f.reader, AbortSignal.timeout(5000), performance.now() + 5000);
  await expect(f.search()).rejects.toMatchObject({ code: 'ENTITY_SEARCH_BUSY' });
  await expect(f.index()).rejects.toMatchObject({ code: 'ENTITY_INDEX_BUSY' });
  release([1, 0]); expect((await preparing).ready).toBe(true);
  await expect(f.service.readiness(parseReadinessRequest({ indexId: indexed.indexId, contextGraphId: 'catalog', warmup: false }), f.reader, new AbortController().signal, performance.now() - 1))
    .rejects.toMatchObject({ code: 'QUERY_DEADLINE_EXCEEDED' });
  expect((await f.search()).entities).toHaveLength(2);
  const provider = new LocalEntityEmbedder({ provider: 'ollama', model: 'test', digest: 'a'.repeat(64), dimensions: 2 });
  const tags = () => Response.json({ models: [{ name: 'test:latest', digest: 'a'.repeat(64) }] });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(tags()).mockResolvedValueOnce(Response.json({ models: [] }))
    .mockResolvedValueOnce(tags()).mockResolvedValueOnce(Response.json({ models: [{ name: 'test:latest', digest: 'b'.repeat(64) }] })));
  expect(await provider.ready(AbortSignal.timeout(1000))).toBe(false);
  expect(await provider.ready(AbortSignal.timeout(1000))).toBe(false);
});

it.each(['embedding', 'residency'] as const)('releases admitted warm-up after %s failure', async stage => {
  const f = await fixture(); const indexed = await f.index();
  const failure = new Error('injected provider failure');
  if (stage === 'embedding') f.embedder.embed.mockRejectedValueOnce(failure);
  else f.embedder.ready.mockRejectedValueOnce(failure);
  const warmup = () => f.service.readiness(parseReadinessRequest({ indexId: indexed.indexId, contextGraphId: 'catalog', warmup: true }), f.reader,
    AbortSignal.timeout(5000), performance.now() + 5000);
  await expect(warmup()).rejects.toBe(failure);
  expect((await f.search()).entities).toHaveLength(2);
  expect(await f.index(true)).toMatchObject({ scanComplete: true });
  expect(await warmup()).toMatchObject({ ready: true });
});

it.each([null, [], 'spec', {}, { ...spec, textPredicates: [1] }, { ...spec, types: [null] }])(
  'rejects untrusted specification input: %j', raw => {
    expect(() => parseSpec(raw)).toThrow('ENTITY_INVALID_REQUEST');
  });

it('persists a partial scan across service recreation and keeps SWM and VM indexes separate', async () => {
  const f = await fixture(9); await f.index();
  const resumedStore = new EntityIndexStore(f.dir); cleanup.push(() => resumedStore.close());
  const resumed = new EntitySearchService(resumedStore, f.embedder);
  expect(await resumed.index(parseIndexRequest(spec), f.reader, AbortSignal.timeout(5000), performance.now() + 5000))
    .toMatchObject({ indexedEntities: 9, scanComplete: true });
  await f.graph.insert([
    { graph: 'did:dkg:context-graph:catalog/_shared_memory', subject: 'urn:shared', predicate: 'urn:description', object: '"ocean"' },
    { graph: 'did:dkg:context-graph:catalog/_shared_memory', subject: 'urn:shared', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:Topic' },
  ]);
  const swm = await resumed.index(parseIndexRequest({ ...spec, view: 'shared-working-memory' }), f.reader, AbortSignal.timeout(5000), performance.now() + 5000);
  expect(swm).toMatchObject({ indexedEntities: 1, view: 'shared-working-memory' });
  expect(swm.indexId).not.toBe(indexKey(parseSpec(spec), f.embedder.fingerprint));
  expect((await f.search()).entities.every(e => e.entityUri !== 'urn:shared' && e.entityUri !== 'urn:secret')).toBe(true);
});
it('bounds concurrent embedding work and releases admission after failures', async () => {
  const f = await fixture(); await f.index();
  let release!: (v: number[]) => void;
  const held = new Promise<number[]>(resolve => { release = resolve; });
  f.embedder.embed.mockReturnValue(held);
  const first = f.search(), second = f.search();
  await expect(f.search()).rejects.toMatchObject({ code: 'ENTITY_SEARCH_BUSY' });
  release([1, 0]); await Promise.all([first, second]);
  expect((await f.search()).entities).toHaveLength(2);
  const pending = f.index(true);
  await expect(f.index()).rejects.toMatchObject({ code: 'ENTITY_INDEX_BUSY' });
  await pending;
});
it('refuses oversized documents without advancing past them', async () => {
  const f = await fixture(0);
  await f.graph.insert([
    { graph: partition, subject: 'urn:large', predicate: 'urn:description', object: JSON.stringify('x'.repeat(17_000)) },
    { graph: partition, subject: 'urn:large', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:Topic' },
  ]);
  await expect(f.index()).rejects.toMatchObject({ code: 'ENTITY_DOCUMENT_TOO_LARGE' });
  expect(f.store.state(indexKey(parseSpec(spec), f.embedder.fingerprint))?.cursor).toBe(null);
});
it.each([
  { limit: 0 }, { query: '' }, { query: 'x'.repeat(6001) }, { indexId: 'bad' },
])('rejects invalid search contracts %s', async changes => {
  const f = await fixture(); const indexed = await f.index();
  const call = request(f, { contextGraphId: 'catalog', indexId: indexed.indexId, query: 'ocean', ...changes });
  await handleEntityRoutes(call.ctx); expect(call.res.statusCode).toBe(400);
});
it('reports disabled, wrong-scope, method and timeout outcomes separately', async () => {
  const f = await fixture(); const indexed = await f.index();
  const body = { contextGraphId: 'catalog', indexId: indexed.indexId, query: 'ocean' };
  const disabled = request(f, body); disabled.ctx.entitySearch = undefined;
  await handleEntityRoutes(disabled.ctx); expect(JSON.parse(disabled.res.body).code).toBe('ENTITY_SEARCH_DISABLED');
  const wrong = request(f, { ...body, contextGraphId: 'other' }); await handleEntityRoutes(wrong.ctx);
  expect(wrong.res.statusCode).toBe(404);
  const method = request(f, body); method.ctx.req.method = 'GET'; await handleEntityRoutes(method.ctx); expect(method.res.statusCode).toBe(405);
  const invalid = request(f, { ...body, timeoutMs: 6000 }); await handleEntityRoutes(invalid.ctx); expect(invalid.res.statusCode).toBe(400);
  f.embedder.embed.mockImplementationOnce(async () => { const end = performance.now() + 10; while (performance.now() < end) {} return [1, 0]; });
  const late = request(f, { ...body, timeoutMs: 1 }); await handleEntityRoutes(late.ctx);
  expect(JSON.parse(late.res.body).code).toBe('QUERY_DEADLINE_EXCEEDED');
});


it('replaces a full index without pruning its completed generation before the rescan succeeds', async () => {
  const f = await fixture(9, 9);
  await f.index(); await f.index();
  const id = indexKey(parseSpec(spec), f.embedder.fingerprint);
  const removed = { entityUri: 'urn:entity:0', sourceGraph: partition };
  await f.graph.delete([{ graph: partition, subject: removed.entityUri, predicate: 'urn:description', object: '"ocean science"' }]);
  await f.graph.insert([
    { graph: partition, subject: 'urn:new', predicate: 'urn:description', object: '"new ocean"' },
    { graph: partition, subject: 'urn:new', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:Topic' },
  ]);
  expect(await f.index(true)).toMatchObject({ scanComplete: false });
  expect(f.store.cached(id, JSON.stringify([partition, removed.entityUri]))).toBeDefined();
  // Repeated interrupted restarts reuse one bounded scratch generation.
  await f.index(true);
  expect(await f.index()).toMatchObject({ scanComplete: true, indexedEntities: 9 });
  expect(f.store.cached(id, JSON.stringify([partition, removed.entityUri]))).toBeUndefined();
  expect((await f.search()).entities.some(e => e.entityUri === 'urn:new')).toBe(true);
});

it('skips an oversized changed candidate while preserving valid hits and real read failures', async () => {
  const f = await fixture(); await f.index();
  await f.graph.insert([{ graph: partition, subject: 'urn:entity:0', predicate: 'urn:description', object: JSON.stringify('x'.repeat(17_000)) }]);
  const result = await f.search();
  expect(result).toMatchObject({ staleCandidates: 1 });
  expect(result.entities).toHaveLength(2);
  expect(result.entities.every(e => e.entityUri !== 'urn:entity:0')).toBe(true);
  const failure = Object.assign(new Error('store offline'), { code: 'STORE_UNAVAILABLE' });
  vi.spyOn(f.reader, 'document').mockRejectedValueOnce(failure);
  await expect(f.search()).rejects.toBe(failure);
  f.deny(); await expect(f.search()).rejects.toMatchObject({ code: 'QUERY_ACCESS_DENIED' });
});

it('uses the authenticated agent for search revalidation and readiness authorization', async () => {
  const f = await fixture(); const indexed = await f.index();
  f.restrictTo('allowed-agent');
  const body = { contextGraphId: 'catalog', indexId: indexed.indexId, query: 'ocean' };
  f.agent.query.mockClear(); f.embedder.embed.mockClear();
  const allowed = request(f, body, 'agent'); await handleEntityRoutes(allowed.ctx);
  expect(allowed.res.statusCode).toBe(200);
  expect(f.agent.query.mock.calls.length).toBeGreaterThan(1);
  expect(f.agent.query.mock.calls.every(([, o]) => o.callerAgentAddress === 'allowed-agent')).toBe(true);
  const ready = request(f, { ...body, warmup: true }, 'agent', '/api/entities/readiness');
  await handleEntityRoutes(ready.ctx); expect(JSON.parse(ready.res.body).ready).toBe(true);
  f.agent.query.mockClear(); f.embedder.embed.mockClear(); f.embedder.ready.mockClear();
  for (const path of ['/api/entities/search', '/api/entities/readiness']) {
    const denied = request(f, { ...body, warmup: true }, 'agent', path, 'outsider-agent');
    await handleEntityRoutes(denied.ctx);
    expect(denied.res.statusCode).toBe(403);
    expect(JSON.parse(denied.res.body)).not.toHaveProperty('entities');
  }
  expect(f.agent.query.mock.calls).toHaveLength(2);
  expect(f.agent.query.mock.calls.every(([q, o]) => q.endsWith('LIMIT 0') && o.callerAgentAddress === 'outsider-agent')).toBe(true);
  expect(f.embedder.embed).not.toHaveBeenCalled(); expect(f.embedder.ready).not.toHaveBeenCalled();
});

it('reports a pinned resident provider model ready and bounds streamed and declared bodies', async () => {
  const config = { provider: 'ollama' as const, model: 'test', digest: 'a'.repeat(64), dimensions: 2 };
  const provider = new LocalEntityEmbedder(config);
  const models = { models: [{ name: 'test:latest', digest: config.digest }] };
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(models)).mockResolvedValueOnce(Response.json(models));
  vi.stubGlobal('fetch', fetch);
  expect(await provider.ready(AbortSignal.timeout(1000))).toBe(true);
  for (const headers of [{ 'Content-Length': String(1024 * 1024 + 1) }, {}]) {
    fetch.mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1), { headers }));
    await expect(provider.ready(AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'ENTITY_EMBEDDING_INVALID' });
  }
});


it('skips a 300 KiB stale HTTP document and preserves document-size errors during indexing', async () => {
  const f = await fixture(3, 100_000, true); await f.index();
  // Model data supplied by an external writer; DKG's own insert guard already
  // refuses literals this large. Reads must still handle existing HTTP data.
  f.endpoint!.store.update(`INSERT DATA { GRAPH <${partition}> {
    <urn:entity:0> <urn:description> ${JSON.stringify('x'.repeat(300 * 1024))} } }`);
  const result = await f.search();
  expect(result.staleCandidates).toBe(1);
  expect(result.entities.map(e => e.entityUri)).toEqual(['urn:entity:1', 'urn:entity:2']);
  await expect(f.index(true)).rejects.toMatchObject({ code: 'ENTITY_DOCUMENT_TOO_LARGE', status: 422 });
  f.deny(); await expect(f.search()).rejects.toMatchObject({ code: 'QUERY_ACCESS_DENIED' });
});

it('sends distinct query/document prefixes without silent truncation', async () => {
  const config = { provider: 'ollama' as const, model: 'test', digest: 'a'.repeat(64), dimensions: 2,
    queryPrefix: 'query: ', documentPrefix: 'document: ' };
  const provider = new LocalEntityEmbedder(config);
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith('/api/tags')
    ? Response.json({ models: [{ name: 'test:latest', digest: config.digest }] })
    : Response.json({ embeddings: [[1, 1]] }));
  vi.stubGlobal('fetch', fetch);
  await provider.embed('ocean', 'query', AbortSignal.timeout(1000));
  await provider.embed('ocean', 'document', AbortSignal.timeout(1000));
  const posted = fetch.mock.calls.filter(([url]) => url.endsWith('/api/embed'));
  expect(posted).toHaveLength(2);
  expect(posted.map(([, init]) => JSON.parse(init!.body as string))).toEqual([
    { model: `sha256:${config.digest}`, input: 'query: ocean', truncate: false, keep_alive: '5m' },
    { model: `sha256:${config.digest}`, input: 'document: ocean', truncate: false, keep_alive: '5m' },
  ]);
});

it('ranks by cosine rather than vector magnitude through SQLite', async () => {
  const f = await fixture(2);
  f.embedder.embed.mockImplementation(async text => text.includes('ocean') ? [1, 1] : [100, 0]);
  await f.index();
  const result = await f.search('ocean');
  expect(result.entities.map(e => e.entityUri)).toEqual(['urn:entity:0', 'urn:entity:1']);
  expect(result.entities[0].score).toBeCloseTo(1, 10);
  expect(result.entities[1].score).toBeCloseTo(Math.SQRT1_2, 10);
});

it('migrates legacy counters while preserving completed and interrupted scan data', async () => {
  const f = await fixture(10); await f.index(); await f.index(); await f.index(true);
  const id = indexKey(parseSpec(spec), f.embedder.fingerprint);
  const db = new Database(join(f.dir, 'entity-index.db'));
  try {
    db.pragma('user_version = 0');
    for (const table of ['entity_documents', 'entity_scan_documents']) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN generation INTEGER NOT NULL DEFAULT 7`);
    }
    const row = db.prepare('SELECT state FROM entity_indexes WHERE id = ?').get(id) as { state: string };
    const state = { ...JSON.parse(row.state), generation: 7 };
    db.prepare('UPDATE entity_indexes SET state = ? WHERE id = ?').run(JSON.stringify(state), id);
  } finally { db.close(); }
  const migrated = new EntityIndexStore(f.dir); cleanup.push(() => migrated.close());
  expect(migrated.state(id)).not.toHaveProperty('generation');
  expect(migrated.count(id)).toBe(10);
  const service = new EntitySearchService(migrated, f.embedder);
  expect(await service.index(parseIndexRequest(spec), f.reader, AbortSignal.timeout(5000), performance.now() + 5000))
    .toMatchObject({ scanComplete: true, indexedEntities: 10 });
});


it('rejects an externalized document before loading its oversized literal', async () => {
  const f = await fixture(0, 100_000, false, true);
  const sourceGraph = 'did:dkg:context-graph:catalog/_shared_memory';
  await f.graph.insert([
    { graph: sourceGraph, subject: 'urn:oversized', predicate: 'urn:description', object: JSON.stringify('x'.repeat(1024 * 1024)) },
    { graph: sourceGraph, subject: 'urn:oversized', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:Topic' },
  ]);
  const reads = vi.spyOn(f.graph as unknown as { readBlob(hash: string, constraints: { maxBytes?: number }): Promise<string> }, 'readBlob');
  await expect(f.reader.document({ ...spec, view: 'shared-working-memory' },
    { sourceGraph, entityUri: 'urn:oversized' }, AbortSignal.timeout(5000), performance.now() + 5000))
    .rejects.toMatchObject({ code: 'ENTITY_DOCUMENT_TOO_LARGE' });
  expect(reads).toHaveBeenCalledOnce();
  expect(reads.mock.calls[0]![1].maxBytes).toBeLessThanOrEqual(16_384);
  expect(reads.mock.calls[0]![1].maxBytes).toBeGreaterThan(0);
  expect(f.embedder.embed).not.toHaveBeenCalled();
});

it.each(['finish', 'count'] as const)('rejects a deadline crossed during final index %s and preserves committed work', async stage => {
  const f = await fixture(1);
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const original = f.store[stage].bind(f.store);
  vi.spyOn(f.store, stage).mockImplementation((...args: never[]) => {
    const value = (original as (...a: never[]) => unknown)(...args);
    now = 1100; return value as never;
  });
  await expect(f.service.index(parseIndexRequest(spec), f.reader, new AbortController().signal, 1050))
    .rejects.toMatchObject({ code: 'QUERY_DEADLINE_EXCEEDED' });
  const id = indexKey(parseSpec(spec), f.embedder.fingerprint);
  expect(f.store.state(id)?.scanComplete).toBe(true);
  expect(f.store.count(id)).toBe(1);
});

it('checks the monotonic deadline at the HTTP success boundary', async () => {
  const f = await fixture(1);
  const indexed = await f.index();
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(f.service, 'index').mockImplementation(async () => { now = 4000; return indexed; });
  const r = request(f, { ...spec, timeoutMs: 1000 }, 'nodeOperator', '/api/entities/index');
  await handleEntityRoutes(r.ctx);
  expect(r.res.statusCode).toBe(503);
  expect(JSON.parse(r.res.body).code).toBe('QUERY_DEADLINE_EXCEEDED');
});

it('revalidates graph membership after registration removal while retaining RDF and cached vectors', async () => {
  const f = await fixture(1);
  const root = 'did:dkg:context-graph:catalog', child = `${root}/named`;
  const sourceGraph = `${child}/_verifiable_memory/a`;
  const registration = [
    { graph: `${root}/_meta`, subject: child, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph' },
    { graph: `${root}/_meta`, subject: child, predicate: 'http://dkg.io/ontology/parentContextGraph', object: root },
    { graph: `${root}/_meta`, subject: child, predicate: 'http://schema.org/name', object: '"named"' },
  ];
  await f.graph.insert([...registration,
    { graph: sourceGraph, subject: 'urn:removed', predicate: 'urn:description', object: '"ocean removed"' },
    { graph: sourceGraph, subject: 'urn:removed', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:Topic' },
  ]);
  const indexed = await f.index();
  expect((await f.search()).entities.map(e => e.entityUri)).toContain('urn:removed');
  await f.graph.delete(registration);
  expect(await f.graph.hasGraph(sourceGraph)).toBe(true);
  expect(f.store.count(indexed.indexId)).toBe(2);
  expect(await f.search()).toMatchObject({ staleCandidates: 1, entities: [{ entityUri: 'urn:entity:0' }] });
  expect(f.store.count(indexed.indexId)).toBe(2);
});

it('indexes and revalidates allowed 256-row documents through HTTP serialization overhead', async () => {
  const f = await fixture(0, 100_000, true);
  const literals = Array.from({ length: 256 }, (_, i) => `v${String(i).padStart(3, '0')}${'x'.repeat(36)}`);
  await f.graph.insert([
    ...literals.map(value => ({ graph: partition, subject: 'urn:boundary', predicate: 'urn:description', object: JSON.stringify(value) })),
    { graph: partition, subject: 'urn:boundary', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:Topic' },
  ]);
  expect(Buffer.byteLength(literals.map(value => `urn:description: ${JSON.stringify(value)}`).join('\n'))).toBe(15_359);
  const response = await fetch(f.endpoint!.queryEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' },
    body: `SELECT ?p ?value WHERE { GRAPH <${partition}> { <urn:boundary> ?p ?value FILTER(isLiteral(?value)) } }`,
  });
  expect(response.ok).toBe(true);
  expect(Buffer.byteLength(await response.text())).toBeGreaterThan(16_384);
  expect(await f.index()).toMatchObject({ scanComplete: true, indexedEntities: 1 });
  expect(await f.search()).toMatchObject({ staleCandidates: 0, entities: [{ entityUri: 'urn:boundary' }] });
});

it('materializes only ranked winners and keeps deterministic cosine tie order', async () => {
  const f = await fixture(3); await f.index();
  const id = indexKey(parseSpec(spec), f.embedder.fingerprint);
  const parse = vi.spyOn(JSON, 'parse');
  const result = f.store.rank(id, [1, 0], 1, AbortSignal.timeout(1000), performance.now() + 1000);
  expect(result.map(row => row.document.entityUri)).toEqual(['urn:entity:0']);
  expect(parse.mock.calls.filter(([value]) => String(value).includes('contentHash'))).toHaveLength(1);
  parse.mockRestore();
  expect(f.store.rank(id, [0, 1], 2, AbortSignal.timeout(1000), performance.now() + 1000)
    .map(row => row.document.entityUri)).toEqual(['urn:entity:1', 'urn:entity:2']);
});

it.each(['index', 'search'] as const)('keeps the document hydration bound out of subgraph metadata during %s', async mode => {
  const f = await fixture(1, 100_000, false, true);
  if (mode === 'search') await f.index();
  const meta = 'did:dkg:context-graph:catalog/_meta';
  const names = Array.from({ length: 300 }, (_, i) => 's' + String(i).padStart(3, '0') + 'x'.repeat(60));
  expect(names.reduce((n, name) => n + Buffer.byteLength(JSON.stringify(name)), 0)).toBe(19_800);
  await f.graph.insert(names.flatMap(name => [
    { graph: meta, subject: 'urn:sub:' + name, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph' },
    { graph: meta, subject: 'urn:sub:' + name, predicate: 'http://schema.org/name', object: JSON.stringify(name) },
  ]));
  if (mode === 'index') expect(await f.index()).toMatchObject({ indexedEntities: 1, scanComplete: true });
  else expect(await f.search()).toMatchObject({ staleCandidates: 0, entities: [{ entityUri: 'urn:entity:0' }] });
});

it('does not classify an internal metadata overflow as an oversized entity document', async () => {
  const f = await fixture(1);
  f.agent.query.mockResolvedValueOnce({ bindings: [{ chars: '10' }] });
  f.agent.query.mockRejectedValueOnce(new StoreResponseTooLargeError(8 * 1024 * 1024, 8 * 1024 * 1024 + 1));
  await expect(f.reader.document(spec, { sourceGraph: partition, entityUri: 'urn:entity:0' },
    AbortSignal.timeout(5000), performance.now() + 5000)).rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE' });
});

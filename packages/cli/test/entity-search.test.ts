import { withPublicSnapshotQueryTrust } from "../../agent/src/public-snapshot-evidence.js";
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { startOxigraphSparqlEndpoint } from '../../storage/test/helpers/oxigraph-sparql-endpoint.js';
import { OxigraphStore, SparqlHttpStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../../query/src/dkg-query-engine.js';
import { EntityGraphReader, indexKey, parseSpec } from '../src/entity-search/documents.js';
import { EntityIndexStore } from '../src/entity-search/store.js';
import { EntitySearchService } from '../src/entity-search/service.js';
import { LocalEntityEmbedder } from '../src/entity-search/embedding.js';
import { handleEntityRoutes } from '../src/daemon/routes/entities.js';
import { requestAuthentication } from './_helpers/request-authentication.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

const spec = { contextGraphId: 'catalog', view: 'verifiable-memory' as const,
  textPredicates: ['urn:description'], types: ['urn:Topic'] };
const partition = 'did:dkg:context-graph:catalog/_verifiable_memory/a';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture(count = 3, capacity = 100_000, http = false) {
  const dir = mkdtempSync(join(tmpdir(), 'entity-search-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const endpoint = http ? await startOxigraphSparqlEndpoint() : undefined;
  if (endpoint) cleanup.push(() => endpoint.close());
  const graph = endpoint ? new SparqlHttpStore({ queryEndpoint: endpoint.queryEndpoint, updateEndpoint: endpoint.updateEndpoint }) : new OxigraphStore();
  cleanup.push(() => graph.close());
  const engine = new DKGQueryEngine(graph);
  let permitted = true;
  let allowedCaller: string | undefined;
  const agent = { query: vi.fn(async (sparql, options) => {
    if (!permitted || (allowedCaller !== undefined && options?.callerAgentAddress !== allowedCaller)) throw Object.assign(new Error('denied'), { code: 'QUERY_ACCESS_DENIED' });
    return withPublicSnapshotQueryTrust(graph, options.contextGraphId, options.chainEvidenceMode, () => engine.query(sparql, options));
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
  const index = (restart = false) => service.index(spec, reader, restart, AbortSignal.timeout(5000), performance.now() + 5000);
  const search = (query = 'ocean') => service.search(indexKey(parseSpec(spec), embedder.fingerprint), spec.contextGraphId, query, 2,
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
    await expect(f.service.search(id, 'catalog', 'ocean', 2, f.reader, AbortSignal.timeout(1000), performance.now() + 1000))
      .rejects.toMatchObject({ code: 'ENTITY_EMBEDDING_MODEL_CHANGED' });
    f.embedder.fingerprint = 'test-model-v1'; f.embedder.embed.mockResolvedValue([NaN, 1]);
    await expect(f.search()).rejects.toMatchObject({ code: 'ENTITY_EMBEDDING_INVALID' });
    await expect(f.service.search(id, 'catalog', 'ocean', 2, f.reader, new AbortController().signal, performance.now() - 1))
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
it('local inference pins the model digest and dimensions and refuses remote inference URLs', async () => {
  const config = { provider: 'ollama' as const, model: 'test', digest: 'a'.repeat(64), dimensions: 2 };
  expect(() => new LocalEntityEmbedder({ ...config, baseURL: 'http://example.org' })).toThrow('ENTITY_EMBEDDING_CONFIG_INVALID');
  const provider = new LocalEntityEmbedder(config);
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ models: [{ name: 'test:latest', digest: config.digest }] }))
    .mockResolvedValueOnce(Response.json({ embeddings: [[1, 0]] }))
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
  const preparing = f.service.readiness(indexed.indexId, 'catalog', true, f.reader, AbortSignal.timeout(5000), performance.now() + 5000);
  await expect(f.search()).rejects.toMatchObject({ code: 'ENTITY_SEARCH_BUSY' });
  await expect(f.index()).rejects.toMatchObject({ code: 'ENTITY_INDEX_BUSY' });
  release([1, 0]); expect((await preparing).ready).toBe(true);
  await expect(f.service.readiness(indexed.indexId, 'catalog', false, f.reader, new AbortController().signal, performance.now() - 1))
    .rejects.toMatchObject({ code: 'QUERY_DEADLINE_EXCEEDED' });
  expect((await f.search()).entities).toHaveLength(2);
  const provider = new LocalEntityEmbedder({ provider: 'ollama', model: 'test', digest: 'a'.repeat(64), dimensions: 2 });
  const tags = () => Response.json({ models: [{ name: 'test:latest', digest: 'a'.repeat(64) }] });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(tags()).mockResolvedValueOnce(Response.json({ models: [] }))
    .mockResolvedValueOnce(tags()).mockResolvedValueOnce(Response.json({ models: [{ name: 'test:latest', digest: 'b'.repeat(64) }] })));
  expect(await provider.ready(AbortSignal.timeout(1000))).toBe(false);
  expect(await provider.ready(AbortSignal.timeout(1000))).toBe(false);
});

it('persists a partial scan across service recreation and keeps SWM and VM indexes separate', async () => {
  const f = await fixture(9); await f.index();
  const resumedStore = new EntityIndexStore(f.dir); cleanup.push(() => resumedStore.close());
  const resumed = new EntitySearchService(resumedStore, f.embedder);
  expect(await resumed.index(spec, f.reader, false, AbortSignal.timeout(5000), performance.now() + 5000))
    .toMatchObject({ indexedEntities: 9, scanComplete: true });
  await f.graph.insert([
    { graph: 'did:dkg:context-graph:catalog/_shared_memory', subject: 'urn:shared', predicate: 'urn:description', object: '"ocean"' },
    { graph: 'did:dkg:context-graph:catalog/_shared_memory', subject: 'urn:shared', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:Topic' },
  ]);
  const swm = await resumed.index({ ...spec, view: 'shared-working-memory' }, f.reader, false, AbortSignal.timeout(5000), performance.now() + 5000);
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
    { model: 'test:latest', input: 'query: ocean', truncate: false, keep_alive: '5m' },
    { model: 'test:latest', input: 'document: ocean', truncate: false, keep_alive: '5m' },
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
    for (const table of ['entity_documents', 'entity_scan_documents']) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN generation INTEGER NOT NULL DEFAULT 7`);
    }
    const state = { ...f.store.state(id), generation: 7 };
    db.prepare('UPDATE entity_indexes SET state = ? WHERE id = ?').run(JSON.stringify(state), id);
  } finally { db.close(); }
  const migrated = new EntityIndexStore(f.dir); cleanup.push(() => migrated.close());
  expect(migrated.state(id)).not.toHaveProperty('generation');
  expect(migrated.count(id)).toBe(10);
  const service = new EntitySearchService(migrated, f.embedder);
  expect(await service.index(spec, f.reader, false, AbortSignal.timeout(5000), performance.now() + 5000))
    .toMatchObject({ scanComplete: true, indexedEntities: 10 });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
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
async function fixture(count = 3) {
  const dir = mkdtempSync(join(tmpdir(), 'entity-search-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const graph = new OxigraphStore(); cleanup.push(() => graph.close());
  const engine = new DKGQueryEngine(graph);
  let permitted = true;
  const agent = { query: vi.fn(async (sparql, options) => {
    if (!permitted) throw Object.assign(new Error('denied'), { code: 'QUERY_ACCESS_DENIED' });
    return engine.query(sparql, options);
  }) };
  for (let i = 0; i < count; i++) await graph.insert([
    { graph: partition, subject: `urn:entity:${i}`, predicate: 'urn:description', object: JSON.stringify(i === 0 ? 'ocean science' : 'mountain climbing') },
    { graph: partition, subject: `urn:entity:${i}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:Topic' },
  ]);
  await graph.insert([{ graph: 'did:dkg:context-graph:other/_verifiable_memory/a', subject: 'urn:secret', predicate: 'urn:description', object: '"ocean science"' },
    { graph: 'did:dkg:context-graph:other/_verifiable_memory/a', subject: 'urn:secret', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:Topic' }]);
  const embedder = { fingerprint: 'test-model-v1', dimensions: 2, embed: vi.fn(async (text: string) => text.includes('ocean') ? [1, 0] : [0, 1]) };
  const store = new EntityIndexStore(dir); cleanup.push(() => store.close());
  const service = new EntitySearchService(store, embedder), reader = new EntityGraphReader(agent as never, 'reader');
  const index = (restart = false) => service.index(spec, reader, restart, AbortSignal.timeout(5000), performance.now() + 5000);
  const search = (query = 'ocean') => service.search(indexKey(parseSpec(spec), embedder.fingerprint), spec.contextGraphId, query, 2,
    reader, AbortSignal.timeout(5000), performance.now() + 5000);
  return { dir, graph, agent, embedder, store, service, reader, index, search, deny: () => { permitted = false; } };
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

function request(f, body, kind: 'anonymous' | 'nodeOperator' = 'anonymous', path = '/api/entities/search') {
  const req = Object.assign(new EventEmitter(), { method: 'POST', aborted: false, __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)) });
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, statusCode: 0, body: '',
    writeHead(status: number) { this.statusCode = status; return this; }, end(body: string) { this.body = body; this.writableEnded = true; } });
  return { res, ctx: { req, res, path, agent: f.agent, entitySearch: f.service, authentication: requestAuthentication({ kind }) } as unknown as RequestContext };
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

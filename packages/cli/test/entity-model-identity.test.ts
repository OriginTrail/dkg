import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../../query/src/dkg-query-engine.js';
import { EntityGraphReader } from '../src/entity-search/documents.js';
import { indexKey } from '../src/entity-search/identity.js';
import { parseSpec } from '../src/entity-search/requests.js';
import { EntityIndexStore } from '../src/entity-search/store.js';
import { EntitySearchService } from '../src/entity-search/service.js';
import { LocalEntityEmbedder } from '../src/entity-search/embedding.js';
import { parseIndexRequest, parseSearchRequest } from '../src/entity-search/requests.js';

const digest = 'a'.repeat(64), otherDigest = 'b'.repeat(64);
const config = { provider: 'ollama' as const, model: 'test', digest, dimensions: 2 };
const spec = { contextGraphId: 'catalog', view: 'verifiable-memory' as const, textPredicates: ['urn:text'] };
const cleanup: Array<() => unknown> = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const stop of cleanup.splice(0).reverse()) await stop(); });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'entity-model-identity-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const graph = new OxigraphStore(); cleanup.push(() => graph.close());
  await graph.insert([{ graph: 'did:dkg:context-graph:catalog/_verifiable_memory/a',
    subject: 'urn:entity', predicate: 'urn:text', object: '"ocean science"' }]);
  const engine = new DKGQueryEngine(graph);
  const reader = new EntityGraphReader({ query: (query, options) => engine.query(query, options) });
  const store = new EntityIndexStore(dir); cleanup.push(() => store.close());
  const provider = new LocalEntityEmbedder(config), service = new EntitySearchService(store, provider);
  const id = indexKey(parseSpec(spec), provider.fingerprint);
  const index = () => service.index(parseIndexRequest(spec), reader, AbortSignal.timeout(2000), performance.now() + 2000);
  const search = () => service.search(parseSearchRequest({ contextGraphId: 'catalog', indexId: id, query: 'ocean', limit: 1 }),
    reader, AbortSignal.timeout(2000), performance.now() + 2000);
  return { store, id, index, search };
}

it.each(['index', 'search'] as const)('rejects a tag replacement during %s before storing or ranking vectors', async operation => {
  let replace = false, currentDigest = digest;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'test:latest', digest: currentDigest }] });
    if (replace) currentDigest = otherDigest;
    return Response.json({ embeddings: [[1, 0]] });
  }));
  const f = await fixture();
  if (operation === 'search') await f.index();
  const upsert = vi.spyOn(f.store, 'upsert'), rank = vi.spyOn(f.store, 'rank');
  replace = true;
  await expect(f[operation]()).rejects.toMatchObject({ code: 'ENTITY_EMBEDDING_MODEL_CHANGED' });
  expect(upsert).not.toHaveBeenCalled(); expect(rank).not.toHaveBeenCalled();
  expect(f.store.count(f.id)).toBe(operation === 'search' ? 1 : 0);
  if (operation === 'index') expect(f.store.state(f.id)?.cursor).toBeNull();
});

it.each(['index', 'search'] as const)('binds %s inference to the digest even when the tag changes and changes back', async operation => {
  let replace = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'test:latest', digest }] });
    // Inventory is A before and after inference, but the mutable tag resolves to
    // same-dimension B during inference. An immutable reference still selects A.
    const model = JSON.parse(init!.body as string).model;
    return Response.json({ embeddings: [replace && model === 'test:latest' ? [0, 1] : [1, 0]] });
  });
  vi.stubGlobal('fetch', fetch);
  const f = await fixture();
  if (operation === 'search') await f.index();
  replace = true;
  if (operation === 'index') {
    const upsert = vi.spyOn(f.store, 'upsert'); await f.index();
    expect(upsert.mock.calls[0][1].vector).toEqual([1, 0]);
  } else expect((await f.search()).entities[0].score).toBe(1);
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/api/embed'))
    .every(([, init]) => JSON.parse(init!.body as string).model === `sha256:${digest}`)).toBe(true);
});

it('does not fall back to a mutable tag when the provider cannot resolve the digest', async () => {
  const fetch = vi.fn(async (url: string) => url.endsWith('/api/tags')
    ? Response.json({ models: [{ name: 'test:latest', digest }] })
    : Response.json({ error: 'model not found' }, { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  const f = await fixture();
  await expect(f.index()).rejects.toMatchObject({ code: 'ENTITY_EMBEDDING_UNAVAILABLE' });
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/api/embed'))).toHaveLength(1);
  expect(f.store.count(f.id)).toBe(0);
});

it('recognizes a resident pinned digest regardless of its display name', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json({ models: [{
    name: url.endsWith('/api/tags') ? 'test:latest' : `sha256-${digest}:latest`, digest,
  }] })));
  expect(await new LocalEntityEmbedder(config).ready(AbortSignal.timeout(2000))).toBe(true);
});

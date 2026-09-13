import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { OxigraphStore, type QueryResult, type TripleStore } from '@origintrail-official/dkg-storage';
import { listStoredContextGraphQueryCandidates } from '../src/context-graph-query-candidates.js';

const PREFIX = 'did:dkg:context-graph:';
const WALLET = '0x0000000000000000000000000000000000000001';
const AUTHOR = '0x0000000000000000000000000000000000000002';

function indexedStore(graphs: string[]) {
  const query = vi.fn<TripleStore['query']>(async () => ({ type: 'bindings', bindings: [] }));
  const listGraphsByPrefix = vi.fn(async () => graphs);
  const listGraphs = vi.fn(async () => graphs);
  const store = { query, listGraphsByPrefix, listGraphs } as unknown as TripleStore;
  return { store, query, listGraphsByPrefix, listGraphs };
}

describe('stored context graph candidates for query admission', () => {
  let realStore: OxigraphStore | undefined;

  afterEach(async () => {
    await realStore?.close();
    realStore = undefined;
  });

  it('retains bare legacy and arbitrary slash-bearing roots from the graph index', async () => {
    const { store, listGraphsByPrefix, listGraphs } = indexedStore([
      `${PREFIX}legacy`,
      `${PREFIX}team/repo/private`,
      `${PREFIX}a/context/7`,
      'urn:unrelated:graph',
    ]);
    const result = await listStoredContextGraphQueryCandidates(store);
    expect(result).toEqual(expect.arrayContaining(['legacy', 'team/repo/private', 'a/context/7', 'a']));
    expect(result).not.toContain('urn:unrelated:graph');
    expect(listGraphsByPrefix).toHaveBeenCalledWith(PREFIX, { source: 'agent.query.rfc64RuntimePrivateGraphs' });
    expect(listGraphs).not.toHaveBeenCalled();
  });

  it.each(['context/7', 'context/7/_meta', '_private'])('recovers a complete slash-bearing root from /%s', async (suffix) => {
    const id = 'team/repo/private';
    const { store } = indexedStore([`${PREFIX}${id}/${suffix}`]);
    expect(await listStoredContextGraphQueryCandidates(store)).toContain(id);
  });

  it.each([
    '_private',
    '_working_memory',
    `_working_memory/${AUTHOR}/1`,
    '_shared_memory',
    '_shared_memory_meta',
    `_shared_memory/${AUTHOR}/1`,
    '_verifiable_memory',
    '_verifiable_memory_meta',
    `_verifiable_memory/${AUTHOR}/1`,
    `_verifiable_memory/${AUTHOR}/1/_meta`,
  ])('retains both possible legacy owners of /%s', async (suffix) => {
    const { store } = indexedStore([`${PREFIX}team/repo/private/${suffix}`]);
    const result = await listStoredContextGraphQueryCandidates(store);
    expect(result).toEqual(expect.arrayContaining(['team/repo/private', 'team/repo']));
    expect(result).not.toContain('team');
    expect(result).not.toContain(`team/repo/private/${suffix}`);
  });

  it('does not let a known public ancestor suppress a nested memory owner candidate', async () => {
    const { store } = indexedStore([
      `${PREFIX}public`,
      `${PREFIX}public/private/_verifiable_memory/${AUTHOR}/1`,
    ]);
    expect(await listStoredContextGraphQueryCandidates(store))
      .toEqual(expect.arrayContaining(['public', 'public/private']));
  });

  it('retains both possible owners of a bare named subgraph data graph', async () => {
    const { store } = indexedStore([`${PREFIX}public/tasks`]);
    expect(await listStoredContextGraphQueryCandidates(store))
      .toEqual(expect.arrayContaining(['public/tasks', 'public']));
  });

  it('retains a bare wallet parent as a possible owner of wallet-scoped memory', async () => {
    const { store } = indexedStore([`${PREFIX}${WALLET}/project/_shared_memory/${AUTHOR}/1`]);
    expect(await listStoredContextGraphQueryCandidates(store))
      .toEqual(expect.arrayContaining([`${WALLET}/project`, WALLET]));
  });

  it('recovers both owners of a legacy name-keyed working-memory graph', async () => {
    const { store } = indexedStore([`${PREFIX}team/private/tasks/assertion/${AUTHOR}/legacy`]);
    expect(await listStoredContextGraphQueryCandidates(store))
      .toEqual(expect.arrayContaining(['team/private/tasks', 'team/private']));
  });

  it.each(['_rules', '_sync/applied-cg'])('recovers the owner of the reserved /%s graph', async (suffix) => {
    const { store } = indexedStore([`${PREFIX}team/repo/private/${suffix}`]);
    expect(await listStoredContextGraphQueryCandidates(store)).toContain('team/repo/private');
  });

  it.each([
    `v1/root/team%2Frepo%2Fprivate/_shared_memory/${AUTHOR}/1`,
    `v1/root/team%2Frepo%2Fprivate/_meta`,
    `v1/subgraph/team%2Frepo%2Fprivate/reports/_shared_memory/${AUTHOR}/1`,
  ])('decodes the exact owner of RFC-64 scope %s', async (scope) => {
    const { store } = indexedStore([`${PREFIX}${scope}`]);
    expect(await listStoredContextGraphQueryCandidates(store)).toEqual(['team/repo/private']);
  });

  it('keeps a valid raw root that collides with an unescaped RFC-64 memory scope', async () => {
    const { store } = indexedStore([`${PREFIX}v1/root/private/_verifiable_memory/${AUTHOR}/1`]);
    expect(await listStoredContextGraphQueryCandidates(store))
      .toEqual(expect.arrayContaining(['private', 'v1/root/private']));
  });

  it('keeps an own-meta declaration whose raw root collides with an RFC-64 scope', async () => {
    realStore = new OxigraphStore();
    await realStore.insert([{
      subject: `${PREFIX}v1/root/private`,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${WALLET}"`,
      graph: `${PREFIX}v1/root/private/_meta`,
    }]);
    expect(await listStoredContextGraphQueryCandidates(realStore))
      .toEqual(expect.arrayContaining(['private', 'v1/root/private']));
  });

  it('rejects malformed percent encoding instead of dropping an RFC-64 owner', async () => {
    const { store } = indexedStore([`${PREFIX}v1/root/private%ZZ/_shared_memory/${AUTHOR}/1`]);
    await expect(listStoredContextGraphQueryCandidates(store)).rejects.toThrow();
  });

  it('retains own metadata for legacy roots that predate reserved storage segments', async () => {
    realStore = new OxigraphStore();
    const id = 'team/_old/private';
    await realStore.insert([{
      subject: `${PREFIX}${id}`,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${WALLET}"`,
      graph: `${PREFIX}${id}/_meta`,
    }]);
    expect(await listStoredContextGraphQueryCandidates(realStore)).toContain(id);
  });

  it('qualifies namespaced metadata against its own subject and keeps public subgraph bookkeeping separate', async () => {
    realStore = new OxigraphStore();
    const privateId = 'team/repo/private';
    const catalogId = `${WALLET}/catalog-only`;
    await realStore.insert([
      {
        subject: `${PREFIX}${privateId}`,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${WALLET}"`,
        graph: `${PREFIX}${privateId}/_meta`,
      },
      {
        subject: `${PREFIX}${catalogId}`,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH,
        graph: `${PREFIX}${catalogId}/_catalog`,
      },
      {
        subject: 'urn:public:marker',
        predicate: 'urn:public:property',
        object: '"visible"',
        graph: `${PREFIX}public`,
      },
      {
        subject: 'urn:public:task:1',
        predicate: 'urn:public:task:state',
        object: '"complete"',
        graph: `${PREFIX}public/tasks/_meta`,
      },
      {
        subject: `${PREFIX}unrelated/private`,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"private"',
        graph: `${PREFIX}public/other/_meta`,
      },
    ]);
    const query = vi.spyOn(realStore, 'query');
    const result = await listStoredContextGraphQueryCandidates(realStore);
    expect(result).toEqual(expect.arrayContaining([privateId, catalogId, 'public']));
    expect(result).not.toContain('public/tasks');
    expect(result).not.toContain('public/other');
    expect(result).not.toContain('unrelated/private');
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/FILTER\s+EXISTS/i), {
      source: 'agent.query.storedContextGraphCandidates',
    });
  });

  it('falls back to listGraphs when an adapter has no prefix index', async () => {
    const { store, listGraphs } = indexedStore([`${PREFIX}private/_shared_memory`, 'urn:unrelated:graph']);
    delete store.listGraphsByPrefix;
    expect(await listStoredContextGraphQueryCandidates(store)).toEqual(['private']);
    expect(listGraphs).toHaveBeenCalledWith({ source: 'agent.query.rfc64RuntimePrivateGraphs' });
  });

  it('bounds metadata discovery to four concurrent batches of at most 128 and preserves batch order', async () => {
    const ids = Array.from({ length: 641 }, (_, index) => `namespace/graph-${String(index).padStart(4, '0')}`);
    const { store, query } = indexedStore(ids.map((id) => `${PREFIX}${id}/_meta`));
    let active = 0;
    let peak = 0;
    let nextBatch = 0;
    query.mockImplementation(async (sparql, options) => {
      const batch = nextBatch++;
      const expected = ids.slice(batch * 128, (batch + 1) * 128);
      expect(options?.source).toBe('agent.query.storedContextGraphCandidates');
      expect(sparql).toMatch(/FILTER\s+EXISTS/i);
      for (const id of expected) expect(sparql).toContain(`<${PREFIX}${id}>`);
      const pairs = [...sparql.matchAll(/\(<[^>]+>\s+<[^>]+>\)/g)];
      expect(pairs).toHaveLength(expected.length);
      active += 1;
      peak = Math.max(peak, active);
      // The first batch deliberately finishes later than subsequent batches.
      await new Promise((resolve) => setTimeout(resolve, batch === 0 ? 20 : 2));
      active -= 1;
      return { type: 'bindings', bindings: expected.map((id) => ({ cg: `${PREFIX}${id}` })) };
    });
    expect(await listStoredContextGraphQueryCandidates(store)).toEqual(ids);
    expect(query).toHaveBeenCalledTimes(6);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(active).toBe(0);
  });

  it.each([
    { type: 'boolean', value: true },
    { type: 'quads', quads: [] },
  ] satisfies QueryResult[])('rejects malformed metadata SELECT response $type', async (response) => {
    const { store, query } = indexedStore([`${PREFIX}namespace/private/_meta`]);
    query.mockResolvedValue(response);
    await expect(listStoredContextGraphQueryCandidates(store)).rejects.toThrow();
  });

  it.each(['inventory', 'metadata'] as const)('propagates %s discovery failures instead of returning incomplete candidates', async (source) => {
    const { store, query, listGraphsByPrefix } = indexedStore([`${PREFIX}namespace/private/_meta`]);
    if (source === 'inventory') listGraphsByPrefix.mockRejectedValue(new Error('inventory unavailable'));
    else query.mockRejectedValue(new Error('metadata unavailable'));
    await expect(listStoredContextGraphQueryCandidates(store)).rejects.toThrow('unavailable');
  });
});

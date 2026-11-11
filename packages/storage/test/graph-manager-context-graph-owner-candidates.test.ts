import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES,
  GraphManager,
  OxigraphStore,
  STORE_GRAPH_CATALOG_LIMIT_NAME,
  STORE_GRAPH_CATALOG_MAX_BYTES_ENV,
  type TripleStore,
} from '../src/index.js';
import {
  workspaceKnowledgeAssetOperationSnapshotGraph,
  workspaceOperationPublicSnapshotGraph,
} from '@origintrail-official/dkg-core';

const PREFIX = 'did:dkg:context-graph:';
const CEILING = {
  maxResponseBytes: DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES,
  maxLiteralHydrationBytes: DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES,
};

const listStoredContextGraphQueryCandidates = (
  store: TripleStore,
  opts: { signal?: AbortSignal } = {},
) => new GraphManager(store).listStoredContextGraphOwnerCandidates(opts);

function indexedStore(graphs: string[]) {
  const query = vi.fn<TripleStore['query']>(async () => ({ type: 'bindings', bindings: [] }));
  const listGraphsByPrefix = vi.fn(async () => graphs);
  const listGraphs = vi.fn(async () => graphs);
  return {
    store: { query, listGraphsByPrefix, listGraphs } as unknown as TripleStore,
    query,
    listGraphsByPrefix,
    listGraphs,
  };
}

describe('stored context graph candidates for query admission', () => {
  let realStore: OxigraphStore | undefined;

  afterEach(async () => {
    await realStore?.close();
    realStore = undefined;
  });

  it('uses the graph index and deduplicates every canonical owner interpretation', async () => {
    const { store, listGraphsByPrefix, listGraphs, query } = indexedStore([
      `${PREFIX}tenant/_meta`,
      `${PREFIX}tenant/private/tasks/_shared_memory`,
      `${PREFIX}tenant/private/tasks/_shared_memory`,
      `${PREFIX}v1/root/team%2Fprivate/_meta`,
      'urn:unrelated:graph',
    ]);
    const ids = await listStoredContextGraphQueryCandidates(store);
    expect(ids).toEqual(expect.arrayContaining([
      'tenant', 'tenant/_meta', 'tenant/private', 'tenant/private/tasks', 'team/private',
    ]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('urn:unrelated:graph');
    // Admission reads a current catalog.
    expect(listGraphsByPrefix).toHaveBeenCalledWith(PREFIX, {
      source: 'storage.contextGraphOwnerCandidates', ...CEILING, currentCatalog: true,
    });
    expect(listGraphs).not.toHaveBeenCalled();
    // Admission cannot depend on metadata existence: ordinary read authority
    // resolves the policy after all possible stored owners have been collected.
    expect(query).not.toHaveBeenCalled();
  });

  it('discovers private legacy and metadata owners even without own-subject declarations', async () => {
    realStore = new OxigraphStore();
    await realStore.insert([
      { subject: 'urn:private:1', predicate: 'urn:type', object: '"marker"', graph: `${PREFIX}tenant/_meta` },
      { subject: 'urn:private:2', predicate: 'urn:type', object: '"marker"', graph: `${PREFIX}tenant/private/_meta` },
      { subject: 'urn:task:1', predicate: 'urn:type', object: '"marker"', graph: `${PREFIX}tenant/private/tasks/_meta` },
    ]);
    expect(await listStoredContextGraphQueryCandidates(realStore)).toEqual(expect.arrayContaining([
      'tenant/_meta', 'tenant/private', 'tenant/private/_meta', 'tenant/private/tasks',
    ]));
  });

  it('does not truncate inventory after 128 graphs', async () => {
    const ids = Array.from({ length: 129 }, (_, index) => `namespace/graph-${index}`);
    const { store } = indexedStore(ids.map((id) => `${PREFIX}${id}/_meta`));
    expect(await listStoredContextGraphQueryCandidates(store)).toEqual(expect.arrayContaining(ids));
  });

  it('supports the legacy listGraphs fallback without scanning unrelated graphs', async () => {
    const { store, listGraphs, query } = indexedStore([`${PREFIX}private/_shared_memory`, 'urn:unrelated:graph']);
    delete store.listGraphsByPrefix;
    const result = await listStoredContextGraphQueryCandidates(store);
    expect(result).toEqual(expect.arrayContaining(['private', 'private/_shared_memory']));
    expect(result).not.toContain('urn:unrelated:graph');
    // The complete list behind the fallback is node work under the internal catalog ceiling.
    expect(listGraphs).toHaveBeenCalledWith({ source: 'storage.contextGraphOwnerCandidates',
      maxResponseBytes: DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES, maxLiteralHydrationBytes: DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES });
    expect(query).not.toHaveBeenCalled();
  });

  it('propagates inventory failure instead of returning an incomplete candidate set', async () => {
    const { store, listGraphsByPrefix } = indexedStore([]);
    listGraphsByPrefix.mockRejectedValue(new Error('inventory unavailable'));
    await expect(listStoredContextGraphQueryCandidates(store)).rejects.toThrow('inventory unavailable');
  });

  it('retains legal legacy owners of undecodable tagged-looking names', async () => {
    const { store } = indexedStore([`${PREFIX}v1/root/reports%FF/_shared_memory`]);
    await expect(listStoredContextGraphQueryCandidates(store)).resolves.toContain('v1/root');
  });

  it('discovers RFC64 owners from both existing snapshot builders', async () => {
    const id = 'team/../repo';
    const { store } = indexedStore([
      workspaceKnowledgeAssetOperationSnapshotGraph(id, 'operation'),
      workspaceOperationPublicSnapshotGraph(id, 'operation', 'urn:entity:1'),
    ]);
    await expect(listStoredContextGraphQueryCandidates(store)).resolves.toContain(id);
  });

  it('rejects a stored CG IRI without any legal owner interpretation', async () => {
    const { store } = indexedStore([`${PREFIX}legacy%2Fprivate`]);
    await expect(listStoredContextGraphQueryCandidates(store)).rejects.toThrow('unrecognized stored Context Graph owner');
  });

  it('retains every owner when ordinary KA growth exceeds 512 candidates', async () => {
    const { store } = indexedStore(Array.from({ length: 1_000 }, (_, id) => (
      `${PREFIX}public/_verifiable_memory/author/${id}`
    )));
    const owners = await listStoredContextGraphQueryCandidates(store);
    expect(owners).toHaveLength(1_002);
    expect(owners).toContain('public');
    expect(owners).toContain('public/_verifiable_memory/author/999');
  });

  it('lets cancellation interrupt parsing a large local inventory', async () => {
    const controller = new AbortController();
    const { store } = indexedStore(Array.from({ length: 2_000 }, (_, id) => `${PREFIX}public/${id}`));
    setImmediate(() => controller.abort(new Error('cancel during inventory')));
    await expect(listStoredContextGraphQueryCandidates(store, { signal: controller.signal }))
      .rejects.toThrow('cancel during inventory');
  });

  it('forwards cancellation to the index and rejects late inventory success', async () => {
    const controller = new AbortController();
    const { store, listGraphsByPrefix } = indexedStore([]);
    let release!: (graphs: string[]) => void;
    listGraphsByPrefix.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = listStoredContextGraphQueryCandidates(store, { signal: controller.signal });
    const failure = expect(pending).rejects.toThrow('cancel inventory');
    controller.abort(new Error('cancel inventory'));
    release([]);
    await failure;
    expect(listGraphsByPrefix).toHaveBeenCalledWith(PREFIX, {
      source: 'storage.contextGraphOwnerCandidates', signal: controller.signal, ...CEILING, currentCatalog: true,
    });
  });

  it('reads the inventory under the internal ceiling, never a caller limit, and fails as a node-side limit above it', async () => {
    const { store, listGraphsByPrefix } = indexedStore(Array.from({ length: 100 }, (_, id) => `${PREFIX}public/${id}`));
    await expect(new GraphManager(store).listStoredContextGraphOwnerCandidates({ maxResponseBytes: 16 }))
      .resolves.toContain('public');
    expect(listGraphsByPrefix.mock.calls[0]?.[1]).toMatchObject(CEILING);
    vi.stubEnv(STORE_GRAPH_CATALOG_MAX_BYTES_ENV, '64');
    try {
      await expect(listStoredContextGraphQueryCandidates(store)).rejects.toMatchObject({
        code: 'STORE_INTERNAL_LIMIT', limitName: STORE_GRAPH_CATALOG_LIMIT_NAME, limitBytes: 64,
      });
    } finally { vi.unstubAllEnvs(); }
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  GraphSetIndexStore,
  OxigraphStore,
  createTripleStore,
  registerTripleStoreAdapter,
  type Quad,
  type QueryResult,
  type TripleStore,
} from '../src/index.js';

function q(graph: string, subject = 'urn:s'): Quad {
  return {
    subject,
    predicate: 'urn:p',
    object: '"v"',
    graph,
  };
}

class CountingStore implements TripleStore {
  listGraphsCalls = 0;
  listGraphsGate: Promise<void> | null = null;
  failListGraphs = false;

  constructor(protected readonly inner: TripleStore) {}

  insert(quads: Quad[]): Promise<void> { return this.inner.insert(quads); }
  delete(quads: Quad[]): Promise<void> { return this.inner.delete(quads); }
  deleteByPattern(pattern: Partial<Quad>): Promise<number> { return this.inner.deleteByPattern(pattern); }
  query(sparql: string): Promise<QueryResult> { return this.inner.query(sparql); }
  hasGraph(graphUri: string): Promise<boolean> { return this.inner.hasGraph(graphUri); }
  createGraph(graphUri: string): Promise<void> { return this.inner.createGraph(graphUri); }
  dropGraph(graphUri: string): Promise<void> { return this.inner.dropGraph(graphUri); }
  deleteBySubjectPrefix(graphUri: string, prefix: string): Promise<number> {
    return this.inner.deleteBySubjectPrefix(graphUri, prefix);
  }
  countQuads(graphUri?: string): Promise<number> { return this.inner.countQuads(graphUri); }
  flush(): Promise<void> { return this.inner.flush?.() ?? Promise.resolve(); }
  close(): Promise<void> { return this.inner.close(); }

  async listGraphs(): Promise<string[]> {
    this.listGraphsCalls++;
    if (this.listGraphsGate) await this.listGraphsGate;
    if (this.failListGraphs) throw new Error('listGraphs failed');
    return this.inner.listGraphs();
  }
}

class FailingMaintenanceStore extends CountingStore {
  failHasGraph = false;

  async hasGraph(graphUri: string): Promise<boolean> {
    if (this.failHasGraph) throw new Error('hasGraph failed');
    return super.hasGraph(graphUri);
  }
}

class MutatingQueryStore extends CountingStore {
  async query(sparql: string): Promise<QueryResult> {
    if (/^\s*(?:#[^\r\n]*(?:\r?\n|$)\s*)*INSERT\s+DATA\b/i.test(sparql)) {
      await this.inner.insert([q('did:dkg:context-graph:query-created')]);
      return { type: 'bindings', bindings: [] };
    }
    return this.inner.query(sparql);
  }
}

describe('GraphSetIndexStore', () => {
  it('seeds from one listGraphs scan and serves prefix lookups from memory', async () => {
    const inner = new OxigraphStore();
    await inner.insert([
      q('did:dkg:context-graph:alpha'),
      q('did:dkg:context-graph:beta'),
    ]);
    const counting = new CountingStore(inner);
    const store = new GraphSetIndexStore(counting);

    await expect(store.listGraphsByPrefix('did:dkg:context-graph:a')).resolves.toEqual([
      'did:dkg:context-graph:alpha',
    ]);
    await expect(store.listGraphs()).resolves.toEqual(
      expect.arrayContaining(['did:dkg:context-graph:alpha', 'did:dkg:context-graph:beta']),
    );
    expect(counting.listGraphsCalls).toBe(1);
  });

  it('degrades to a transparent pass-through when constructed with enabled:false', async () => {
    const inner = new OxigraphStore();
    const counting = new CountingStore(inner);
    const store = new GraphSetIndexStore(counting, { enabled: false });

    await store.insert([q('did:dkg:context-graph:alpha')]);
    await store.insert([q('did:dkg:context-graph:beta')]);

    // No index is maintained: every listGraphs/listGraphsByPrefix hits inner
    // directly (one scan each), proving the wrapper is a pass-through and not
    // serving a cached set.
    await expect(store.listGraphs()).resolves.toEqual(
      expect.arrayContaining(['did:dkg:context-graph:alpha', 'did:dkg:context-graph:beta']),
    );
    await expect(store.listGraphsByPrefix('did:dkg:context-graph:a')).resolves.toEqual([
      'did:dkg:context-graph:alpha',
    ]);
    expect(counting.listGraphsCalls).toBe(2);

    // An out-of-contract writer is observed immediately — there is no index
    // shadowing inner's true state.
    await inner.insert([q('did:dkg:context-graph:gamma')]);
    await expect(store.listGraphs()).resolves.toHaveLength(3);
    expect(counting.listGraphsCalls).toBe(3);

    await store.close();
  });

  it('maintains the graph set through local insert/delete/drop/deleteBySubjectPrefix mutators', async () => {
    const counting = new CountingStore(new OxigraphStore());
    const store = new GraphSetIndexStore(counting);
    await expect(store.listGraphs()).resolves.toEqual([]);

    const graph = 'did:dkg:context-graph:mutators';
    const root = 'urn:root';
    const child = `${root}/.well-known/genid/1`;
    await store.insert([q(graph, root), q(graph, child)]);
    await expect(store.listGraphsByPrefix('did:dkg:context-graph:mut')).resolves.toEqual([graph]);
    expect(counting.listGraphsCalls).toBe(1);

    await store.delete([q(graph, child)]);
    await expect(store.listGraphs()).resolves.toEqual([graph]);

    await store.deleteBySubjectPrefix(graph, root);
    await expect(store.listGraphs()).resolves.toEqual([]);

    await store.insert([q(graph)]);
    await store.dropGraph(graph);
    await expect(store.listGraphs()).resolves.toEqual([]);
  });

  it('refreshes the full index after graph-wide deleteByPattern without a graph constraint', async () => {
    const counting = new CountingStore(new OxigraphStore());
    const store = new GraphSetIndexStore(counting);
    await store.insert([q('did:dkg:context-graph:one'), q('did:dkg:context-graph:two')]);
    await expect(store.listGraphs()).resolves.toHaveLength(2);
    expect(counting.listGraphsCalls).toBe(1);

    await store.deleteByPattern({ predicate: 'urn:p' });
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(2);
  });

  it('revalidates after the configured interval to discover out-of-contract writers', async () => {
    let now = 1_000;
    const inner = new OxigraphStore();
    const counting = new CountingStore(inner);
    const store = new GraphSetIndexStore(counting, { revalidateMs: 100, now: () => now });

    await expect(store.listGraphs()).resolves.toEqual([]);
    await inner.insert([q('did:dkg:context-graph:external')]);

    now += 99;
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(1);

    now += 1;
    await expect(store.listGraphs()).resolves.toEqual(['did:dkg:context-graph:external']);
    expect(counting.listGraphsCalls).toBe(2);
  });

  it('treats revalidateMs 0 as always expired', async () => {
    const inner = new OxigraphStore();
    const counting = new CountingStore(inner);
    const store = new GraphSetIndexStore(counting, { revalidateMs: 0 });

    await expect(store.listGraphs()).resolves.toEqual([]);
    await inner.insert([q('did:dkg:context-graph:zero-revalidate')]);
    await expect(store.listGraphs()).resolves.toEqual(['did:dkg:context-graph:zero-revalidate']);
    expect(counting.listGraphsCalls).toBe(2);
  });

  it('coalesces concurrent refresh callers onto one listGraphs scan', async () => {
    const inner = new OxigraphStore();
    await inner.insert([q('did:dkg:context-graph:coalesced')]);
    const counting = new CountingStore(inner);
    let release!: () => void;
    counting.listGraphsGate = new Promise<void>((resolve) => { release = resolve; });
    const store = new GraphSetIndexStore(counting);

    const calls = Promise.all([
      store.listGraphs(),
      store.listGraphsByPrefix('did:dkg:context-graph:'),
      store.listGraphs(),
    ]);
    await Promise.resolve();
    expect(counting.listGraphsCalls).toBe(1);
    counting.listGraphsGate = null;
    release();

    const [a, b, c] = await calls;
    expect(a).toEqual(['did:dkg:context-graph:coalesced']);
    expect(b).toEqual(['did:dkg:context-graph:coalesced']);
    expect(c).toEqual(['did:dkg:context-graph:coalesced']);
  });

  it('restarts an in-flight refresh when a local write lands during the scan', async () => {
    const inner = new OxigraphStore();
    await inner.insert([q('did:dkg:context-graph:before')]);
    const counting = new CountingStore(inner);
    let release!: () => void;
    counting.listGraphsGate = new Promise<void>((resolve) => { release = resolve; });
    const store = new GraphSetIndexStore(counting);

    const listed = store.listGraphs();
    await Promise.resolve();
    expect(counting.listGraphsCalls).toBe(1);

    await store.insert([q('did:dkg:context-graph:after')]);
    counting.listGraphsGate = null;
    release();

    await expect(listed).resolves.toEqual(
      expect.arrayContaining(['did:dkg:context-graph:before', 'did:dkg:context-graph:after']),
    );
    expect(counting.listGraphsCalls).toBe(2);
  });

  it('refreshes after successful mutating SPARQL passed through query()', async () => {
    const counting = new MutatingQueryStore(new OxigraphStore());
    const store = new GraphSetIndexStore(counting);
    await expect(store.listGraphs()).resolves.toEqual([]);

    await store.query('# cleanup\nINSERT DATA { GRAPH <ignored> { <urn:s> <urn:p> "v" } }');
    await expect(store.listGraphs()).resolves.toEqual(['did:dkg:context-graph:query-created']);
  });

  it('does not let observer failures reject committed writes', async () => {
    const store = new GraphSetIndexStore(new CountingStore(new OxigraphStore()), {
      onMutation: () => {
        throw new Error('observer failed');
      },
    });
    await store.listGraphs();

    await expect(store.insert([q('did:dkg:context-graph:observer')])).resolves.toBeUndefined();
    await expect(store.listGraphs()).resolves.toEqual(['did:dkg:context-graph:observer']);
  });

  it('clears the index instead of rejecting after post-commit maintenance failures', async () => {
    const graph = 'did:dkg:context-graph:maintenance-failure';
    const failing = new FailingMaintenanceStore(new OxigraphStore());
    const store = new GraphSetIndexStore(failing);
    await store.insert([q(graph)]);
    await expect(store.listGraphs()).resolves.toEqual([graph]);

    failing.failHasGraph = true;
    await expect(store.delete([q(graph)])).resolves.toBeUndefined();

    failing.failHasGraph = false;
    await expect(store.listGraphs()).resolves.toEqual([]);
  });

  it('clears the index instead of rejecting after post-commit full refresh failures', async () => {
    const graph = 'did:dkg:context-graph:refresh-failure';
    const failing = new CountingStore(new OxigraphStore());
    const store = new GraphSetIndexStore(failing);
    await store.insert([q(graph)]);
    await expect(store.listGraphs()).resolves.toEqual([graph]);

    failing.failListGraphs = true;
    await expect(store.deleteByPattern({ predicate: 'urn:p' })).resolves.toBe(1);

    failing.failListGraphs = false;
    await expect(store.listGraphs()).resolves.toEqual([]);
  });

  it('createTripleStore wraps local and managed stores by default, composes outside large-literal storage, and can be disabled', async () => {
    const defaultStore = await createTripleStore({ backend: 'oxigraph' });
    expect(typeof defaultStore.listGraphsByPrefix).toBe('function');
    await defaultStore.close();

    const disabledStore = await createTripleStore({ backend: 'oxigraph', graphSetIndex: false });
    expect(disabledStore.listGraphsByPrefix).toBeUndefined();
    await disabledStore.close();

    const blobDir = await mkdtemp(join(tmpdir(), 'dkg-graph-set-index-'));
    try {
      const composedStore = await createTripleStore({
        backend: 'oxigraph',
        largeLiteralStorage: { directory: blobDir, thresholdBytes: 1 },
      });
      expect(typeof composedStore.listGraphsByPrefix).toBe('function');
      await composedStore.insert([q('did:dkg:context-graph:composed')]);
      await expect(composedStore.listGraphsByPrefix!('did:dkg:context-graph:comp')).resolves.toEqual([
        'did:dkg:context-graph:composed',
      ]);
      await composedStore.close();
    } finally {
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it('leaves sparql-http stores unwrapped by default (native listGraphs cache covers it) unless explicitly enabled', async () => {
    const operatorStore = await createTripleStore({
      backend: 'sparql-http',
      options: { queryEndpoint: 'http://example.invalid/query' },
    });
    expect(operatorStore.listGraphsByPrefix).toBeUndefined();
    await operatorStore.close();

    // Managed sparql-http already owns a write-invalidated, TTL-bounded
    // listGraphs() cache in SparqlHttpStore (cacheGraphList === managedByDkg).
    // Wrapping it in the GraphSetIndexStore would stack a SECOND ~30 s TTL on
    // top of that one, so an out-of-band graph-set change could stay invisible
    // for up to ~60 s. The factory must therefore NOT default-enable the index
    // for this store — its native cache already covers the idle-node scan cost.
    const managedStore = await createTripleStore({
      backend: 'sparql-http',
      options: { queryEndpoint: 'http://example.invalid/query', managedByDkg: true },
    });
    expect(managedStore.listGraphsByPrefix).toBeUndefined();
    await managedStore.close();

    // An explicit opt-in is still honoured (operator override): it wraps even a
    // store that has a native cache.
    const optedInStore = await createTripleStore({
      backend: 'sparql-http',
      options: { queryEndpoint: 'http://example.invalid/query' },
      graphSetIndex: { revalidateMs: 0 },
    });
    expect(typeof optedInStore.listGraphsByPrefix).toBe('function');
    await optedInStore.close();
  });

  it('still wraps a managed store that has no native listGraphs cache (managed blazegraph)', async () => {
    // BlazegraphStore — unlike SparqlHttpStore — keeps no native listGraphs
    // cache, so there is no double-TTL to avoid: a managed blazegraph store
    // must still get the index by default. (Construction does not connect, so a
    // dummy url is fine.)
    const managedBlazegraph = await createTripleStore({
      backend: 'blazegraph',
      options: { url: 'http://example.invalid/sparql', managedByDkg: true },
    });
    expect(typeof managedBlazegraph.listGraphsByPrefix).toBe('function');
    await managedBlazegraph.close();
  });

  it('leaves custom backends uncached unless explicitly enabled', async () => {
    const backend = 'custom-remote-graph-set-index-test';
    registerTripleStoreAdapter(backend, async () => new OxigraphStore());

    const defaultStore = await createTripleStore({ backend });
    expect(defaultStore.listGraphsByPrefix).toBeUndefined();
    await defaultStore.close();

    const optedInStore = await createTripleStore({ backend, graphSetIndex: true });
    expect(typeof optedInStore.listGraphsByPrefix).toBe('function');
    await optedInStore.close();
  });
});

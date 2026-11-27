import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BlazegraphStore,
  DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES,
  GraphSetIndexStore,
  OxigraphStore,
  OxigraphWorkerStore,
  STORE_GRAPH_CATALOG_LIMIT_NAME,
  STORE_GRAPH_CATALOG_MAX_BYTES_ENV,
  SparqlHttpStore,
  StoreInternalLimitError,
  StoreResponseTooLargeError,
  isStoreInternalLimitError,
  loadSortedGraphCatalog,
  readGraphInventory,
  readGraphInventoryByPrefix,
  resolveSharedMemoryReadGraphs,
  storeGraphCatalogMaxBytes,
  type QueryOptions,
  type TripleStore,
} from '../src/index.js';
import {
  assertGraphCatalogWithinInternalLimit,
  assertMeasuredGraphCatalogWithinInternalLimit,
  internalCatalogReadOptions,
  readCompleteGraphCatalog,
} from '../src/graph-catalog-internal-limit.js';
import { measureGraphCatalogBytes } from '../src/graph-catalog-response-limit.js';
import { deserializeWorkerErrorV1, serializeWorkerErrorV1 } from '../src/worker-error-protocol.js';
import { CountingStore, q } from './graph-set-index-store-harness.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const CG = 'did:dkg:context-graph:';
const CEILING = DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES;
const bytes = (graphs: readonly string[]) => measureGraphCatalogBytes(graphs);
const setCeiling = (value: number) => vi.stubEnv(STORE_GRAPH_CATALOG_MAX_BYTES_ENV, String(value));

function thrown(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error('expected a throw');
}

describe('the internal graph catalog ceiling', () => {
  it('defaults to 256 MiB and takes a positive integer from the environment', () => {
    expect(storeGraphCatalogMaxBytes()).toBe(256 * 1024 * 1024);
    setCeiling(4096);
    expect(storeGraphCatalogMaxBytes()).toBe(4096);
    vi.stubEnv(STORE_GRAPH_CATALOG_MAX_BYTES_ENV, ' 2048 ');
    expect(storeGraphCatalogMaxBytes()).toBe(2048);
    for (const invalid of ['0', '-1', '1.5', 'many', '9007199254740993', '']) {
      vi.stubEnv(STORE_GRAPH_CATALOG_MAX_BYTES_ENV, invalid);
      expect(storeGraphCatalogMaxBytes()).toBe(CEILING);
    }
  });

  it("keeps the caller's cancellation, lane and label and replaces its byte limits", () => {
    setCeiling(4096);
    const signal = new AbortController().signal;
    expect(internalCatalogReadOptions({
      signal, priority: 'ack', controlQueue: 'share', source: 'caller', maxResponseBytes: 8, maxLiteralHydrationBytes: 9,
      withheldGraphRoots: ['urn:withheld'],
    })).toEqual({ signal, priority: 'ack', controlQueue: 'share', source: 'caller',
      maxResponseBytes: 4096, maxLiteralHydrationBytes: 4096 });
    expect(internalCatalogReadOptions()).toEqual({ maxResponseBytes: 4096, maxLiteralHydrationBytes: 4096 });
  });

  it("relabels a too-large full read as the node's limit and passes other failures through", async () => {
    setCeiling(4096);
    const seen: QueryOptions[] = [];
    const error = await readCompleteGraphCatalog({ maxResponseBytes: 8 }, async internal => {
      seen.push(internal);
      throw new StoreResponseTooLargeError(internal.maxResponseBytes!, 5000n);
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(StoreInternalLimitError);
    expect(error).toMatchObject({
      code: 'STORE_INTERNAL_LIMIT', limitName: STORE_GRAPH_CATALOG_LIMIT_NAME, limitBytes: 4096, actualBytes: 5000,
      message: 'Node-side limit STORE_GRAPH_CATALOG_MAX_BYTES reached: found 5000 bytes, limit 4096',
    });
    expect(seen).toEqual([{ maxResponseBytes: 4096, maxLiteralHydrationBytes: 4096 }]);
    const other = new Error('store unavailable');
    await expect(readCompleteGraphCatalog(undefined, async () => { throw other; })).rejects.toBe(other);
  });

  it('bounds a catalog held in memory by the ceiling alone', () => {
    const graphs = ['urn:a', 'urn:b'];
    setCeiling(bytes(graphs));
    expect(() => assertGraphCatalogWithinInternalLimit(graphs)).not.toThrow();
    expect(() => assertMeasuredGraphCatalogWithinInternalLimit(bytes(graphs))).not.toThrow();
    setCeiling(bytes(graphs) - 1);
    expect(thrown(() => assertGraphCatalogWithinInternalLimit(graphs))).toMatchObject({
      code: 'STORE_INTERNAL_LIMIT', limitBytes: bytes(graphs) - 1, actualBytes: bytes(graphs),
    });
    expect(thrown(() => assertMeasuredGraphCatalogWithinInternalLimit(bytes(graphs)))).toBeInstanceOf(StoreInternalLimitError);
  });

  it('is recognized by shape and survives the worker boundary', () => {
    const error = new StoreInternalLimitError(STORE_GRAPH_CATALOG_LIMIT_NAME, 10, 2n ** 64n);
    expect(error.actualBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(isStoreInternalLimitError({ ...error, message: error.message })).toBe(true);
    expect(isStoreInternalLimitError({ code: 'STORE_INTERNAL_LIMIT', message: 'shape only' })).toBe(false);
    expect(isStoreInternalLimitError(null)).toBe(false);
    const copy = deserializeWorkerErrorV1(serializeWorkerErrorV1(error));
    expect(copy).toBeInstanceOf(StoreInternalLimitError);
    expect(copy).toMatchObject({ limitName: STORE_GRAPH_CATALOG_LIMIT_NAME, limitBytes: 10, actualBytes: Number.MAX_SAFE_INTEGER });
  });
});

describe('a caller pays for, and is bounded by, what it receives', () => {
  const target = `${CG}target`;
  const slice = [`${target}/_verifiable_memory/a/1`, `${target}/_verifiable_memory/a/2`];
  const unrelated = Array.from({ length: 80 }, (_, n) => `${CG}unrelated-${n}/_verifiable_memory/a/${n}`);
  const callerLimit = 256;

  async function seeded(): Promise<OxigraphStore> {
    const inner = new OxigraphStore();
    await inner.insert([...slice, ...unrelated].map(graph => q(graph)));
    return inner;
  }

  it.each([true, false])('index enabled=%s: a prefix read is charged and bounded by its slice alone', async enabled => {
    expect(bytes([...slice, ...unrelated])).toBeGreaterThan(callerLimit);
    const inner = await seeded();
    const counting = new CountingStore(inner);
    const store = new GraphSetIndexStore(counting, { enabled });
    try {
      for (let read = 0; read < 2; read += 1) {
        const inventory = await store.readGraphInventory(`${target}/`, { maxResponseBytes: callerLimit });
        expect([...inventory.graphs].sort()).toEqual(slice);
        expect(inventory.materializedBytes).toBe(bytes(slice));
      }
      // The complete read under it is node work under the ceiling, never the caller's limit.
      expect(counting.listGraphsOptions.map(options => options?.maxResponseBytes)).toEqual(
        enabled ? [CEILING] : [CEILING, CEILING]);
      await expect(store.readGraphInventory(`${target}/`, { maxResponseBytes: bytes(slice) - 1 }))
        .rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE', maxBytes: bytes(slice) - 1 });
    } finally { await inner.close(); }
  });

  it.each([true, false])("index enabled=%s: the caller's limit bounds the complete list it asks for", async enabled => {
    const inner = await seeded();
    const store = new GraphSetIndexStore(new CountingStore(inner), { enabled });
    try {
      const complete = await store.readGraphInventory(undefined, { maxResponseBytes: 1 << 20 });
      expect(complete.graphs).toHaveLength(slice.length + unrelated.length);
      expect(complete.materializedBytes).toBe(bytes(complete.graphs));
      for (const read of [
        () => store.readGraphInventory(undefined, { maxResponseBytes: callerLimit }),
        () => store.listGraphs({ maxResponseBytes: callerLimit }),
        () => store.listGraphsSorted({ maxResponseBytes: callerLimit }),
      ]) await expect(read()).rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE', maxBytes: callerLimit });
    } finally { await inner.close(); }
  });

  it('charges a prefix that splits a surrogate pair for its own matches', async () => {
    const prefix = `${CG}emoji-\uD83D`;
    const matches = [`${CG}emoji-\u{1F600}/a`, `${CG}emoji-\u{1F601}/b`];
    const inner = new OxigraphStore();
    await inner.insert([...matches, `${CG}emoji-\u{1F300}/c`, ...unrelated].map(graph => q(graph)));
    const store = new GraphSetIndexStore(inner);
    try {
      const inventory = await store.readGraphInventory(prefix, { maxResponseBytes: callerLimit });
      expect([...inventory.graphs].sort()).toEqual(matches);
      expect(inventory.materializedBytes).toBe(bytes(inventory.graphs));
      await expect(store.readGraphInventory(prefix, { maxResponseBytes: bytes(matches) - 1 }))
        .rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE' });
    } finally { await inner.close(); }
  });

  it('loads a sorted catalog as node work and bounds only what its caller receives', async () => {
    const inner = await seeded();
    const counting = new CountingStore(inner);
    try {
      const sorted = await loadSortedGraphCatalog(counting, { priority: 'background', source: 'sync.test' });
      expect(sorted).toHaveLength(slice.length + unrelated.length);
      expect(counting.listGraphsOptions.at(-1)).toEqual({ priority: 'background', source: 'sync.test',
        maxResponseBytes: CEILING, maxLiteralHydrationBytes: CEILING });
      await expect(loadSortedGraphCatalog(counting, { maxResponseBytes: callerLimit }))
        .rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE', maxBytes: callerLimit });
      setCeiling(callerLimit);
      await expect(loadSortedGraphCatalog(counting)).rejects.toMatchObject({ code: 'STORE_INTERNAL_LIMIT' });
    } finally { await inner.close(); }
  });

  it('bounds a complete list by the ceiling even when the store ignores byte options', async () => {
    const match = `${CG}small/a`;
    const graphs = [match, ...Array.from({ length: 20 }, (_, n) => `${CG}unrelated-${n}/b`)];
    const ignoring = { listGraphs: async () => graphs } as unknown as TripleStore;
    const measuring = {
      listGraphs: async () => graphs,
      readGraphInventory: async () => ({ graphs, materializedBytes: bytes(graphs) }),
    } as unknown as TripleStore;
    // The slice would fit; the complete list the store hands back does not.
    setCeiling(bytes([match]) + 8);
    for (const read of [
      () => readGraphInventoryByPrefix(ignoring, `${CG}small/`),
      () => readGraphInventory(ignoring),
      () => loadSortedGraphCatalog(ignoring),
      () => new GraphSetIndexStore(ignoring, { enabled: false }).readGraphInventory(`${CG}small/`),
      () => new GraphSetIndexStore(measuring).readGraphInventory(`${CG}small/`),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: 'STORE_INTERNAL_LIMIT', limitName: STORE_GRAPH_CATALOG_LIMIT_NAME });
    }
    vi.unstubAllEnvs();
    await expect(readGraphInventoryByPrefix(ignoring, `${CG}small/`))
      .resolves.toEqual({ graphs: [match], materializedBytes: bytes([match]) });
  });

  it("bounds what a store's own inventory and prefix reads return, whatever it did with byte options", async () => {
    const wide = Array.from({ length: 20 }, (_, n) => `${target}/_verifiable_memory/b/${n}`);
    const own = {
      listGraphs: async () => wide,
      readGraphInventory: async () => ({ graphs: wide, materializedBytes: bytes(wide) }),
    } as unknown as TripleStore;
    const byPrefix = { listGraphs: async () => wide, listGraphsByPrefix: async () => wide } as unknown as TripleStore;
    for (const read of [
      () => readGraphInventoryByPrefix(own, `${target}/`, { maxResponseBytes: callerLimit }),
      () => readGraphInventoryByPrefix(byPrefix, `${target}/`, { maxResponseBytes: callerLimit }),
      () => readGraphInventory(own, { maxResponseBytes: callerLimit }),
      () => new GraphSetIndexStore(own, { enabled: false }).readGraphInventory(`${target}/`, { maxResponseBytes: callerLimit }),
      () => new GraphSetIndexStore(byPrefix, { enabled: false }).readGraphInventory(`${target}/`, { maxResponseBytes: callerLimit }),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE', maxBytes: callerLimit });
    }
    setCeiling(bytes(wide) - 1);
    await expect(readGraphInventory(own)).rejects.toMatchObject({ code: 'STORE_INTERNAL_LIMIT' });
  });

  it("bounds a graph-manager prefix read's slice by the caller's limit on a store without a prefix listing", async () => {
    const bucket = `${CG}swm/_shared_memory`;
    const large = Array.from({ length: 20 }, (_, n) => `${bucket}/0xabc/${n}`);
    const tooLarge = { listGraphs: async () => [...large, ...unrelated] } as unknown as TripleStore;
    await expect(resolveSharedMemoryReadGraphs(tooLarge, bucket, { maxResponseBytes: callerLimit }))
      .rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE', maxBytes: callerLimit });
    const fits = { listGraphs: async () => [`${bucket}/0xabc/1`, ...unrelated] } as unknown as TripleStore;
    await expect(resolveSharedMemoryReadGraphs(fits, bucket, { maxResponseBytes: callerLimit }))
      .resolves.toEqual([bucket, `${bucket}/0xabc/1`]);
  });

  it('serves two prefix discoveries on a catalog larger than the discovery limit, each charged for its slice', async () => {
    const discoveryLimit = 8 * 1024 * 1024; // The query package's discovery limit.
    const large = Array.from({ length: 70_000 }, (_, n) =>
      `${CG}large/_shared_memory/0x${'a'.repeat(40)}/${String(n).padStart(60, '0')}`);
    const small = [`${CG}small/_verifiable_memory/a/1`, `${CG}small/context/1`];
    expect(bytes([...large, ...small])).toBeGreaterThan(discoveryLimit);
    class ListingStore extends CountingStore {
      override async listGraphs(options?: QueryOptions): Promise<string[]> {
        this.listGraphsCalls++;
        this.listGraphsOptions.push(options);
        return [...large, ...small];
      }
    }
    for (const enabled of [true, false]) {
      const listing = new ListingStore(new OxigraphStore());
      const store = new GraphSetIndexStore(listing, { enabled });
      try {
        let charged = 0;
        for (const prefix of [`${CG}small/_verifiable_memory/`, `${CG}small/context/`]) {
          const inventory = await readGraphInventoryByPrefix(store, prefix, { maxResponseBytes: discoveryLimit });
          expect(inventory.graphs).toHaveLength(1);
          charged += inventory.materializedBytes;
        }
        expect(charged).toBe(bytes([small[0]!]) + bytes([small[1]!]));
        expect(listing.listGraphsCalls).toBe(enabled ? 1 : 2);
        expect(listing.listGraphsOptions.every(options => options?.maxResponseBytes === CEILING)).toBe(true);
      } finally { await store.close(); }
    }
  });
});

describe('a refresh is node work', () => {
  const small = `${CG}small/a`;

  it("does not inherit the caller's limit: a periodic refresh of a larger catalog serves the caller's slice", async () => {
    let now = 1_000;
    const inner = new OxigraphStore();
    const store = new GraphSetIndexStore(inner, { revalidateMs: 100, now: () => now });
    try {
      await inner.insert([q(small)]);
      expect(await store.listGraphs({ maxResponseBytes: 64 })).toEqual([small]);
      await inner.insert([q(`${CG}${'large'.repeat(30)}`)]);
      now += 100;
      await expect(store.listGraphsByPrefix(`${CG}small/`, { maxResponseBytes: 64 })).resolves.toEqual([small]);
      expect(await store.listGraphs()).toHaveLength(2);
    } finally { await store.close(); }
  });

  it("keeps one caller's cancellation out of the scan it shares with callers of other limits", async () => {
    let release!: () => void;
    const inner = new OxigraphStore();
    await inner.insert([q(small)]);
    const counting = new CountingStore(inner);
    counting.listGraphsGate = new Promise<void>(resolve => { release = resolve; });
    const store = new GraphSetIndexStore(counting);
    try {
      const first = new AbortController();
      const firstRead = store.listGraphsByPrefix(`${CG}small/`, { maxResponseBytes: 256, signal: first.signal });
      const firstRejected = expect(firstRead).rejects.toThrow('first caller left');
      await vi.waitFor(() => expect(counting.listGraphsCalls).toBe(1));
      const second = store.listGraphsByPrefix(`${CG}small/`, { maxResponseBytes: 4096, signal: new AbortController().signal });
      first.abort(new Error('first caller left'));
      await firstRejected;
      release();
      await expect(second).resolves.toEqual([small]);
      expect(counting.listGraphsCalls).toBe(1);
      expect(counting.listGraphsOptions[0]?.signal).toBeUndefined();
    } finally { await store.close(); }
  });

  it('fails a warm refresh that passes the ceiling closed, like a cold seed, and keeps tolerating other warm failures', async () => {
    let now = 1_000;
    const inner = new OxigraphStore();
    await inner.insert([q(small)]);
    const counting = new CountingStore(inner);
    const store = new GraphSetIndexStore(counting, { revalidateMs: 100, revalidate: 'blocking', revalidateFailureBackoffMs: 10, now: () => now });
    try {
      expect(await store.listGraphsByPrefix(`${CG}small/`)).toEqual([small]);
      // Another failure of a warm refresh keeps the last catalog.
      counting.failListGraphs = true;
      now += 100;
      await expect(store.listGraphsByPrefix(`${CG}small/`)).resolves.toEqual([small]);
      counting.failListGraphs = false;
      setCeiling(bytes([small]));
      // A writer outside this index grows the store past the ceiling.
      await inner.insert([q(`${CG}${'large'.repeat(30)}`)]);
      now += 10;
      await expect(store.listGraphsByPrefix(`${CG}small/`)).rejects.toMatchObject({
        code: 'STORE_INTERNAL_LIMIT', limitName: STORE_GRAPH_CATALOG_LIMIT_NAME,
      });
      vi.unstubAllEnvs();
      await expect(store.listGraphsByPrefix(`${CG}small/`)).resolves.toEqual([small]);
      expect(await store.listGraphs()).toHaveLength(2);
    } finally { await store.close(); }
  });

  it("fails a cold seed, a dirty rebuild and a warm catalog over the ceiling closed, as the node's limit", async () => {
    const inner = new OxigraphStore();
    await inner.insert([q(small), q(`${CG}other/b`)]);
    const counting = new CountingStore(inner);
    const store = new GraphSetIndexStore(counting);
    try {
      setCeiling(16);
      await expect(store.listGraphsByPrefix(`${CG}small/`)).rejects.toMatchObject({
        code: 'STORE_INTERNAL_LIMIT', limitName: STORE_GRAPH_CATALOG_LIMIT_NAME, limitBytes: 16,
      });
      vi.unstubAllEnvs();
      await expect(store.listGraphsByPrefix(`${CG}small/`)).resolves.toEqual([small]);
      // An opaque update marks the catalog dirty; its rebuild is strict.
      await store.update(`INSERT DATA { GRAPH <${CG}third/c> { <urn:s> <urn:p> "v" } }`);
      const scans = counting.listGraphsCalls;
      setCeiling(16);
      await expect(store.listGraphsByPrefix(`${CG}small/`)).rejects.toMatchObject({ code: 'STORE_INTERNAL_LIMIT' });
      expect(counting.listGraphsCalls).toBe(scans + 1);
      vi.unstubAllEnvs();
      await expect(store.listGraphsByPrefix(`${CG}small/`)).resolves.toEqual([small]);
      // A warm catalog that is itself over the ceiling is answered the same way.
      setCeiling(16);
      await expect(store.listGraphsByPrefix(`${CG}small/`)).rejects.toBeInstanceOf(StoreInternalLimitError);
    } finally { await store.close(); }
  });
});

describe("an adapter's complete list is bounded by the ceiling, not by a caller's limit", () => {
  const graphs = Array.from({ length: 80 }, (_, n) => `${CG}adapter-${n}`);
  const listResponse = () => new Response(JSON.stringify({ head: { vars: ['g'] },
    results: { bindings: graphs.map(value => ({ g: { type: 'uri', value } })) } }),
  { headers: { 'Content-Type': 'application/sparql-results+json' } });

  it('embedded Oxigraph, in process and behind its worker', async () => {
    const embedded = new OxigraphStore();
    await embedded.insert(graphs.map(graph => q(graph)));
    try {
      await expect(embedded.listGraphs({ maxResponseBytes: 64 })).resolves.toHaveLength(graphs.length);
      setCeiling(256);
      await expect(embedded.listGraphs()).rejects.toBeInstanceOf(StoreInternalLimitError);
    } finally { await embedded.close(); }
    // The worker thread reads the ceiling from its environment when it starts.
    const worker = new OxigraphWorkerStore();
    try {
      await worker.insert(graphs.map(graph => q(graph)));
      const error = await worker.listGraphs().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(StoreInternalLimitError);
      expect(error).toMatchObject({ limitName: STORE_GRAPH_CATALOG_LIMIT_NAME, limitBytes: 256 });
    } finally { await worker.close(); }
  });

  it.each(['blazegraph', 'sparql-http'] as const)('%s: the HTTP read uses the ceiling', async kind => {
    const fetch = vi.fn(async () => listResponse());
    vi.stubGlobal('fetch', fetch);
    const store = kind === 'blazegraph'
      ? new BlazegraphStore('http://catalog.test/sparql')
      : new SparqlHttpStore({ queryEndpoint: 'http://catalog.test/query' });
    try {
      await expect(store.listGraphs({ maxResponseBytes: 64 })).resolves.toEqual(graphs);
      setCeiling(256);
      await expect(store.listGraphs()).rejects.toMatchObject({
        code: 'STORE_INTERNAL_LIMIT', limitName: STORE_GRAPH_CATALOG_LIMIT_NAME, limitBytes: 256,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { await store.close(); }
  });
});

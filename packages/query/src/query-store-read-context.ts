<<<<<<< HEAD
import { raceAgainstCallerAbort } from './caller-abort.js';
=======
>>>>>>> codex/v14-canary-pr3204-20261015
import type { TripleStore, QueryResult as StoreQueryResult, QueryOptions as StoreQueryOptions } from '@origintrail-official/dkg-storage';
import type { QueryOptions } from './query-engine.js';
import { storeOptions } from './query-store-options.js';

<<<<<<< HEAD
// Separate from the caller result: stop HTTP buffering before decoding a large
// authority response. Oversized catalogs fail closed; they are never truncated.
=======
// Authority metadata has its own bounded transport and hydration budget.
>>>>>>> codex/v14-canary-pr3204-20261015
export const QUERY_CATALOG_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function sharedDiscoveryStoreOptions(
  options: StoreQueryOptions | undefined,
<<<<<<< HEAD
): StoreQueryOptions {
=======
): StoreQueryOptions | undefined {
>>>>>>> codex/v14-canary-pr3204-20261015
  return {
    priority: options?.priority,
    source: options?.source,
    maxResponseBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES,
<<<<<<< HEAD
=======
    maxLiteralHydrationBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES,
>>>>>>> codex/v14-canary-pr3204-20261015
  };
}

export interface StoreReadLane {
  query(sparql: string): Promise<StoreQueryResult>;
  listGraphsByPrefix(prefix: string): Promise<string[]>;
<<<<<<< HEAD
=======
  listGraphFamily(rootGraph: string): Promise<string[]>;
>>>>>>> codex/v14-canary-pr3204-20261015
}

export interface QueryStoreReadContext extends StoreReadLane {
  readonly signal: AbortSignal | undefined;
  readonly catalog: StoreReadLane;
  readonly shared: StoreReadLane & { readonly cacheKey: string };
}

<<<<<<< HEAD
export function createStoreReadLane(
=======
function createStoreReadLane(
>>>>>>> codex/v14-canary-pr3204-20261015
  store: TripleStore,
  options: StoreQueryOptions | undefined,
): StoreReadLane {
  return {
    query: (sparql) => store.query(sparql, options),
    listGraphsByPrefix: (prefix) => listGraphsByPrefix(store, prefix, options),
<<<<<<< HEAD
=======
    listGraphFamily: (rootGraph) => listGraphFamily(store, rootGraph, options),
>>>>>>> codex/v14-canary-pr3204-20261015
  };
}

export function createQueryStoreReadContext(
  store: TripleStore,
  queryOptions: QueryOptions | undefined,
): QueryStoreReadContext {
  const options = storeOptions(queryOptions);
  const lane = createStoreReadLane(store, options);
  const sharedOptions = sharedDiscoveryStoreOptions(options);
<<<<<<< HEAD
  const sharedLane = createStoreReadLane(store, sharedOptions);
  // Fresh catalog authority shares the owner and cancellation, but has the
  // independent catalog budget rather than the caller-derived result ceiling.
  const catalogOptions = { ...options, maxResponseBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES };
  return {
    ...lane,
    // Enumeration may share an upstream refresh, but each caller owns its abort race.
    listGraphsByPrefix: prefix => raceAgainstCallerAbort(sharedLane.listGraphsByPrefix(prefix), options?.signal),
    signal: options?.signal,
    catalog: createStoreReadLane(store, catalogOptions),
    shared: {
      ...sharedLane,
=======
  return {
    ...lane,
    signal: options?.signal,
    catalog: createStoreReadLane(store, { ...sharedOptions, signal: options?.signal }),
    shared: {
      ...createStoreReadLane(store, sharedOptions),
>>>>>>> codex/v14-canary-pr3204-20261015
      cacheKey: JSON.stringify([
        sharedOptions?.priority ?? 'normal',
        sharedOptions?.source ?? null,
      ]),
    },
  };
}

<<<<<<< HEAD
async function listGraphsByPrefix(store: TripleStore, prefix: string, options?: StoreQueryOptions): Promise<string[]> {
  return store.listGraphsByPrefix
    ? store.listGraphsByPrefix(prefix, options)
    : (await store.listGraphs(options)).filter(graph => graph.startsWith(prefix));
}
=======
async function listGraphsByPrefix(
  store: TripleStore,
  prefix: string,
  options?: StoreQueryOptions,
): Promise<string[]> {
  return store.listGraphsByPrefix
    ? store.listGraphsByPrefix(prefix, options)
    : (await store.listGraphs(options)).filter((graph) => graph.startsWith(prefix));
}

async function listGraphFamily(
  store: TripleStore,
  rootGraph: string,
  options?: StoreQueryOptions,
): Promise<string[]> {
  const graphs = await listGraphsByPrefix(store, `${rootGraph}/`, options);
  if (await store.hasGraph(rootGraph, options)) {
    graphs.unshift(rootGraph);
  }
  return graphs;
}

>>>>>>> codex/v14-canary-pr3204-20261015

import type { TripleStore, QueryResult as StoreQueryResult, QueryOptions as StoreQueryOptions } from '@origintrail-official/dkg-storage';
import type { QueryOptions } from './query-engine.js';
import { storeOptions } from './query-store-options.js';

// Authority metadata has its own bounded transport and hydration budget.
export const QUERY_CATALOG_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function sharedDiscoveryStoreOptions(
  options: StoreQueryOptions | undefined,
): StoreQueryOptions | undefined {
  return {
    priority: options?.priority,
    source: options?.source,
    maxResponseBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES,
    maxLiteralHydrationBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES,
  };
}

export interface StoreReadLane {
  query(sparql: string): Promise<StoreQueryResult>;
  listGraphsByPrefix(prefix: string): Promise<string[]>;
  listGraphFamily(rootGraph: string): Promise<string[]>;
}

export interface QueryStoreReadContext extends StoreReadLane {
  readonly signal: AbortSignal | undefined;
  readonly catalog: StoreReadLane;
  readonly shared: StoreReadLane & { readonly cacheKey: string };
}

function createStoreReadLane(
  store: TripleStore,
  options: StoreQueryOptions | undefined,
): StoreReadLane {
  return {
    query: (sparql) => store.query(sparql, options),
    listGraphsByPrefix: (prefix) => listGraphsByPrefix(store, prefix, options),
    listGraphFamily: (rootGraph) => listGraphFamily(store, rootGraph, options),
  };
}

export function createQueryStoreReadContext(
  store: TripleStore,
  queryOptions: QueryOptions | undefined,
): QueryStoreReadContext {
  const options = storeOptions(queryOptions);
  const lane = createStoreReadLane(store, options);
  const sharedOptions = sharedDiscoveryStoreOptions(options);
  return {
    ...lane,
    signal: options?.signal,
    catalog: createStoreReadLane(store, { ...sharedOptions, signal: options?.signal }),
    shared: {
      ...createStoreReadLane(store, sharedOptions),
      cacheKey: JSON.stringify([
        sharedOptions?.priority ?? 'normal',
        sharedOptions?.source ?? null,
      ]),
    },
  };
}

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


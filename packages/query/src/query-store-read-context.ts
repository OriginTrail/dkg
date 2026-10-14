import { raceAgainstCallerAbort } from './caller-abort.js';
import type { TripleStore, QueryResult as StoreQueryResult, QueryOptions as StoreQueryOptions } from '@origintrail-official/dkg-storage';
import type { QueryOptions } from './query-engine.js';
import { storeOptions } from './query-store-options.js';

// Separate from the caller result: stop HTTP buffering before decoding a large
// authority response. Oversized catalogs fail closed; they are never truncated.
export const QUERY_CATALOG_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function sharedDiscoveryStoreOptions(
  options: StoreQueryOptions | undefined,
): StoreQueryOptions {
  return {
    priority: options?.priority,
    source: options?.source,
    maxResponseBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES,
  };
}

export interface StoreReadLane {
  query(sparql: string): Promise<StoreQueryResult>;
  listGraphsByPrefix(prefix: string): Promise<string[]>;
}

export interface QueryStoreReadContext extends StoreReadLane {
  readonly signal: AbortSignal | undefined;
  readonly catalog: StoreReadLane;
  readonly shared: StoreReadLane & { readonly cacheKey: string };
}

export function createStoreReadLane(
  store: TripleStore,
  options: StoreQueryOptions | undefined,
): StoreReadLane {
  return {
    query: (sparql) => store.query(sparql, options),
    listGraphsByPrefix: (prefix) => listGraphsByPrefix(store, prefix, options),
  };
}

export function createQueryStoreReadContext(
  store: TripleStore,
  queryOptions: QueryOptions | undefined,
): QueryStoreReadContext {
  const options = storeOptions(queryOptions);
  const lane = createStoreReadLane(store, options);
  const sharedOptions = sharedDiscoveryStoreOptions(options);
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
      cacheKey: JSON.stringify([
        sharedOptions?.priority ?? 'normal',
        sharedOptions?.source ?? null,
      ]),
    },
  };
}

async function listGraphsByPrefix(store: TripleStore, prefix: string, options?: StoreQueryOptions): Promise<string[]> {
  return store.listGraphsByPrefix
    ? store.listGraphsByPrefix(prefix, options)
    : (await store.listGraphs(options)).filter(graph => graph.startsWith(prefix));
}

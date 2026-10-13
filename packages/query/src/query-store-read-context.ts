import type { TripleStore, QueryResult as StoreQueryResult, QueryOptions as StoreQueryOptions } from '@origintrail-official/dkg-storage';
import type { QueryOptions } from './query-engine.js';
import { storeOptions } from './query-store-options.js';

function sharedDiscoveryStoreOptions(
  options: StoreQueryOptions | undefined,
): StoreQueryOptions | undefined {
  if (!options?.priority && !options?.source) return undefined;
  return {
    priority: options.priority,
    source: options.source,
  };
}

export interface StoreReadLane {
  query(sparql: string): Promise<StoreQueryResult>;
  listGraphsByPrefix(prefix: string): Promise<string[]>;
}

export interface QueryStoreReadContext extends StoreReadLane {
  readonly signal: AbortSignal | undefined;
  readonly shared: StoreReadLane & { readonly cacheKey: string };
}

export function createStoreReadLane(
  store: TripleStore,
  options: StoreQueryOptions | undefined,
  listByPrefix: (store: TripleStore, prefix: string, options?: StoreQueryOptions) => Promise<string[]>,
): StoreReadLane {
  return {
    query: (sparql) => store.query(sparql, options),
    listGraphsByPrefix: (prefix) => listByPrefix(store, prefix, options),
  };
}

export function createQueryStoreReadContext(
  store: TripleStore,
  queryOptions: QueryOptions | undefined,
  listByPrefix: (store: TripleStore, prefix: string, options?: StoreQueryOptions) => Promise<string[]>,
): QueryStoreReadContext {
  const options = storeOptions(queryOptions);
  const lane = createStoreReadLane(store, options, listByPrefix);
  const sharedOptions = sharedDiscoveryStoreOptions(options);
  return {
    ...lane,
    signal: options?.signal,
    shared: {
      ...createStoreReadLane(store, sharedOptions, listByPrefix),
      cacheKey: JSON.stringify([
        sharedOptions?.priority ?? 'normal',
        sharedOptions?.source ?? null,
      ]),
    },
  };
}

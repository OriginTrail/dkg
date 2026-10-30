import { readGraphInventoryByPrefix } from '@origintrail-official/dkg-storage';
import { raceAgainstCallerAbort } from './caller-abort.js';
import type { TripleStore, QueryResult as StoreQueryResult, QueryOptions as StoreQueryOptions } from '@origintrail-official/dkg-storage';
import type { QueryOptions } from './query-engine.js';
import { storeOptions } from './query-store-options.js';
import { QueryMaterializationTooLargeError } from './query-materialization-error.js';
interface MaterializationMeter {
  consumeBytes(bytes: number): void;
}

export class QueryMaterializationBudget implements MaterializationMeter {
  private usedBytes = 0;

  constructor(readonly maxBytes: number) {}

  consume(value: unknown): void {
    this.consumeBytes(estimateMaterializedBytes(value));
  }

  consumeBytes(responseBytes: number): void {
    const nextUsed = this.usedBytes + responseBytes;
    if (nextUsed > this.maxBytes) {
      throw new QueryMaterializationTooLargeError(this.maxBytes, nextUsed);
    }
    this.usedBytes = nextUsed;
  }
}

/** Exact UTF-8 size of the JSON value retained by the query pipeline. */
export function estimateMaterializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
}


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
    maxLiteralHydrationBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES,
  };
}

export interface StoreReadLane {
  query(sparql: string): Promise<StoreQueryResult>;
  listGraphsByPrefix(prefix: string): Promise<string[]>;
}

/** Cache envelope: cost is required even for an empty discovery result. */
export interface MeasuredDiscovery<T> {
  readonly snapshot: T;
  readonly byteCount: number;
}

export interface QueryStoreReadContext extends StoreReadLane {
  readonly signal: AbortSignal | undefined;
  readonly materializationBudget: QueryMaterializationBudget | undefined;
  readonly catalog: StoreReadLane;
  withWithheldGraphRoots(roots: readonly string[]): StoreReadLane;
  readonly shared: {
    readonly cacheKey: string;
    measure<T>(load: (reads: StoreReadLane) => Promise<T>): Promise<MeasuredDiscovery<T>>;
    replay<T>(discovery: MeasuredDiscovery<T>): T;
  };
}

export function createStoreReadLane(
  store: TripleStore,
  options: StoreQueryOptions | undefined,
  meter?: MaterializationMeter,
): StoreReadLane {
  const measured = async <T>(read: () => Promise<T>): Promise<T> => {
    const value = await read(); meter?.consumeBytes(estimateMaterializedBytes(value)); return value;
  };
  return {
    query: (sparql) => measured(() => store.query(sparql, options)),
    listGraphsByPrefix: async prefix => {
      const graphs = await readGraphInventoryByPrefix(store, prefix, options);
      meter?.consumeBytes(graphs.materializedBytes);
      return [...graphs.graphs];
    },
  };
}

export function createQueryStoreReadContext(
  store: TripleStore,
  queryOptions: QueryOptions | undefined,
): QueryStoreReadContext {
  const options = storeOptions(queryOptions);
  const budget = queryOptions?.materializationBudget ?? (queryOptions?.maxMaterializedBytes === undefined
    ? undefined : new QueryMaterializationBudget(queryOptions.maxMaterializedBytes));
  const lane = createStoreReadLane(store, options, budget);
  const sharedOptions = sharedDiscoveryStoreOptions(options);
  const catalogOptions = { ...sharedOptions, signal: options?.signal };
  const measure = async <T>(load: (reads: StoreReadLane) => Promise<T>): Promise<MeasuredDiscovery<T>> => {
    let byteCount = 0;
    const measured = createStoreReadLane(store, sharedOptions, {
      consumeBytes(bytes) { byteCount += bytes; },
    });
    return { snapshot: await load(measured), byteCount };
  };
  return {
    ...lane,
    // Enumeration may share an upstream refresh, but each caller owns its abort race.
    listGraphsByPrefix: async prefix => {
      const discovery = await raceAgainstCallerAbort(measure(reads => reads.listGraphsByPrefix(prefix)), options?.signal);
      budget?.consumeBytes(discovery.byteCount); return discovery.snapshot;
    },
    signal: options?.signal,
    materializationBudget: budget,
    withWithheldGraphRoots: roots => createStoreReadLane(store, { ...options, withheldGraphRoots: [...roots] }, budget),
    catalog: createStoreReadLane(store, catalogOptions, budget),
    shared: {
      measure,
      replay<T>(discovery: MeasuredDiscovery<T>): T {
        budget?.consumeBytes(discovery.byteCount);
        return discovery.snapshot;
      },
      cacheKey: JSON.stringify([
        sharedOptions?.priority ?? 'normal',
        sharedOptions?.source ?? null,
        sharedOptions.maxResponseBytes,
        sharedOptions.maxLiteralHydrationBytes,
      ]),
    },
  };
}

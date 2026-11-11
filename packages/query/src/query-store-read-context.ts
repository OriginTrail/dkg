import { isStoreResponseTooLargeError, readGraphInventoryByPrefix, StoreInternalLimitError } from '@origintrail-official/dkg-storage';
import { raceAgainstCallerAbort } from './caller-abort.js';
import type { TripleStore, QueryResult as StoreQueryResult, QueryOptions as StoreQueryOptions } from '@origintrail-official/dkg-storage';
import type { QueryOptions } from './query-engine.js';
import { storeOptions } from './query-store-options.js';
import { QueryMaterializationTooLargeError } from './query-materialization-error.js';
import { ScopedQueryViolationError } from './scoped-query-error.js';
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
/** The limit a discovery or authority read over that bound names: the node's, not the caller's. */
export const QUERY_CATALOG_LIMIT_NAME = 'QUERY_CATALOG_MAX_RESPONSE_BYTES';

/** A read under the node's catalog bound; going over it raises `StoreInternalLimitError`. */
export async function readWithinCatalogLimit<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) {
    if (!isStoreResponseTooLargeError(error)) throw error;
    throw new StoreInternalLimitError(QUERY_CATALOG_LIMIT_NAME, error.maxBytes, error.actualBytes);
  }
}

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
  /** `withDataset`: the query sets its own dataset (FROM / FROM NAMED); a scoped lane can require it. */
  query(sparql: string, withDataset?: boolean): Promise<StoreQueryResult>;
  listGraphsByPrefix(prefix: string): Promise<string[]>;
}

/** Cache envelope: cost is required even for an empty discovery result. */
export interface MeasuredDiscovery<T> {
  readonly snapshot: T;
  readonly byteCount: number;
}

/**
 * One request's reads. `listGraphsByPrefix` reads each prefix once per request, and
 * nothing is kept for another request. `catalog.query` always reads: an authority
 * check that must see a registration made during discovery reads through it.
 *
 * Discovery, registry, authority and metadata reads are node work under the node's
 * catalog bound. The caller is charged for the graphs a discovery returns and for its
 * own results, never for registry, authority or metadata answers.
 */
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

/** Discovery and authority reads: the caller pays for the graphs a discovery returns only. */
function createInternalReadLane(
  store: TripleStore,
  options: StoreQueryOptions,
  sliceMeter?: MaterializationMeter,
): StoreReadLane {
  return {
    query: sparql => readWithinCatalogLimit(() => store.query(sparql, options)),
    listGraphsByPrefix: async prefix => {
      const graphs = await readWithinCatalogLimit(() => readGraphInventoryByPrefix(store, prefix, options));
      sliceMeter?.consumeBytes(graphs.materializedBytes);
      return [...graphs.graphs];
    },
  };
}

/** The first read of a key in this request; a failed read fails every use of it. */
function readOnce<T>(reads: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let pending = reads.get(key);
  if (!pending) reads.set(key, pending = read());
  return pending;
}

/** Reads that must set their own dataset: one without it is refused before it reaches the store. */
export function requireQueryDataset(reads: QueryStoreReadContext): QueryStoreReadContext {
  return { ...reads, query: (sparql, withDataset) => withDataset ? reads.query(sparql, withDataset)
    : Promise.reject(new ScopedQueryViolationError('a scoped read must carry its dataset')) };
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
    const measured = createInternalReadLane(store, sharedOptions, {
      consumeBytes(bytes) { byteCount += bytes; },
    });
    return { snapshot: await load(measured), byteCount };
  };
  const catalog = createInternalReadLane(store, catalogOptions, budget);
  const discoveries = new Map<string, Promise<readonly string[]>>();
  return {
    ...lane,
    // Enumeration may share an upstream refresh, but each caller owns its abort race.
    // A prefix read again in this request reuses the first read and is not charged again.
    listGraphsByPrefix: async prefix => [...await raceAgainstCallerAbort(readOnce(discoveries, prefix, async () => {
      const discovery = await measure(reads => reads.listGraphsByPrefix(prefix));
      budget?.consumeBytes(discovery.byteCount); return discovery.snapshot;
    }), options?.signal)],
    signal: options?.signal,
    materializationBudget: budget,
    withWithheldGraphRoots: roots => createStoreReadLane(store, { ...options, withheldGraphRoots: [...roots] }, budget),
    catalog,
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

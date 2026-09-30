import type {
  QueryOptions as StoreQueryOptions,
  QueryResult as StoreQueryResult,
  TripleStore,
} from '@origintrail-official/dkg-storage';
import type { QueryOptions } from './query-engine.js';
import { QueryMaterializationTooLargeError } from './query-materialization-error.js';

interface MaterializationMeter {
  consume(value: unknown): void;
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

export interface StoreReadLane {
  query(sparql: string): Promise<StoreQueryResult>;
  listGraphsByPrefix(prefix: string): Promise<string[]>;
  listGraphFamily(rootGraph: string): Promise<string[]>;
}

export interface QueryStoreReadContext extends StoreReadLane {
  readonly signal: AbortSignal | undefined;
  readonly materializationBudget: QueryMaterializationBudget | undefined;
  readonly shared: StoreReadLane & {
    readonly options: StoreQueryOptions | undefined;
    readonly cacheKey: string;
  };
}

function storeOptions(options: QueryOptions | undefined): StoreQueryOptions | undefined {
  if (
    !options?.signal
    && !options?.priority
    && !options?.source
    && options?.maxResponseBytes === undefined
  ) return undefined;
  return {
    signal: options.signal,
    priority: options.priority,
    source: options.source,
    maxResponseBytes: options.maxResponseBytes,
  };
}

function sharedDiscoveryStoreOptions(
  options: StoreQueryOptions | undefined,
): StoreQueryOptions | undefined {
  if (!options?.priority && !options?.source && options?.maxResponseBytes === undefined) {
    return undefined;
  }
  return {
    priority: options.priority,
    source: options.source,
    maxResponseBytes: options.maxResponseBytes,
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
  if (await store.hasGraph(rootGraph, options)) graphs.unshift(rootGraph);
  return graphs;
}

export function createStoreReadLane(
  store: TripleStore,
  options: StoreQueryOptions | undefined,
  meter: MaterializationMeter | undefined,
): StoreReadLane {
  const measured = async <T>(read: () => Promise<T>): Promise<T> => {
    const value = await read();
    meter?.consume(value);
    return value;
  };
  return {
    query: (sparql) => measured(() => store.query(sparql, options)),
    listGraphsByPrefix: (prefix) => measured(() => listGraphsByPrefix(store, prefix, options)),
    listGraphFamily: (rootGraph) => measured(() => listGraphFamily(store, rootGraph, options)),
  };
}

export function createQueryStoreReadContext(
  store: TripleStore,
  queryOptions: QueryOptions | undefined,
): QueryStoreReadContext {
  const options = storeOptions(queryOptions);
  const budget = queryOptions?.materializationBudget
    ?? (queryOptions?.maxMaterializedBytes === undefined
      ? undefined
      : new QueryMaterializationBudget(queryOptions.maxMaterializedBytes));
  const lane = createStoreReadLane(store, options, budget);
  const sharedOptions = sharedDiscoveryStoreOptions(options);
  return {
    ...lane,
    signal: options?.signal,
    materializationBudget: budget,
    shared: {
      ...createStoreReadLane(store, sharedOptions, undefined),
      options: sharedOptions,
      cacheKey: JSON.stringify([
        sharedOptions?.priority ?? 'normal',
        sharedOptions?.source ?? null,
        sharedOptions?.maxResponseBytes ?? null,
      ]),
    },
  };
}

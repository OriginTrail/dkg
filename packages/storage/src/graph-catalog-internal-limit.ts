// SPDX-License-Identifier: Apache-2.0
import { createOperationContext, getMetrics, Logger } from '@origintrail-official/dkg-core';
import { assertGraphCatalogWithinResponseLimit } from './graph-catalog-response-limit.js';
import { isStoreResponseTooLargeError } from './http-response-limit.js';
import type { QueryOptions } from './triple-store.js';

/**
 * The node's graph catalog is node state, not work done for one caller. Every
 * full read of it (a seed, a warm revalidation, a dirty rebuild, an adapter's
 * `listGraphs`, the read behind a store without a prefix listing) is bounded
 * by this internal ceiling, for both the store response and the in-memory
 * measurement. A caller's own byte limit bounds only what that caller receives:
 * its prefix slice, or the complete list when it asked for no prefix.
 */
export const STORE_GRAPH_CATALOG_LIMIT_NAME = 'STORE_GRAPH_CATALOG_MAX_BYTES';
export const DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES = 256 * 1024 * 1024;
/** Overrides the ceiling, in bytes. Anything but a positive safe integer keeps the default. */
export const STORE_GRAPH_CATALOG_MAX_BYTES_ENV = 'DKG_STORE_GRAPH_CATALOG_MAX_BYTES';

/** The configured ceiling, read at each use so that a process sees one value everywhere. */
export function storeGraphCatalogMaxBytes(): number {
  const raw = process.env[STORE_GRAPH_CATALOG_MAX_BYTES_ENV]?.trim();
  if (!raw) return DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_STORE_GRAPH_CATALOG_MAX_BYTES;
}

export const STORE_INTERNAL_LIMIT = 'STORE_INTERNAL_LIMIT';

export interface StoreInternalLimitErrorLike {
  readonly code: typeof STORE_INTERNAL_LIMIT;
  readonly limitName: string;
  readonly limitBytes: number;
  readonly actualBytes: number;
  readonly message: string;
}

/**
 * The node's own state passed one of its internal limits. It never describes the
 * caller's request, so it must not be answered as a request-size error; the
 * daemon answers it as a retryable 503 with this code.
 */
export class StoreInternalLimitError extends Error implements StoreInternalLimitErrorLike {
  readonly code = STORE_INTERNAL_LIMIT;
  readonly limitName: string;
  readonly limitBytes: number;
  readonly actualBytes: number;

  constructor(limitName: string, limitBytes: number, actualBytes: number | bigint) {
    const actual = typeof actualBytes === 'bigint'
      ? (actualBytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(actualBytes))
      : actualBytes;
    super(`Node-side limit ${limitName} reached: found ${actual} bytes, limit ${limitBytes}`);
    this.name = 'StoreInternalLimitError';
    this.limitName = limitName;
    this.limitBytes = limitBytes;
    this.actualBytes = actual;
  }
}

/** Structural, because worker and package boundaries do not preserve prototypes. */
export function isStoreInternalLimitError(error: unknown): error is StoreInternalLimitErrorLike {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Partial<Record<keyof StoreInternalLimitErrorLike, unknown>>;
  return candidate.code === STORE_INTERNAL_LIMIT
    && typeof candidate.limitName === 'string'
    && isByteCount(candidate.limitBytes)
    && isByteCount(candidate.actualBytes)
    && typeof candidate.message === 'string';
}

const KNOWN_LIMIT_NAMES: ReadonlySet<string> = new Set([STORE_GRAPH_CATALOG_LIMIT_NAME]);

/** Count one node-side limit hit. The label is a fixed set of limit names. */
export function recordStoreInternalLimit(limitName: string): void {
  try {
    getMetrics().queryInternalLimitTotal.add(1, { limit: KNOWN_LIMIT_NAMES.has(limitName) ? limitName : 'other' });
  } catch {
    // Telemetry must never change a read's outcome.
  }
}

/** How often a graph catalog warning repeats while its condition holds. */
export const GRAPH_CATALOG_WARNING_REPEAT_MS = 60 * 60_000;

/**
 * The start of the graph catalog's warning at one level of its limit. The observability alert
 * on the 80 % warning matches this text (`graphCatalogLimitWarning` in
 * tools/observability/lib/queries.mjs).
 */
export function graphCatalogLimitWarningStart(percent: number): string {
  return `The graph catalog has reached ${percent}% of its internal limit ${STORE_GRAPH_CATALOG_LIMIT_NAME}`;
}

const catalogLog = new Logger('graph-catalog');

/** The node's log sinks, at WARN, from the graph-catalog module. */
export function logGraphCatalogWarning(message: string): void {
  catalogLog.warn(createOperationContext('system'), message);
}

interface GraphCatalogWarningOptions {
  /** Monotonic milliseconds. */
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

/**
 * The warning for catalog reads the limit refuses: once, then again an hour later while reads
 * are still refused. It starts as the 80 % warning does, so the alert on that warning stays
 * raised while the catalog is over its limit, and clears only once reads stop being refused.
 */
export function createGraphCatalogOverLimitWarning(
  options: GraphCatalogWarningOptions = {},
): (limit: Pick<StoreInternalLimitErrorLike, 'limitBytes' | 'actualBytes'>) => void {
  const now = options.now ?? (() => performance.now());
  const warn = options.warn ?? logGraphCatalogWarning;
  let lastAt: number | undefined;
  return (limit) => {
    const at = now();
    if (lastAt !== undefined && at - lastAt >= 0 && at - lastAt < GRAPH_CATALOG_WARNING_REPEAT_MS) return;
    lastAt = at;
    warn(`${graphCatalogLimitWarningStart(80)}, and is over it: at least ${limit.actualBytes} of ${limit.limitBytes} bytes. `
      + `Catalog reads fail with ${STORE_INTERNAL_LIMIT} until the limit is raised: store.graphCatalog.maxBytes or ${STORE_GRAPH_CATALOG_MAX_BYTES_ENV}.`);
  };
}

const warnGraphCatalogOverLimit = createGraphCatalogOverLimitWarning();

/** Count a read a node-side limit refused, and warn when the limit is the graph catalog's. */
export function recordStoreInternalLimitError(limit: StoreInternalLimitErrorLike): void {
  recordStoreInternalLimit(limit.limitName);
  if (limit.limitName !== STORE_GRAPH_CATALOG_LIMIT_NAME) return;
  try {
    warnGraphCatalogOverLimit(limit);
  } catch {
    // A log sink must never change a read's outcome.
  }
}

/** The error for a catalog read the limit refused, counted and warned about. */
function refusedByGraphCatalogLimit(limitBytes: number, actualBytes: number | bigint): StoreInternalLimitError {
  const limit = new StoreInternalLimitError(STORE_GRAPH_CATALOG_LIMIT_NAME, limitBytes, actualBytes);
  recordStoreInternalLimitError(limit);
  return limit;
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Options for one full catalog read: the caller's cancellation, lane (priority
 * and control queue) and label, with the internal ceiling in place of the
 * caller's byte limits. Nothing else of the caller's query applies to a catalog.
 */
export function internalCatalogReadOptions(options?: QueryOptions): QueryOptions {
  const ceiling = storeGraphCatalogMaxBytes();
  return {
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(options?.priority === undefined ? {} : { priority: options.priority }),
    ...(options?.controlQueue === undefined ? {} : { controlQueue: options.controlQueue }),
    ...(options?.source === undefined ? {} : { source: options.source }),
    maxResponseBytes: ceiling,
    maxLiteralHydrationBytes: ceiling,
  };
}

/**
 * Run one full catalog read under the internal ceiling. A too-large answer from
 * it is the node's limit, never the caller's, so it is rethrown as one.
 */
export async function readCompleteGraphCatalog<T>(
  options: QueryOptions | undefined,
  read: (internal: QueryOptions) => Promise<T>,
): Promise<T> {
  try {
    return await read(internalCatalogReadOptions(options));
  } catch (error) {
    if (!isStoreResponseTooLargeError(error)) throw error;
    throw refusedByGraphCatalogLimit(error.maxBytes, error.actualBytes);
  }
}

/** Bound a complete catalog held in memory by the internal ceiling. */
export function assertGraphCatalogWithinInternalLimit(graphs: readonly string[]): void {
  const ceiling = storeGraphCatalogMaxBytes();
  try {
    assertGraphCatalogWithinResponseLimit(graphs, ceiling);
  } catch (error) {
    if (!isStoreResponseTooLargeError(error)) throw error;
    throw refusedByGraphCatalogLimit(ceiling, error.actualBytes);
  }
}

/** The same bound for a catalog whose size is already measured. */
export function assertMeasuredGraphCatalogWithinInternalLimit(bytes: number): void {
  const ceiling = storeGraphCatalogMaxBytes();
  if (bytes <= ceiling) return;
  throw refusedByGraphCatalogLimit(ceiling, bytes);
}

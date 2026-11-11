// SPDX-License-Identifier: Apache-2.0
import { getMetrics } from '@origintrail-official/dkg-core';
import {
  STORE_GRAPH_CATALOG_LIMIT_NAME,
  STORE_GRAPH_CATALOG_MAX_BYTES_ENV,
  isStoreInternalLimitError,
  storeGraphCatalogMaxBytes,
} from './graph-catalog-internal-limit.js';
import type { GraphSetRefreshSource } from './graph-set-index-types.js';

/** A bounded label: one full scan of the catalog is a seed, a warm revalidation or a dirty rebuild. */
type GraphCatalogRefreshKind = 'seed' | 'revalidate' | 'rebuild';

export function graphCatalogRefreshKind(source: GraphSetRefreshSource): GraphCatalogRefreshKind {
  return source === 'seed' || source === 'revalidate' ? source : 'rebuild';
}

/** A bounded failure reason; never an error message. */
function refreshFailureReason(error: unknown): string {
  if (isStoreInternalLimitError(error)) return 'internal_limit';
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'STORE_OPERATION_TIMEOUT') return 'timeout';
  if (code === 'STORE_SCHEDULER_BUSY') return 'busy';
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return 'aborted';
  return 'error';
}

/** Time one full catalog scan: its duration, and a failure by kind and reason. */
export async function timeGraphCatalogRefresh<T>(kind: GraphCatalogRefreshKind, scan: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await scan();
    recordRefresh(kind, startedAt);
    return result;
  } catch (error) {
    recordRefresh(kind, startedAt, error);
    throw error;
  }
}

function recordRefresh(kind: GraphCatalogRefreshKind, startedAt: number, error?: unknown): void {
  try {
    const metrics = getMetrics();
    metrics.storeGraphCatalogRefreshMs.record(Math.max(0, performance.now() - startedAt),
      { kind, outcome: error === undefined ? 'ok' : 'error' });
    if (error !== undefined) {
      metrics.storeGraphCatalogRefreshFailuresTotal.add(1, { kind, reason: refreshFailureReason(error) });
    }
  } catch {
    // Telemetry must never fail a catalog read.
  }
}

const WARNING_PERCENTS = [80, 50] as const;
const WARNING_REPEAT_MS = 60 * 60_000;

interface GraphCatalogSizeWarningsOptions {
  /** Monotonic milliseconds. */
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

/**
 * Gauges for a published catalog, and a warning when it reaches 50 % and 80 %
 * of the internal ceiling: once when it reaches a level, again an hour later
 * while it stays there.
 */
export function createGraphCatalogSizeRecorder(
  options: GraphCatalogSizeWarningsOptions = {},
): (size: { readonly graphs: number; readonly bytes: number } | null) => void {
  const now = options.now ?? (() => performance.now());
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let last: { percent: number; at: number } | undefined;
  return (size) => {
    if (size === null) return;
    try {
      const metrics = getMetrics();
      metrics.storeGraphCatalogGraphs.record(size.graphs);
      metrics.storeGraphCatalogBytes.record(size.bytes);
      metrics.storeGraphsTotal.record(size.graphs);
    } catch {
      // Telemetry must never fail a catalog read.
    }
    const ceiling = storeGraphCatalogMaxBytes();
    const percent = WARNING_PERCENTS.find(level => size.bytes * 100 >= ceiling * level);
    if (percent === undefined) {
      last = undefined;
      return;
    }
    const at = now();
    if (last && last.percent >= percent && at - last.at >= 0 && at - last.at < WARNING_REPEAT_MS) return;
    last = { percent, at };
    warn(`[graph-catalog] The graph catalog has reached ${percent}% of its internal limit `
      + `${STORE_GRAPH_CATALOG_LIMIT_NAME}: ${size.bytes} of ${ceiling} bytes, ${size.graphs} graphs. `
      + `At the limit, catalog reads fail with STORE_INTERNAL_LIMIT; raise ${STORE_GRAPH_CATALOG_MAX_BYTES_ENV} before then.`);
  };
}

export const recordGraphCatalogSize = createGraphCatalogSizeRecorder();

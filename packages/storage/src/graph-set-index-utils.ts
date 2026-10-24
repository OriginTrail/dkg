// SPDX-License-Identifier: Apache-2.0
import type { Quad, QueryOptions, UpdateOptions } from "./triple-store.js";
export function namedGraphsFromQuads(quads: Quad[]): string[] {
  return [...new Set(quads.map((quad) => quad.graph).filter(Boolean))];
}

export function endsWithHighSurrogate(value: string): boolean {
  if (value.length === 0) return false;
  const lastCodeUnit = value.charCodeAt(value.length - 1);
  return lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF;
}

/** Filter falsy entries and de-duplicate a caller-supplied graph-URI hint list. */
export function normalizeGraphUris(graphs: readonly string[]): string[] {
  return [...new Set(graphs.filter(Boolean))];
}

/**
 * Drop the update-only `touchedGraphs` hint, yielding the read-path `QueryOptions`
 * (source/priority/signal) to forward to index-maintenance reads (`hasGraph`) — so
 * the update-only field never crosses into a read call via structural assignability.
 */
export function queryOptionsFromUpdateOptions(options: UpdateOptions): QueryOptions {
  const { touchedGraphs: _touchedGraphs, ...readOptions } = options;
  return readOptions;
}

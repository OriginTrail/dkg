// SPDX-License-Identifier: Apache-2.0

/**
 * Reading the read-graph state rows a store holds, below the read-graph
 * layer: all of them at once, or one read graph's. Only rows in a context
 * graph's own state graph count, as for every enumeration; the parsing and
 * the statements are the state model's (`./state.ts`).
 */

import { isReadGraphStateGraph } from '../graph-enumeration-visibility.js';
import type { QueryOptions, TripleStore } from '../triple-store.js';
import { parseReadGraphStateRows, readGraphStateRowQuery, readGraphStateRowsQuery, type ReadGraphStateRow } from './state.js';

/**
 * The state rows a store holds, read with one lookup below the read-graph
 * layer: only rows in a context graph's own state graph count, as for every
 * enumeration. The bindings come back with the rows and the damaged read
 * graphs, for a caller that writes damaged rows again from them.
 */
export async function readStoredReadGraphStates(store: TripleStore, options: QueryOptions = {}): Promise<{
  readonly bindings: readonly Readonly<Record<string, string | undefined>>[];
  readonly rows: ReadGraphStateRow[];
  readonly damaged: string[];
}> {
  const result = await store.query(readGraphStateRowsQuery(), options);
  if (result.type !== 'bindings') throw new Error('A read-graph state read expected state-row bindings');
  const bindings = result.bindings.filter((binding) => binding.stateGraph !== undefined && isReadGraphStateGraph(binding.stateGraph));
  return { bindings, ...parseReadGraphStateRows(bindings) };
}

/**
 * The stored row of one read graph, read below the layer. `damaged` when its
 * row is damaged or misplaced.
 */
export async function readStoredReadGraphRow(
  store: TripleStore,
  readGraph: string,
  options: QueryOptions = {},
): Promise<{ readonly row: ReadGraphStateRow | undefined; readonly damaged: boolean }> {
  const result = await store.query(readGraphStateRowQuery(readGraph), options);
  if (result.type !== 'bindings') throw new Error('A read-graph state read expected bindings');
  const bindings = result.bindings.filter((binding) => binding.readGraph === readGraph
    && binding.stateGraph !== undefined && isReadGraphStateGraph(binding.stateGraph));
  const { rows, damaged } = parseReadGraphStateRows(bindings);
  return { row: rows[0], damaged: damaged.length > 0 };
}

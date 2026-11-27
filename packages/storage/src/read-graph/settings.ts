// SPDX-License-Identifier: Apache-2.0

/**
 * The node's read-graph settings, as every store object over a backend sees
 * them: where read graphs are kept (`query.readGraphs`) and what a view query
 * without `semantics` gets (`query.viewSemantics`). The CLI resolves both from
 * config.json (`cli/src/read-graphs-config.ts`), and the read-graph layer
 * keeps them on its backend runtime.
 *
 * A mode applies to a context graph and a memory layer:
 * - `off`: no read graphs;
 * - `build`: read graphs are built, maintained and checked, and no query reads
 *   them;
 * - `serve`: merged view queries read them.
 *
 * The settings choose what is built and what is served. They do not decide
 * what is maintained: the layer maintains every read graph that has a state
 * row, whatever its mode.
 */

import type { MemoryLayer, ReadGraphKey } from '@origintrail-official/dkg-core';

export type ReadGraphMode = 'off' | 'build' | 'serve';
export const READ_GRAPH_MODES: readonly ReadGraphMode[] = Object.freeze(['off', 'build', 'serve']);

/** A mode for each memory layer, over a default for the others. */
export interface ReadGraphModeRule {
  readonly default?: ReadGraphMode;
  readonly layers?: Readonly<Partial<Record<MemoryLayer, ReadGraphMode>>>;
}

/** The node's rule, and rules for single context graphs that take precedence over it. */
export interface ReadGraphModes extends ReadGraphModeRule {
  readonly contextGraphs?: Readonly<Record<string, ReadGraphModeRule>>;
}

/**
 * The mode of one read graph. The most specific setting wins: the context
 * graph's mode for the layer, then the context graph's default, then the
 * node's mode for the layer, then the node's default, then `off`. The read
 * graphs of a sub-graph follow their context graph, and the working-memory
 * mode covers every agent.
 *
 * `off` stops building and serving, not maintenance: the layer maintains every
 * read graph that has a state row. When a read graph's mode goes to `off`, the
 * builder drops it (a fenced drop) and removes its row, or every write that
 * touches its members keeps paying for it.
 */
export function readGraphModeOf(modes: ReadGraphModes | undefined, key: ReadGraphKey): ReadGraphMode {
  const contextGraph = ownValue(modes?.contextGraphs, key.scope.contextGraphId);
  return ownValue(contextGraph?.layers, key.layer)
    ?? contextGraph?.default
    ?? ownValue(modes?.layers, key.layer)
    ?? modes?.default
    ?? 'off';
}

/** Whether the settings keep any read graph: some mode other than `off`. */
export function keepsAnyReadGraph(modes: ReadGraphModes | undefined): boolean {
  const rules = [modes, ...Object.values(modes?.contextGraphs ?? {})];
  return rules.some((rule) =>
    (rule?.default !== undefined && rule.default !== 'off')
    || Object.values(rule?.layers ?? {}).some((mode) => mode !== 'off'));
}

/**
 * How a view query matches its patterns when it does not ask: `per-asset`
 * (every pattern inside one asset graph) or `merged` (the view's asset graphs
 * as one set of triples). The same values as the request option.
 */
export type ViewSemantics = 'per-asset' | 'merged';
export const VIEW_SEMANTICS: readonly ViewSemantics[] = Object.freeze(['per-asset', 'merged']);

/** The node's default, and defaults for single context graphs. */
export interface ViewSemanticsSettings {
  readonly default?: ViewSemantics;
  readonly contextGraphs?: Readonly<Record<string, ViewSemantics>>;
}

/** What a view query without `semantics` gets on a context graph: its own setting, the node's, or `per-asset`. */
export function viewSemanticsOf(settings: ViewSemanticsSettings | undefined, contextGraphId: string): ViewSemantics {
  return ownValue(settings?.contextGraphs, contextGraphId) ?? settings?.default ?? 'per-asset';
}

/** A record's own entry, so that a key such as `__proto__` or `constructor` names nothing it inherits. */
function ownValue<V>(record: Readonly<Record<string, V>> | Readonly<Partial<Record<string, V>>> | undefined, key: string): V | undefined {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

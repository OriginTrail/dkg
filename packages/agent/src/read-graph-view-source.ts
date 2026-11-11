// SPDX-License-Identifier: Apache-2.0
import type { ViewReadGraphs } from '@origintrail-official/dkg-query';
import { readGraphLayerOf, readGraphModeOf, viewSemanticsOf } from '@origintrail-official/dkg-storage';

/**
 * The read graphs that merged view queries may read on this node, taken from
 * its store's read-graph layer:
 * - a read graph is kept for merged queries only where the node serves it:
 *   `query.readGraphs` is `serve` for its context graph and layer;
 * - its state is the row in the backend's process-wide mirror;
 * - the working-memory identity rule and the default semantics
 *   (`query.viewSemantics`) are the runtime's.
 *
 * Every field reads the runtime when it is called, so a setting, a rule or a
 * row that changes later is seen. A store without a read-graph layer has no
 * source, and every view query on it is per asset.
 */
export function viewReadGraphsOf(store: unknown): ViewReadGraphs | undefined {
  const runtime = readGraphLayerOf(store)?.runtime;
  if (runtime === undefined) return undefined;
  return {
    keeps: (key) => readGraphModeOf(runtime.modes, key) === 'serve',
    state: (readGraph) => runtime.mirror.get(readGraph),
    get identity() {
      return runtime.workingMemoryIdentity;
    },
    defaultSemantics: (contextGraphId) => viewSemanticsOf(runtime.viewSemantics, contextGraphId),
  };
}

// SPDX-License-Identifier: Apache-2.0
import type { Quad } from '../triple-store.js';
import type { GraphWriteScope } from '../graph-write-gen.js';

/** Every atomic replacement is one tracked worker message to embedded Oxigraph. */
export function workerAtomicReplacements(
  dispatch: (scope: GraphWriteScope, method: string, args: unknown[]) => Promise<void>,
) {
  return {
    replaceGraph: (graph: string, quads: Quad[]) => dispatch({ kind: 'graphs', graphs: [graph] }, 'replaceGraph', [graph, quads]),
    replaceGraphAndSubject: (graph: string, quads: Quad[], meta: string, subject: string, metadata: Quad[]) =>
      dispatch({ kind: 'graphs', graphs: [graph, meta] }, 'replaceGraphAndSubject', [graph, quads, meta, subject, metadata]),
    // The worker dispatch is generic (`store[method](...args)`), so this routes
    // to the worker's embedded OxigraphStore.replaceSubject — one atomic
    // single-message commit, same contract as insert/replaceGraph.
    replaceSubject: (graph: string, subject: string, quads: Quad[]) =>
      dispatch({ kind: 'graphs', graphs: [graph] }, 'replaceSubject', [graph, subject, quads]),
    replaceSubjectPredicates: (graph: string, subject: string, predicates: readonly string[], quads: Quad[]) =>
      dispatch({ kind: 'graphs', graphs: [graph] }, 'replaceSubjectPredicates', [graph, subject, predicates, quads]),
  };
}

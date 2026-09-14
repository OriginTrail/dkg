// SPDX-License-Identifier: Apache-2.0

import {
  contextGraphDataGraphUri,
  DKG_ONTOLOGY,
  parseContextGraphUri,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import { runBoundedOperation } from './bounded-operation.js';
import {
  assertUnscopedQueryCandidateLimit,
  listStoredContextGraphQueryCandidates,
  UNSCOPED_QUERY_ADMISSION_TIMEOUT_MS,
  type ContextGraphQueryStore,
} from './context-graph-query-candidates.js';
import { strip } from './dkg-agent-utils.js';
import { mapWithConcurrency } from './map-with-concurrency.js';

export interface UnscopedQueryAdmissionDependencies {
  store: ContextGraphQueryStore;
  knownContextGraphIds: Iterable<string>;
  canReadContextGraph: (id: string, signal: AbortSignal) => Promise<boolean>;
}

/**
 * Arbitrary unscoped SPARQL is safe only when every possible stored owner is
 * readable. Discover the complete bounded candidate set before checking the
 * same read authority used for scoped queries; metadata alone grants nothing.
 */
export async function canReadUnscopedQuery(
  deps: UnscopedQueryAdmissionDependencies,
  opts: { signal?: AbortSignal } = {},
): Promise<boolean> {
  return runBoundedOperation(async (boundarySignal) => {
    // Cancel sibling checks on any failure as well as caller abort/deadline.
    const stop = new AbortController();
    const signal = AbortSignal.any([boundarySignal, stop.signal]);
    try {
      signal.throwIfAborted();
      const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      const result = await deps.store.query(
        `SELECT ?cg WHERE {
          GRAPH <${ontologyGraph}> {
            ?cg <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> "private"
          }
        }`,
        { source: 'agent.query.privateGraphAccessPolicy', signal },
      );
      signal.throwIfAborted();
      if (result.type !== 'bindings') {
        throw new Error('Cannot authorize unscoped query: invalid access-policy discovery result');
      }

      const candidates = new Set<string>();
      const addCandidate = (id: string) => {
        signal.throwIfAborted();
        candidates.add(id);
        assertUnscopedQueryCandidateLimit(candidates.size);
      };
      for (const row of result.bindings) {
        const cgUri = row['cg'];
        const id = cgUri ? parseContextGraphUri(strip(cgUri)) : undefined;
        if (id === undefined) {
          throw new Error('Cannot authorize unscoped query: unrecognized explicit private Context Graph');
        }
        addCandidate(id);
      }
      for (const id of deps.knownContextGraphIds) addCandidate(id);
      signal.throwIfAborted();
      for (const id of await listStoredContextGraphQueryCandidates(deps.store, { signal })) {
        addCandidate(id);
      }
      signal.throwIfAborted();

      const readable = await mapWithConcurrency([...candidates], 4, async (id) => {
        signal.throwIfAborted();
        const allowed = await deps.canReadContextGraph(id, signal);
        signal.throwIfAborted();
        return allowed;
      });
      signal.throwIfAborted();
      return readable.every(Boolean);
    } finally {
      stop.abort();
    }
  }, {
    timeoutMs: UNSCOPED_QUERY_ADMISSION_TIMEOUT_MS,
    label: 'Unscoped query admission; specify contextGraphId to limit the dataset',
    signal: opts.signal,
  });
}

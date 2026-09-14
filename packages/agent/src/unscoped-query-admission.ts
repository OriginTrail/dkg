// SPDX-License-Identifier: Apache-2.0

import {
  contextGraphDataGraphUri,
  DKG_ONTOLOGY,
  parseContextGraphUri,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import { runBoundedOperation } from './bounded-operation.js';
import {
  listStoredContextGraphQueryCandidates,
  UNSCOPED_QUERY_ADMISSION_TIMEOUT_MS,
  type ContextGraphQueryStore,
} from './context-graph-query-candidates.js';
import { strip } from './dkg-agent-utils.js';
import { everyWithConcurrency } from './map-with-concurrency.js';

export interface UnscopedQueryAdmissionDependencies {
  store: ContextGraphQueryStore;
  knownContextGraphIds: Iterable<string>;
  canReadContextGraph: (id: string, signal: AbortSignal) => Promise<boolean>;
  prepareReadChecks?: (
    ids: readonly string[],
    signal: AbortSignal,
  ) => Promise<UnscopedQueryAdmissionDependencies['canReadContextGraph']>;
}

/**
 * Arbitrary unscoped SPARQL is safe only when every possible stored owner is
 * readable. Discover the complete candidate set before checking the
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
      const [result, storedIds] = await Promise.all([
        deps.store.query(
          `SELECT ?cg WHERE {
            GRAPH <${ontologyGraph}> {
              ?cg <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> "private"
            }
          }`,
          { source: 'agent.query.privateGraphAccessPolicy', signal },
        ),
        listStoredContextGraphQueryCandidates(deps.store, { signal }),
      ]);
      signal.throwIfAborted();
      if (result.type !== 'bindings') {
        throw new Error('Cannot authorize unscoped query: invalid access-policy discovery result');
      }

      const candidates = new Set<string>();
      const addCandidate = (id: string) => {
        signal.throwIfAborted();
        candidates.add(id);
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
      for (const id of storedIds) {
        addCandidate(id);
      }
      signal.throwIfAborted();

      const ids = [...candidates];
      // Preparation can share a complete fenced registration read and local
      // metadata discovery across ordinary KA partitions. It never truncates
      // owners or caches permission decisions beyond this admission request.
      const canRead = deps.prepareReadChecks
        ? await deps.prepareReadChecks(ids, signal)
        : deps.canReadContextGraph;
      signal.throwIfAborted();
      return await everyWithConcurrency(ids, 4, async (id) => {
        signal.throwIfAborted();
        const allowed = await canRead(id, signal);
        if (!allowed) {
          stop.abort(new Error('Unscoped query denied by Context Graph read authority'));
          return false;
        }
        signal.throwIfAborted();
        return true;
      });
    } finally {
      stop.abort();
    }
  }, {
    timeoutMs: UNSCOPED_QUERY_ADMISSION_TIMEOUT_MS,
    label: 'Unscoped query admission; specify contextGraphId to limit the dataset',
    signal: opts.signal,
  });
}

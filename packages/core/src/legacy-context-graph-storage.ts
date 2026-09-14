// SPDX-License-Identifier: Apache-2.0

import { validateSubGraphName } from './constants.js';

const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';

/**
 * Compatibility interpretations of an unsplit legacy scope: a raw CG ID and,
 * when its final segment is a legal flat subgraph, that subgraph's parent.
 * Validate each resulting owner independently: subgraph names permit bytes and
 * lengths that CG IDs do not, and exact tagged codecs have a separate grammar.
 */
export function legacyContextGraphScopeCandidates(scope: string): readonly string[] {
  const slash = scope.lastIndexOf('/');
  return slash > 0 && validateSubGraphName(scope.slice(slash + 1)).valid
    ? [scope, scope.slice(0, slash)]
    : [scope];
}

/**
 * Preserve bare legacy scopes and every possible underscore-partition prefix.
 * Existing CG IDs may themselves contain reserved segments, and historical
 * child partitions may predate today's exact codecs. None of those independent
 * interpretations can be discarded because metadata or a canonical decode is
 * missing. These are possible scopes, not declarations of registered owners.
 */
export function legacyContextGraphStorageScopes(uri: string): readonly string[] {
  if (!uri.startsWith(CONTEXT_GRAPH_PREFIX)) return [];
  const tail = uri.slice(CONTEXT_GRAPH_PREFIX.length);
  const scopes = [tail];
  // The lookahead preserves adjacent partitions without consuming the slash
  // that begins the next interpretation.
  for (const match of tail.matchAll(/\/(_[^/]*)(?=\/|$)/g)) {
    scopes.push(tail.slice(0, match.index));
  }
  return scopes;
}

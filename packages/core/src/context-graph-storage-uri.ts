// SPDX-License-Identifier: Apache-2.0

import {
  parseContextGraphAssertionStorageUri,
  parseContextGraphContextStorageUri,
  validateContextGraphId,
} from './constants.js';
import { assertionScopedGraphParentUri } from './assertion-scoped-graphs.js';
import {
  AuthorCatalogCodecError,
  parseCatalogAssertionScopeV1,
} from './author-catalog-codec.js';
import { parseWorkspaceSnapshotContextGraphId } from './context-graph-snapshot-uri.js';
import {
  legacyContextGraphScopeCandidates,
  legacyContextGraphStorageScopes,
} from './legacy-context-graph-storage.js';

const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';

/** Parse one exact legacy CG URI; RDF term delimiters are not part of an IRI. */
export function parseContextGraphUri(uri: string): string | undefined {
  if (!uri.startsWith(CONTEXT_GRAPH_PREFIX)) return undefined;
  const id = uri.slice(CONTEXT_GRAPH_PREFIX.length);
  return validateContextGraphId(id).valid ? id : undefined;
}

/**
 * Enumerate every legal owner interpretation of a stored CG graph URI.
 *
 * Existing IDs may contain slashes and reserved partition names. Consequently
 * a URI can simultaneously be a bare legacy root, a named subgraph, and a
 * partition of another root. Metadata presence cannot discard an interpretation.
 * Read admission must authorize every returned owner, including when authority
 * for an interpretation is unavailable. New-root validation is deliberately not
 * used: its stricter reserved-segment rule does not apply to existing data.
 * Tagged RFC-64 scopes use the catalog codec's exact canonical inverse. An
 * invalid tagged interpretation does not invalidate an independent legacy one.
 * Undefined means no legal interpretation; callers must fail closed for a
 * recognized CG URI with no owner candidates.
 */
export function contextGraphStorageOwnerCandidates(uri: string): readonly string[] | undefined {
  if (!uri.startsWith(CONTEXT_GRAPH_PREFIX)) return undefined;
  const owners = new Set<string>();
  const legacyScopes = legacyContextGraphStorageScopes(uri);
  const assertionGraphs = new Set(legacyScopes.map((scope) => `${CONTEXT_GRAPH_PREFIX}${scope}`));

  const addOwner = (id: string) => {
    if (validateContextGraphId(id).valid) owners.add(id);
  };
  const addExactScope = (scope: string) => {
    addOwner(scope);
    if (!scope.startsWith('v1/')) return;
    try {
      owners.add(parseCatalogAssertionScopeV1(scope).contextGraphId);
    } catch (error) {
      // A legal legacy root/subgraph may resemble an invalid tagged scope,
      // including percent sequences that are ordinary subgraph-name bytes.
      if (!(error instanceof AuthorCatalogCodecError)) throw error;
    }
  };
  const addScope = (scope: string) => {
    for (const candidate of legacyContextGraphScopeCandidates(scope)) addExactScope(candidate);
  };

  for (const scope of legacyScopes) addScope(scope);

  const context = parseContextGraphContextStorageUri(uri);
  if (context) addExactScope(context.contextGraphId);

  const namedGraphParent = assertionScopedGraphParentUri(uri);
  if (namedGraphParent !== undefined) assertionGraphs.add(namedGraphParent);
  // Historical assertion coordinates can also precede legacy child partitions.
  for (const graph of assertionGraphs) {
    const assertion = parseContextGraphAssertionStorageUri(graph);
    if (assertion) addScope(assertion.scope);
  }

  const snapshotOwner = parseWorkspaceSnapshotContextGraphId(uri);
  if (snapshotOwner !== undefined) owners.add(snapshotOwner);

  return owners.size === 0 ? undefined : Object.freeze([...owners]);
}

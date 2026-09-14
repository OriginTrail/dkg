// SPDX-License-Identifier: Apache-2.0

import {
  parseContextGraphAssertionUri,
  validateContextGraphId,
  validateSubGraphName,
} from './constants.js';
import {
  AuthorCatalogCodecError,
  parseCatalogAssertionScopeV1,
} from './author-catalog-codec.js';
import { parseWorkspaceSnapshotContextGraphId } from './context-graph-snapshot-uri.js';

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
  const tail = uri.slice(CONTEXT_GRAPH_PREFIX.length);
  const owners = new Set<string>();

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
    addExactScope(scope);
    const slash = scope.lastIndexOf('/');
    if (slash > 0 && validateSubGraphName(scope.slice(slash + 1)).valid) {
      // Validate independently: adding a legal flat subgraph can exceed the CG
      // length limit or introduce characters legal only in subgraph names.
      addExactScope(scope.slice(0, slash));
    }
  };

  addScope(tail);

  // A legacy root may itself contain one or more underscore segments. Use a
  // lookahead so adjacent partitions are all examined without consuming the
  // slash that starts the next interpretation.
  for (const match of tail.matchAll(/\/(_[^/]*)(?=\/|$)/g)) {
    addScope(tail.slice(0, match.index));
  }

  const context = /^(.*)\/context\/([^/]+)(?:\/_meta)?$/.exec(tail);
  if (context) addExactScope(context[1]);

  const assertion = parseContextGraphAssertionUri(uri);
  if (assertion) addScope(assertion.scope);

  const snapshotOwner = parseWorkspaceSnapshotContextGraphId(uri);
  if (snapshotOwner !== undefined) owners.add(snapshotOwner);

  return owners.size === 0 ? undefined : Object.freeze([...owners]);
}

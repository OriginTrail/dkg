// SPDX-License-Identifier: Apache-2.0

import {
  parseContextGraphAssertionUri,
  validateContextGraphId,
  validateSubGraphName,
} from './constants.js';

const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';

/** A storage shape is an interpretation, never evidence of read permission. */
export type ContextGraphStorageShape =
  | { readonly kind: 'bare'; readonly scope: string }
  | { readonly kind: 'partition'; readonly scope: string; readonly partition: string }
  | { readonly kind: 'context'; readonly scope: string; readonly contextId: string }
  | { readonly kind: 'assertion'; readonly scope: string }
  | { readonly kind: 'encoded'; readonly contextGraphId: string; readonly subGraphName?: string };

export interface ContextGraphStorageUri {
  readonly shapes: readonly ContextGraphStorageShape[];
  readonly ownerContextGraphIds: readonly string[];
}

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
 * Malformed percent encoding in a tagged RFC-64 scope throws so callers cannot
 * mistake an unreadable owner coordinate for an empty inventory.
 */
export function parseContextGraphStorageUri(uri: string): ContextGraphStorageUri | undefined {
  if (!uri.startsWith(CONTEXT_GRAPH_PREFIX)) return undefined;
  const tail = uri.slice(CONTEXT_GRAPH_PREFIX.length);
  const owners = new Set<string>();
  const shapes: ContextGraphStorageShape[] = [];

  const record = (shape: ContextGraphStorageShape, ids: readonly string[]) => {
    if (ids.length === 0) return;
    shapes.push(Object.freeze(shape));
    for (const id of ids) owners.add(id);
  };
  const exactOwner = (id: string): string[] => validateContextGraphId(id).valid ? [id] : [];
  const scopeOwners = (scope: string): string[] => {
    const ids = exactOwner(scope);
    const slash = scope.lastIndexOf('/');
    if (slash > 0 && validateSubGraphName(scope.slice(slash + 1)).valid) {
      // Validate independently: adding a legal flat subgraph can exceed the CG
      // length limit or introduce characters legal only in subgraph names.
      ids.push(...exactOwner(scope.slice(0, slash)));
    }
    return ids;
  };

  record({ kind: 'bare', scope: tail }, scopeOwners(tail));

  // A legacy root may itself contain one or more underscore segments. Use a
  // lookahead so adjacent partitions are all examined without consuming the
  // slash that starts the next interpretation.
  for (const match of tail.matchAll(/\/(_[^/]*)(?=\/|$)/g)) {
    const scope = tail.slice(0, match.index);
    record({ kind: 'partition', scope, partition: match[1] }, scopeOwners(scope));
  }

  const context = /^(.*)\/context\/([^/]+)(?:\/_meta)?$/.exec(tail);
  if (context) {
    record({ kind: 'context', scope: context[1], contextId: context[2] }, exactOwner(context[1]));
  }

  const assertion = parseContextGraphAssertionUri(uri);
  if (assertion) {
    record({ kind: 'assertion', scope: assertion.scope }, scopeOwners(assertion.scope));
  }

  const encoded = /^v1\/(root|subgraph)\/([^/]+)(?:\/([^/]+))?/.exec(tail);
  if (encoded) {
    const contextGraphId = decodeURIComponent(encoded[2]);
    const subGraphName = encoded[1] === 'subgraph' && encoded[3] !== undefined
      ? decodeURIComponent(encoded[3])
      : undefined;
    if (
      validateContextGraphId(contextGraphId).valid
      && (encoded[1] === 'root' || (subGraphName !== undefined && validateSubGraphName(subGraphName).valid))
    ) {
      record({
        kind: 'encoded',
        contextGraphId,
        ...(subGraphName === undefined ? {} : { subGraphName }),
      }, [contextGraphId]);
    }
  }

  if (owners.size === 0) return undefined;
  return Object.freeze({
    shapes: Object.freeze(shapes),
    ownerContextGraphIds: Object.freeze([...owners]),
  });
}

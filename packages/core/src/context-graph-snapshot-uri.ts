// SPDX-License-Identifier: Apache-2.0

import { validateContextGraphId } from './constants.js';
import {
  AuthorLaneScopeErrorV1,
  assertAuthorLaneContextGraphIdV1,
} from './author-lane-scope-v1.js';
import { assertSafeIri } from './sparql-safe.js';

const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';

/** Existing entity-snapshot format; preserve its encodeURIComponent contract. */
export function workspaceOperationPublicSnapshotGraph(
  contextGraphId: string,
  shareOperationId: string,
  rootEntity: string,
  subGraphName?: string,
): string {
  const parts = [contextGraphId, subGraphName ?? '_', shareOperationId, rootEntity]
    .map((part) => encodeURIComponent(part));
  const graph = `${CONTEXT_GRAPH_PREFIX}${parts[0]}/_shared_memory_snapshots/${parts[1]}/${parts[2]}/${parts[3]}/_shared_memory`;
  assertSafeIri(graph);
  return graph;
}

/** Existing complete-KA snapshot format used by publish and SWM recovery. */
export function workspaceKnowledgeAssetOperationSnapshotGraph(
  contextGraphId: string,
  shareOperationId: string,
  subGraphName?: string,
): string {
  const parts = [contextGraphId, subGraphName ?? '_', shareOperationId]
    .map((part) => encodeURIComponent(part));
  const graph = `${CONTEXT_GRAPH_PREFIX}${parts[0]}/_shared_memory_snapshots/${parts[1]}/${parts[2]}/ka`;
  assertSafeIri(graph);
  return graph;
}

/**
 * Exact owner inverse of the two legacy snapshot graph formats above.
 * Their encoding predates the RFC-64 catalog component codec. Decode only this
 * complete family, and require its own encoder's canonical round trip.
 */
export function parseWorkspaceSnapshotContextGraphId(uri: string): string | undefined {
  if (!uri.startsWith(CONTEXT_GRAPH_PREFIX)) return undefined;
  const parts = uri.slice(CONTEXT_GRAPH_PREFIX.length).split('/');
  if (
    parts[1] !== '_shared_memory_snapshots'
    || !((parts.length === 5 && parts[4] === 'ka')
      || (parts.length === 6 && parts[5] === '_shared_memory'))
  ) return undefined;

  const components = [parts[0], parts[2], parts[3]];
  if (parts.length === 6) components.push(parts[4]);
  const decoded: string[] = [];
  try {
    for (const component of components) {
      const value = decodeURIComponent(component);
      if (encodeURIComponent(value) !== component) return undefined;
      decoded.push(value);
    }
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
  // Both legacy and RFC64 callers persist these formats. RFC64 identifiers
  // permit dot path segments, which remain opaque inside the encoded component.
  if (!validateContextGraphId(decoded[0]).valid) {
    try {
      assertAuthorLaneContextGraphIdV1(decoded[0]);
    } catch (error) {
      if (error instanceof AuthorLaneScopeErrorV1) return undefined;
      throw error;
    }
  }
  return decoded[0];
}

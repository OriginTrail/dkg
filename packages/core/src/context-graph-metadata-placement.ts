// SPDX-License-Identifier: Apache-2.0

import { contextGraphDataUri, contextGraphMetaUri } from './constants.js';
import { SYSTEM_CONTEXT_GRAPHS } from './genesis.js';

/**
 * Where a Context Graph's metadata (its definition, name and on-chain id
 * binding) is stored. `ontology` is the network-wide catalogue of public
 * graphs, so only a public graph's metadata goes there; a curated or
 * private graph keeps it in its own `_meta` graph.
 */
export interface ContextGraphMetadataPlacement {
  /** Curated (on-chain access policy 1) or private (local-only). */
  readonly curated: boolean;
}

/**
 * The graph peers and lookups read a Context Graph's metadata from:
 * `ontology` for a public graph, the graph's own `_meta` otherwise.
 */
export function contextGraphMetadataHomeGraph(
  contextGraphId: string,
  placement: ContextGraphMetadataPlacement,
): string {
  return placement.curated
    ? contextGraphMetaUri(contextGraphId)
    : contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
}

/**
 * The graphs a node writes a metadata fact to when it keeps the graph's own
 * record, as registration and rename do: the home graph, and the graph's own
 * `_meta`, which for a public graph holds a second copy.
 */
export function contextGraphMetadataGraphs(
  contextGraphId: string,
  placement: ContextGraphMetadataPlacement,
): readonly string[] {
  return [...new Set([
    contextGraphMetadataHomeGraph(contextGraphId, placement),
    contextGraphMetaUri(contextGraphId),
  ])];
}

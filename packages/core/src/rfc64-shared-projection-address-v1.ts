import { buildCatalogAssertionScopeV1, type CatalogLaneV1 } from './author-catalog-codec.js';
import type { CanonicalDeterministicKnowledgeAssetUalPartsV1 } from './ka-content-scope.js';

/**
 * Canonical physical graph for one RFC-64 shared projection.
 *
 * Both arguments have already passed their canonical boundary. Keeping this
 * placement helper outside the stream manifest lets readers and writers share
 * one address without depending on query compilation.
 */
export function deriveRfc64SharedProjectionGraphIriV1(
  lane: CatalogLaneV1,
  ual: CanonicalDeterministicKnowledgeAssetUalPartsV1,
): string {
  return `did:dkg:context-graph:${buildCatalogAssertionScopeV1(lane)}`
    + `/_shared_memory/${ual.agentAddress}/${ual.kaNumber}`;
}

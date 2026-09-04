import { buildCatalogAssertionScopeV1, type CatalogLaneV1 } from './author-catalog-codec.js';
import { contextGraphLayerUri } from './constants.js';
import type { CanonicalDeterministicKnowledgeAssetUalPartsV1 } from './ka-content-scope.js';
import { MemoryLayer } from './memory-model.js';

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
  return contextGraphLayerUri(
    buildCatalogAssertionScopeV1(lane),
    MemoryLayer.SharedWorkingMemory,
    ual.agentAddress,
    ual.kaNumber,
  );
}

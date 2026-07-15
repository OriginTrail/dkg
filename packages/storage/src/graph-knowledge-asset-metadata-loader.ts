import {
  buildGraphKnowledgeAssetMetadataQuery,
  parseGraphKnowledgeAssetMetadataBindings,
  parseDeterministicKnowledgeAssetUal,
  type ParsedGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-core';
import type { QueryOptions, TripleStore } from './triple-store.js';

export type GraphScopedOrLegacyMetadata<TLegacy> =
  | { readonly kind: 'graph'; readonly metadata: ParsedGraphKnowledgeAssetMetadata }
  | { readonly kind: 'legacy'; readonly metadata: TLegacy }
  | { readonly kind: 'absent' };

/**
 * Resolve graph-scoped control metadata before attempting a legacy lookup.
 *
 * This is the canonical fail-closed ordering shared by query and private
 * access: malformed V2 metadata throws, while absent or explicitly legacy
 * metadata delegates exactly once to the caller-specific legacy reader.
 */
export async function resolveGraphScopedOrLegacyMetadata<TLegacy>(
  store: Pick<TripleStore, 'query'>,
  ual: string,
  loadLegacyMetadata: () => Promise<TLegacy | null>,
  queryOptions?: QueryOptions,
): Promise<GraphScopedOrLegacyMetadata<TLegacy>> {
  // Canonicalize a bare deterministic UAL before the V2 marker lookup. V2
  // markers are stored under the canonical form (lowercase author address,
  // BigInt-normalized KA number), so a checksum-cased or leading-zero variant
  // — what ethers-based clients emit — would otherwise miss its own marker and
  // fall through to the legacy reader, serving quarantined legacy rows and the
  // private bag under the legacy access policy. Non-deterministic identifiers
  // stay eligible for legacy read-both.
  let graphScopedUal = ual;
  try {
    graphScopedUal = parseDeterministicKnowledgeAssetUal(ual).ual;
  } catch {
    // Non-deterministic identifiers remain eligible for legacy read-both.
  }
  const result = await store.query(
    buildGraphKnowledgeAssetMetadataQuery(graphScopedUal),
    queryOptions,
  );
  const parsed = parseGraphKnowledgeAssetMetadataBindings(
    graphScopedUal,
    result.type === 'bindings' ? result.bindings : [],
  );
  if (parsed.kind === 'graph') return parsed;

  const legacyMetadata = await loadLegacyMetadata();
  return legacyMetadata === null
    ? { kind: 'absent' }
    : { kind: 'legacy', metadata: legacyMetadata };
}

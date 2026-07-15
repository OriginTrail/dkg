import {
  buildGraphKnowledgeAssetMetadataQuery,
  parseGraphKnowledgeAssetMetadataBindings,
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
  const result = await store.query(
    buildGraphKnowledgeAssetMetadataQuery(ual),
    queryOptions,
  );
  const parsed = parseGraphKnowledgeAssetMetadataBindings(
    ual,
    result.type === 'bindings' ? result.bindings : [],
  );
  if (parsed.kind === 'graph') return parsed;

  const legacyMetadata = await loadLegacyMetadata();
  return legacyMetadata === null
    ? { kind: 'absent' }
    : { kind: 'legacy', metadata: legacyMetadata };
}

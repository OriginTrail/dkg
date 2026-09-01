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
 * The same resolution with failure PROVENANCE as data (W2 review r1): a
 * store-query rejection (transient I/O — the caller's cursor/retry problem)
 * and malformed V2 metadata (deterministic — a data problem) surface as
 * distinct variants instead of indistinguishable bare `Error`s. A rejection
 * from the caller-supplied legacy reader is not classified here — it belongs
 * to that caller — and propagates as-is.
 */
export type GraphScopedMetadataLookup<TLegacy> =
  | GraphScopedOrLegacyMetadata<TLegacy>
  | { readonly kind: 'query-failed'; readonly cause: unknown }
  | { readonly kind: 'malformed'; readonly cause: unknown };

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
  const lookup = await lookupGraphScopedOrLegacyMetadata(
    store,
    ual,
    loadLegacyMetadata,
    queryOptions,
  );
  // The throwing contract predates the tagged lookup: existing callers see
  // the ORIGINAL error object, exactly as before the classification existed.
  if (lookup.kind === 'query-failed' || lookup.kind === 'malformed') throw lookup.cause;
  return lookup;
}

/** The tagged variant — see {@link GraphScopedMetadataLookup}. */
export async function lookupGraphScopedOrLegacyMetadata<TLegacy>(
  store: Pick<TripleStore, 'query'>,
  ual: string,
  loadLegacyMetadata: () => Promise<TLegacy | null>,
  queryOptions?: QueryOptions,
): Promise<GraphScopedMetadataLookup<TLegacy>> {
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
  let result;
  try {
    result = await store.query(
      buildGraphKnowledgeAssetMetadataQuery(graphScopedUal),
      queryOptions,
    );
  } catch (cause) {
    return { kind: 'query-failed', cause };
  }
  let parsed;
  try {
    parsed = parseGraphKnowledgeAssetMetadataBindings(
      graphScopedUal,
      result.type === 'bindings' ? result.bindings : [],
    );
  } catch (cause) {
    return { kind: 'malformed', cause };
  }
  if (parsed.kind === 'graph') return parsed;

  const legacyMetadata = await loadLegacyMetadata();
  return legacyMetadata === null
    ? { kind: 'absent' }
    : { kind: 'legacy', metadata: legacyMetadata };
}

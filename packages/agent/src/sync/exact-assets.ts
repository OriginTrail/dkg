import {
  DKG_GOSSIP_MAX_MESSAGE_BYTES,
  parseDeterministicKnowledgeAssetUal,
} from '@origintrail-official/dkg-core';

/** One VM reconciliation slice deliberately fetches at most this many KAs. */
export const MAX_EXACT_SYNC_ASSETS = 10;

/**
 * A published assertion must already fit one DKG gossip application payload.
 * Apply that same per-asset wire ceiling to each compatibility phase so a
 * legacy responder that ignores the additive exact filter cannot turn a
 * narrow repair into an unbounded full-CG accumulation.
 */
export const MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET = DKG_GOSSIP_MAX_MESSAGE_BYTES;
export const MAX_EXACT_SYNC_PHASE_QUADS_PER_ASSET = 100_000;

export function exactSyncPhaseAccumulationLimits(assetUals: readonly string[]): {
  maxBytes: number;
  maxQuads: number;
} {
  const assetCount = requireExactAssetUals(assetUals).length;
  return {
    maxBytes: assetCount * MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET,
    // Align with the existing bounded exact-graph read contract so compact
    // wire data cannot expand into an unbounded retained JS object graph.
    maxQuads: assetCount * MAX_EXACT_SYNC_PHASE_QUADS_PER_ASSET,
  };
}

function canonicalExactAssetSetOrder(assetUals: readonly string[]): string[] {
  return [...new Set(assetUals)].sort();
}

/**
 * Normalize the additive exact-asset sync filter.
 *
 * `undefined` means the caller did not request filtering. Any present but
 * malformed value becomes an empty filter, which is fail-closed: a bad
 * narrowing hint must never silently expand into a full-CG response.
 */
export function normalizeExactAssetUals(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EXACT_SYNC_ASSETS) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string') return [];
    try {
      const ual = parseDeterministicKnowledgeAssetUal(candidate).ual;
      if (!seen.has(ual)) {
        seen.add(ual);
        normalized.push(ual);
      }
    } catch {
      return [];
    }
  }
  return canonicalExactAssetSetOrder(normalized);
}

export function requireExactAssetUals(value: unknown): string[] {
  const normalized = normalizeExactAssetUals(value);
  if (!normalized || normalized.length === 0) {
    throw new Error(`Exact VM sync requires 1-${MAX_EXACT_SYNC_ASSETS} valid KA UALs`);
  }
  return normalized;
}

/** Stable identity for checkpoints, single-flight keys, and responder plans. */
export function exactAssetFilterKey(assetUals: readonly string[] | undefined): string {
  return assetUals === undefined
    ? 'full'
    : `exact:${canonicalExactAssetSetOrder(assetUals).join('\u001f')}`;
}

export function encodeExactAssetUals(assetUals: readonly string[]): string {
  return encodeURIComponent(JSON.stringify(canonicalExactAssetSetOrder(assetUals)));
}

export function decodeExactAssetUals(encoded: string): string[] {
  try {
    return normalizeExactAssetUals(JSON.parse(decodeURIComponent(encoded))) ?? [];
  } catch {
    return [];
  }
}

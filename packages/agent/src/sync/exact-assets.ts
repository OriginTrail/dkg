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

/** Challenge-pinned identity one exact descriptor must match. */
export interface ExactAssetCommitment {
  readonly assetUal: string;
  /** Canonical lower-case bytes32 hex without a prefix. */
  readonly merkleRootHex: string;
  /** Structured V10 leaves: public triples plus one private-root sibling. */
  readonly merkleLeafCount: bigint;
}

/**
 * Atomic exact-fetch selection. UAL-only recovery remains available for
 * ordinary VM reconciliation; proof-time recovery cannot represent an asset
 * without its challenge commitment.
 */
export type ExactAssetSelection =
  | Readonly<{
      readonly kind: 'ual-only';
      readonly assetUals: readonly string[];
    }>
  | Readonly<{
      readonly kind: 'challenge-pinned';
      readonly commitments: readonly ExactAssetCommitment[];
    }>;

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

export function normalizeExactAssetMerkleRootHex(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Exact asset Merkle root must be hex');
  const normalized = value.replace(/^0x/iu, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw new TypeError('Exact asset Merkle root must be exactly 32 bytes');
  }
  return normalized;
}

export function createUalOnlyExactAssetSelection(
  assetUals: readonly string[],
): ExactAssetSelection {
  return Object.freeze({
    kind: 'ual-only',
    assetUals: Object.freeze(requireExactAssetUals(assetUals)),
  });
}

export function createChallengePinnedExactAssetSelection(
  inputCommitments: readonly ExactAssetCommitment[],
): ExactAssetSelection {
  if (
    !Array.isArray(inputCommitments)
    || inputCommitments.length < 1
    || inputCommitments.length > MAX_EXACT_SYNC_ASSETS
  ) {
    throw new Error(
      `Challenge-pinned exact sync requires 1-${MAX_EXACT_SYNC_ASSETS} commitments`,
    );
  }
  const seen = new Set<string>();
  const commitments = inputCommitments.map((input) => {
    const [assetUal] = requireExactAssetUals([input.assetUal]);
    if (seen.has(assetUal!)) {
      throw new Error(`Duplicate challenge commitment for ${assetUal}`);
    }
    seen.add(assetUal!);
    if (typeof input.merkleLeafCount !== 'bigint' || input.merkleLeafCount < 1n) {
      throw new TypeError(`Invalid challenge leaf count for ${assetUal}`);
    }
    return Object.freeze({
      assetUal: assetUal!,
      merkleRootHex: normalizeExactAssetMerkleRootHex(input.merkleRootHex),
      merkleLeafCount: input.merkleLeafCount,
    });
  }).sort((left, right) => left.assetUal.localeCompare(right.assetUal));
  return Object.freeze({
    kind: 'challenge-pinned',
    commitments: Object.freeze(commitments),
  });
}

export function requireExactAssetSelection(value: unknown): ExactAssetSelection {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Exact asset selection kind is invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'ual-only') {
    if (Object.hasOwn(candidate, 'commitments')) {
      throw new TypeError('UAL-only exact selection cannot include challenge commitments');
    }
    return createUalOnlyExactAssetSelection(candidate.assetUals as readonly string[]);
  }
  if (candidate.kind === 'challenge-pinned') {
    if (Object.hasOwn(candidate, 'assetUals')) {
      throw new TypeError('Challenge-pinned exact selection cannot include a parallel UAL list');
    }
    return createChallengePinnedExactAssetSelection(
      candidate.commitments as readonly ExactAssetCommitment[],
    );
  }
  throw new TypeError('Exact asset selection kind is invalid');
}

export function exactAssetUalsForSelection(selection: ExactAssetSelection): string[] {
  return selection.kind === 'ual-only'
    ? [...selection.assetUals]
    : selection.commitments.map((commitment) => commitment.assetUal);
}

export function exactAssetCommitmentsForSelection(
  selection: ExactAssetSelection,
): readonly ExactAssetCommitment[] | undefined {
  return selection.kind === 'challenge-pinned' ? selection.commitments : undefined;
}

export function exactAssetCommitmentMatchesDescriptor(
  commitment: ExactAssetCommitment,
  descriptor: {
    readonly ual: string;
    readonly claimedRootHex: string;
    readonly publicTripleCount: number;
    readonly privateTripleCount: number;
  },
): boolean {
  return descriptor.ual === commitment.assetUal
    && normalizeExactAssetMerkleRootHex(descriptor.claimedRootHex)
      === commitment.merkleRootHex
    && BigInt(descriptor.publicTripleCount + (descriptor.privateTripleCount > 0 ? 1 : 0))
      === commitment.merkleLeafCount;
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

// SPDX-License-Identifier: Apache-2.0
import { canonicalizeCanonicalGraphScopedAuthorSealV1 } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { Rfc64CatalogSuccessorAssetInputV1 } from '../dkg-agent-rfc64-catalog.js';
import { readCoherentKnowledgeAssetVersionEvidence } from '../confirmed-draft-version.js';
import { throwIfRfc64AbortedV1 as throwIfAbortedV1 } from './abort-v1.js';

/** Order replacements by author-issued canonical seal evidence, not draft numbers alone. */
export async function assertRfc64CatalogReplacementOrderV1(
  chain: ChainAdapter,
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  target: readonly Rfc64CatalogSuccessorAssetInputV1[],
  signal?: AbortSignal,
): Promise<void> {
  const currentByKaId = new Map(current.map((asset) => [asset.seal.reservedKaId, asset]));
  for (const candidate of target) {
    const existing = currentByKaId.get(candidate.seal.reservedKaId);
    if (existing === undefined || sameRfc64SuccessorAssetV1(existing, candidate)) continue;
    if (existing.assertionCoordinate !== candidate.assertionCoordinate
      || existing.seal.authorAddress !== candidate.seal.authorAddress) {
      throw new Error('RFC-64 catalog replacement is not a newer assertion version on the same coordinate');
    }
    const currentVersion = BigInt(existing.seal.assertionVersion);
    const candidateVersion = BigInt(candidate.seal.assertionVersion);
    const currentTime = existing.seal.assertionFinalizedAt;
    const candidateTime = candidate.seal.assertionFinalizedAt;
    if (candidateTime < currentTime || (candidateVersion <= currentVersion && candidateTime === currentTime)) {
      throw new Error('RFC-64 catalog replacement has older or equal seal finalization evidence; not a newer assertion version on the same coordinate');
    }
    if (candidateVersion > currentVersion) continue;
    throwIfAbortedV1(signal);
    // Count/root/attribution come from one pinned chain view. Never infer
    // that a number was merely burned from separate or unavailable reads.
    const kaId = BigInt(candidate.seal.reservedKaId);
    const evidence = await readCoherentKnowledgeAssetVersionEvidence(chain, {
      knowledgeAssetId: kaId,
      expectedAuthor: candidate.seal.authorAddress,
      options: { signal },
      acceptsSnapshot: (snapshot) => (candidateVersion >= currentVersion || snapshot.rootCount >= 1n)
        && currentVersion > snapshot.rootCount && candidateVersion > snapshot.rootCount,
    });
    throwIfAbortedV1(signal);
    if (evidence.kind === 'unavailable' || evidence.kind === 'invalid') {
      throw new Error('RFC-64 draft replacement requires coherent proof that both numbers exceed the published version');
    }
    if (evidence.kind === 'stale') {
      throw new Error('RFC-64 draft replacement chain snapshot is no longer current');
    }
    throwIfAbortedV1(signal);
  }
}

export function sameRfc64SuccessorAssetV1(
  left: Rfc64CatalogSuccessorAssetInputV1,
  right: Rfc64CatalogSuccessorAssetInputV1,
): boolean {
  return left.assertionCoordinate === right.assertionCoordinate
    && canonicalizeCanonicalGraphScopedAuthorSealV1(left.seal)
      === canonicalizeCanonicalGraphScopedAuthorSealV1(right.seal)
    && equalBytes(left.projectionBytes, right.projectionBytes);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphPolicyV1 } from '@origintrail-official/dkg-core';

/** The scope fields a replayed head must share with the accepted policy. */
export interface Rfc64CatalogHeadGenerationV1 {
  readonly governanceChainId: string | null;
  readonly governanceContractAddress: string | null;
  readonly ownershipTransitionDigest: string | null;
  readonly era: string;
}

/**
 * Is this head from the authority generation the accepted policy governs?
 *
 * A Context Graph that was authored before its on-chain registration carries
 * owner-signed heads (`governanceChainId: null`, no ownership transition) and
 * finalized-chain heads afterwards. Both are durable, both are current for
 * their own catalog scope, and they differ in fields the V1 head announcement
 * does not carry — so on the wire they collapse to the same
 * `(networkId, contextGraphId, subGraphName, authorAddress, catalogEra)` scope.
 */
export function isRfc64CatalogHeadOfAcceptedGenerationV1(
  head: Rfc64CatalogHeadGenerationV1,
  policy: Readonly<Pick<
    ContextGraphPolicyV1,
    'governanceChainId' | 'governanceContractAddress' | 'ownershipTransitionDigest' | 'era'
  >>,
): boolean {
  return head.governanceChainId === policy.governanceChainId
    && head.governanceContractAddress === policy.governanceContractAddress
    && head.ownershipTransitionDigest === policy.ownershipTransitionDigest
    && head.era === policy.era;
}

/**
 * Keep only the heads a peer can actually accept under the current policy.
 *
 * Every announcement this node replays is stamped with the accepted policy
 * digest, so a head from a superseded authority generation cannot be applied
 * by the receiver: its catalog scope digest no longer matches. Replaying it
 * anyway is worse than useless. Two generations of the same author lane
 * collapse to one wire scope, the V2 completion manifest refuses to encode a
 * repeated scope, and the whole replay response fails — including the heads
 * the receiver was waiting for. A Context Graph published to both before and
 * after registration would then never serve replay again, and every receiver
 * would sit at `catalog-replay-incomplete` with no way forward.
 *
 * Selection is therefore by generation, not by recency: `version` counts
 * within one catalog scope and says nothing across two of them.
 */
export function selectRfc64AcceptedGenerationHeadsV1<
  Entry extends { readonly head: { readonly payload: Rfc64CatalogHeadGenerationV1 } },
>(
  entries: readonly Entry[],
  policy: Readonly<Pick<
    ContextGraphPolicyV1,
    'governanceChainId' | 'governanceContractAddress' | 'ownershipTransitionDigest' | 'era'
  >>,
): readonly Entry[] {
  return Object.freeze(entries.filter(
    (entry) => isRfc64CatalogHeadOfAcceptedGenerationV1(entry.head.payload, policy),
  ));
}

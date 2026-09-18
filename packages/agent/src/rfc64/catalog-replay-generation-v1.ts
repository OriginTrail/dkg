// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphPolicyV1 } from '@origintrail-official/dkg-core';

import type { Rfc64PublicCatalogHeadAnnouncementV1 } from './public-catalog-transport-v1.js';

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

/** The wire scope two replayed heads may never share. */
type Rfc64CatalogReplayWireScopeV1 = Pick<
  Rfc64PublicCatalogHeadAnnouncementV1,
  'networkId' | 'contextGraphId' | 'subGraphName' | 'authorAddress' | 'catalogEra'
>;

/**
 * Refuse a replay manifest that would repeat one wire scope.
 *
 * Selecting a single authority generation is what keeps the manifest free of
 * repeated scopes today, but that is a property of the durable scopes this
 * node holds, not something the selection can prove: the durable
 * `AuthorCatalogScopeV1` has nine fields, the wire scope five, and the
 * generation predicate above compares the four the accepted policy carries.
 * `bucketCount` is on neither the wire nor `ContextGraphPolicyV1`, so two
 * applied heads of one author lane differing only there would both survive
 * the selection — unreachable only because every authoring path pins
 * `bucketCount: '1'`, an invariant this code cannot enforce.
 *
 * So assert the guarantee where it is cheap to assert. A repeat caught here
 * names the offending scope on the provider; the same repeat reaching the V2
 * completion encoder fails the whole response instead, leaving the receiver
 * at `catalog-replay-incomplete` with nothing to act on.
 */
export function assertRfc64ReplayManifestScopesUniqueV1(
  manifest: readonly Rfc64CatalogReplayWireScopeV1[],
): void {
  const scopes = new Set<string>();
  for (const head of manifest) {
    const scope = [
      head.networkId,
      head.contextGraphId,
      head.subGraphName ?? '',
      head.authorAddress,
      head.catalogEra,
    ].join('\0');
    if (scopes.has(scope)) {
      throw new Error(
        'RFC-64 catalog replay manifest repeats a catalog scope before delivery: '
        + `${head.contextGraphId}/${head.subGraphName ?? ''}`
        + `/${head.authorAddress}/${head.catalogEra}`,
      );
    }
    scopes.add(scope);
  }
}

// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  assertRfc64ReplayManifestScopesUniqueV1,
  isRfc64CatalogHeadOfAcceptedGenerationV1,
} from '../src/rfc64/catalog-replay-generation-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from
  '../src/rfc64/public-catalog-transport-v1.js';

/** The exact fields the replay manifest may not repeat, typed from the wire. */
type WireScope = Pick<
  Rfc64PublicCatalogHeadAnnouncementV1,
  'networkId' | 'contextGraphId' | 'subGraphName' | 'authorAddress' | 'catalogEra'
>;

function wireScope(overrides: Partial<WireScope> = {}): WireScope {
  return {
    networkId: 'otp:20430',
    contextGraphId: '0x1111111111111111111111111111111111111111/replay-scope',
    subGraphName: null,
    authorAddress: '0x1111111111111111111111111111111111111111',
    catalogEra: '0',
    ...overrides,
  } as WireScope;
}

/**
 * A Context Graph authored before its registration and again afterwards holds
 * one durable current head per authority generation. Both carry the same
 * author, era and sub-graph, so the V1 announcement — which carries neither
 * the governance binding nor the ownership transition — cannot tell them
 * apart, and a V2 replay manifest that repeats a wire scope refuses to encode.
 */
const ownerSignedHead = {
  head: { payload: {
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    era: '0',
    version: '2',
  } },
};

const finalizedChainHead = {
  head: { payload: {
    governanceChainId: '31337',
    governanceContractAddress: '0x193521c8934bcf3473453af4321911e7a89e0e12',
    ownershipTransitionDigest: `0x${'62'.repeat(32)}`,
    era: '0',
    version: '12',
  } },
};

const finalizedChainPolicy = {
  governanceChainId: '31337',
  governanceContractAddress: '0x193521c8934bcf3473453af4321911e7a89e0e12',
  ownershipTransitionDigest: `0x${'62'.repeat(32)}`,
  era: '0',
} as never;

const ownerSignedPolicy = {
  governanceChainId: null,
  governanceContractAddress: null,
  ownershipTransitionDigest: null,
  era: '0',
} as never;

describe('RFC-64 catalog replay authority generation', () => {
  it('keeps only the generation the accepted policy governs', () => {
    // The two heads differ only outside the wire scope (networkId,
    // contextGraphId, subGraphName, authorAddress, catalogEra), which is
    // exactly the collision that made the provider's own completion
    // unencodable and left every receiver at catalog-replay-incomplete.
    expect(isRfc64CatalogHeadOfAcceptedGenerationV1(
      finalizedChainHead.head.payload,
      finalizedChainPolicy,
    )).toBe(true);
    expect(isRfc64CatalogHeadOfAcceptedGenerationV1(
      ownerSignedHead.head.payload,
      finalizedChainPolicy,
    )).toBe(false);
    // Symmetric: before registration the owner-signed lane is the live one and
    // a later finalized head must not be replayed under it.
    expect(isRfc64CatalogHeadOfAcceptedGenerationV1(
      ownerSignedHead.head.payload,
      ownerSignedPolicy,
    )).toBe(true);
    expect(isRfc64CatalogHeadOfAcceptedGenerationV1(
      finalizedChainHead.head.payload,
      ownerSignedPolicy,
    )).toBe(false);
  });

  it('rejects a head whose ownership transition no longer matches', () => {
    // An ownership transition re-scopes the lane even when the governance
    // contract is unchanged, so recency alone cannot decide: `version` counts
    // within one catalog scope and says nothing across two.
    const rotated = {
      head: { payload: {
        ...finalizedChainHead.head.payload,
        ownershipTransitionDigest: `0x${'ab'.repeat(32)}`,
        version: '99',
      } },
    };

    expect(isRfc64CatalogHeadOfAcceptedGenerationV1(rotated.head.payload, finalizedChainPolicy))
      .toBe(false);
  });

  it('keeps an era change out of the replayed generation', () => {
    const nextEra = { head: { payload: { ...finalizedChainHead.head.payload, era: '1' } } };

    expect(isRfc64CatalogHeadOfAcceptedGenerationV1(nextEra.head.payload, finalizedChainPolicy))
      .toBe(false);
  });
});

describe('RFC-64 catalog replay manifest wire scopes', () => {
  it('accepts heads that differ inside the wire scope', () => {
    expect(() => assertRfc64ReplayManifestScopesUniqueV1([
      wireScope(),
      wireScope({ subGraphName: 'lane' as WireScope['subGraphName'] }),
      wireScope({ catalogEra: '1' as WireScope['catalogEra'] }),
      wireScope({
        authorAddress: '0x2222222222222222222222222222222222222222' as
          WireScope['authorAddress'],
      }),
    ])).not.toThrow();
  });

  it('names the repeated scope instead of leaving the completion unencodable', () => {
    // Two applied heads of one author lane that the generation filter cannot
    // tell apart — differing only in a durable scope field the wire and the
    // policy both omit, such as bucketCount — must fail here, on the
    // provider, rather than as an unencodable peer completion.
    expect(() => assertRfc64ReplayManifestScopesUniqueV1([wireScope(), wireScope()]))
      .toThrow(/repeats a catalog scope before delivery/u);
    expect(() => assertRfc64ReplayManifestScopesUniqueV1([wireScope(), wireScope()]))
      .toThrow(/replay-scope/u);
  });
});

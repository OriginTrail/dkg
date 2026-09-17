// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  isRfc64CatalogHeadOfAcceptedGenerationV1,
  selectRfc64AcceptedGenerationHeadsV1,
} from '../src/rfc64/catalog-replay-generation-v1.js';

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
    const entries = [ownerSignedHead, finalizedChainHead];

    expect(selectRfc64AcceptedGenerationHeadsV1(entries, finalizedChainPolicy))
      .toEqual([finalizedChainHead]);
    // Symmetric: before registration the owner-signed lane is the live one and
    // a later finalized head must not be replayed under it.
    expect(selectRfc64AcceptedGenerationHeadsV1(entries, ownerSignedPolicy))
      .toEqual([ownerSignedHead]);
  });

  it('never returns two heads that share one wire scope', () => {
    // The wire scope is (networkId, contextGraphId, subGraphName,
    // authorAddress, catalogEra): these two differ only outside it, which is
    // exactly the collision that made the provider's own completion
    // unencodable and left every receiver at catalog-replay-incomplete.
    const selected = selectRfc64AcceptedGenerationHeadsV1(
      [ownerSignedHead, finalizedChainHead],
      finalizedChainPolicy,
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]!.head.payload.version).toBe('12');
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
    expect(selectRfc64AcceptedGenerationHeadsV1([rotated, finalizedChainHead], finalizedChainPolicy))
      .toEqual([finalizedChainHead]);
  });

  it('keeps an era change out of the replayed generation', () => {
    const nextEra = { head: { payload: { ...finalizedChainHead.head.payload, era: '1' } } };

    expect(selectRfc64AcceptedGenerationHeadsV1([nextEra, finalizedChainHead], finalizedChainPolicy))
      .toEqual([finalizedChainHead]);
  });
});

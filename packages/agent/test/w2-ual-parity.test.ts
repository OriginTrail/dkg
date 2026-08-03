import { describe, expect, it } from 'vitest';

import {
  MAX_ROOTLESS_KA_NUMBER,
  buildKnowledgeAssetUalFromOnChainIdV1,
  buildScopedKnowledgeAssetUal,
  canonicalScopedKaCandidatesFromVerifiedUal,
  deriveVmUpdateScopeId,
  type VmUpdateScopeV1,
} from '@origintrail-official/dkg-core';

import { buildReconciledKnowledgeAssetUal } from '../src/ka-identity.js';

/**
 * The legacy/rootless KA UAL rule has ONE owner: `ka-ual-identity.ts` in `core`.
 *
 * An earlier revision of this PR restated the rule inside
 * `vm-update-convergence.ts` and used this file as a cross-package parity guard,
 * on the reasoning that `core` could not import the agent builder. That was
 * true but beside the point — the dependency direction is `agent → chain →
 * core`, so `core` can own the rule and `agent` can delegate downward. A parity
 * test detects drift only after it exists; deleting the duplicate removes the
 * possibility.
 *
 * So this file no longer compares two implementations. It proves the delegation
 * is real — that the agent export and the W2 wrapper both resolve to the single
 * owner — and keeps the boundary cases as direct coverage of that owner.
 */
const KA_STORAGE = `0x${'a1'.repeat(20)}`;
const CG_STORAGE = `0x${'b2'.repeat(20)}`;
const AUTHOR = `0x${'c3'.repeat(20)}`;
const CHAIN_ID = '84532';

const IDENTITY = {
  chainId: CHAIN_ID,
  deploymentId: `${CHAIN_ID}:hub=0x00000000000000000000000000000000000000ff`,
  knowledgeAssetStorageAddress: KA_STORAGE,
  contextGraphStorageAddress: CG_STORAGE,
};

const SCOPE: VmUpdateScopeV1 = {
  ...IDENTITY,
  scopeId: deriveVmUpdateScopeId(IDENTITY),
  deploymentBlock: 47_682_200,
  deploymentBlockSource: 'shipped',
  deploymentBlockHistoricallyValidated: true,
};

/**
 * Ids that straddle the classifier boundary in both directions — the largest
 * legacy id, the smallest rootless id, and a packed id whose low bits are zero.
 * That boundary is where a divergence would actually live.
 */
const BOUNDARY_IDS: readonly bigint[] = [
  1n,
  7n,
  MAX_ROOTLESS_KA_NUMBER, // largest id still classified legacy (`>> 96n === 0n`)
  1n << 96n, // smallest rootless id: address 0x…01, number 0
  (BigInt(AUTHOR) << 96n) | 0n, // rootless, zero KA number
  (BigInt(AUTHOR) << 96n) | 1n,
  (BigInt(AUTHOR) << 96n) | MAX_ROOTLESS_KA_NUMBER,
  (BigInt(KA_STORAGE) << 96n) | 7n, // rootless packed AT the storage address
];

describe('the KA UAL rule has a single owner, and both entry points delegate to it', () => {
  it.each(BOUNDARY_IDS.map((kaId) => [kaId.toString()] as const))(
    'agent and core agree with the owner for kaId %s',
    (kaIdText) => {
      const kaId = BigInt(kaIdText);
      const owned = buildKnowledgeAssetUalFromOnChainIdV1(CHAIN_ID, KA_STORAGE, kaId);
      expect(buildReconciledKnowledgeAssetUal(CHAIN_ID, KA_STORAGE, kaId)).toBe(owned);
      expect(buildScopedKnowledgeAssetUal(CHAIN_ID, KA_STORAGE, kaId)).toBe(owned);
    },
  );

  it('pins the classifier boundary ABSOLUTELY, because agreement alone cannot', () => {
    // With one owner, comparing the two entry points is vacuous for any change
    // to the rule itself: mutating the owner moves both sides together and they
    // still agree. Proven — changing `kaId >> 96n` to `>> 95n` in the owner left
    // the whole agreement suite green. Only absolute expectations catch it.
    //
    // These four ids are exactly where the 96-bit split decides the form.
    const largestLegacy = MAX_ROOTLESS_KA_NUMBER; // 2^96 - 1, still legacy
    const smallestRootless = 1n << 96n; // author 0x…01, number 0

    expect(buildKnowledgeAssetUalFromOnChainIdV1(CHAIN_ID, KA_STORAGE, largestLegacy)).toBe(
      `did:dkg:${CHAIN_ID}/${KA_STORAGE}/${largestLegacy.toString()}`,
    );
    expect(buildKnowledgeAssetUalFromOnChainIdV1(CHAIN_ID, KA_STORAGE, smallestRootless)).toBe(
      `did:dkg:${CHAIN_ID}/0x${'0'.repeat(39)}1/0`,
    );
    expect(buildKnowledgeAssetUalFromOnChainIdV1(CHAIN_ID, KA_STORAGE, 0n)).toBe(
      `did:dkg:${CHAIN_ID}/${KA_STORAGE}/0`,
    );
    expect(
      buildKnowledgeAssetUalFromOnChainIdV1(CHAIN_ID, KA_STORAGE, (BigInt(AUTHOR) << 96n) | MAX_ROOTLESS_KA_NUMBER),
    ).toBe(`did:dkg:${CHAIN_ID}/${AUTHOR}/${MAX_ROOTLESS_KA_NUMBER.toString()}`);

    // The agent entry point must produce those same absolute strings, which is
    // what makes the delegation meaningful rather than merely self-consistent.
    expect(buildReconciledKnowledgeAssetUal(CHAIN_ID, KA_STORAGE, largestLegacy)).toBe(
      `did:dkg:${CHAIN_ID}/${KA_STORAGE}/${largestLegacy.toString()}`,
    );
    expect(buildReconciledKnowledgeAssetUal(CHAIN_ID, KA_STORAGE, smallestRootless)).toBe(
      `did:dkg:${CHAIN_ID}/0x${'0'.repeat(39)}1/0`,
    );
  });

  it('covers both sides of the classifier boundary, so agreement is not vacuous', () => {
    // Without this, an owner that returned the legacy form unconditionally would
    // still "agree" on a table that happened to hold only legacy ids.
    const forms = BOUNDARY_IDS.map((kaId) => (kaId >> 96n === 0n ? 'legacy' : 'rootless'));
    expect(new Set(forms)).toEqual(new Set(['legacy', 'rootless']));

    // And the two forms really do produce different UALs for one id, so the
    // comparison above has something to discriminate.
    const rootless = (BigInt(AUTHOR) << 96n) | 7n;
    expect(buildReconciledKnowledgeAssetUal(CHAIN_ID, KA_STORAGE, rootless)).toBe(
      `did:dkg:${CHAIN_ID}/${AUTHOR}/7`,
    );
    expect(buildReconciledKnowledgeAssetUal(CHAIN_ID, KA_STORAGE, 7n)).toBe(
      `did:dkg:${CHAIN_ID}/${KA_STORAGE}/7`,
    );
  });

  it('preserves the checksummed-address behaviour the sole caller depends on', () => {
    // `dkg-agent-swm-host.ts` passes the address straight from
    // `getDKGKnowledgeAssetsAddress()`, which returns the checksummed form. The
    // owner lowercases it, exactly as `buildKnowledgeAssetUal` always did —
    // delegating must not have made this path stricter.
    const checksummed = `0x${'A1'.repeat(20)}`;
    expect(buildReconciledKnowledgeAssetUal(CHAIN_ID, checksummed, 7n)).toBe(
      `did:dkg:${CHAIN_ID}/${KA_STORAGE}/7`,
    );
  });

  it('round-trips every parsed candidate back through the agent entry point', () => {
    // The parser's own round-trip check uses the core wrapper. This closes the
    // loop against the agent export, so a candidate the parser accepts cannot
    // denote a different KA in the rest of the codebase.
    for (const ual of [
      `did:dkg:${CHAIN_ID}/${KA_STORAGE}/7`,
      `did:dkg:${CHAIN_ID}/${AUTHOR}/0`,
      `did:dkg:${CHAIN_ID}/${AUTHOR}/${MAX_ROOTLESS_KA_NUMBER.toString()}`,
    ]) {
      const set = canonicalScopedKaCandidatesFromVerifiedUal(SCOPE, ual);
      expect(set.candidates.length).toBeGreaterThan(0);
      for (const candidate of set.candidates) {
        expect(
          buildReconciledKnowledgeAssetUal(CHAIN_ID, KA_STORAGE, BigInt(candidate.kaId)),
        ).toBe(ual);
      }
    }
  });
});

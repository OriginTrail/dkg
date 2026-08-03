import { describe, expect, it } from 'vitest';

import {
  MAX_ROOTLESS_KA_NUMBER,
  buildScopedKnowledgeAssetUal,
  canonicalScopedKaCandidatesFromVerifiedUal,
  deriveVmUpdateScopeId,
  type VmUpdateScopeV1,
} from '@origintrail-official/dkg-core';

import { buildReconciledKnowledgeAssetUal } from '../src/ka-identity.js';

/**
 * W2's candidate parser lives in `packages/core` (it must be reachable from the
 * node-UI store and the chain adapter, neither of which may depend on `agent`),
 * so `buildScopedKnowledgeAssetUal` restates the legacy/rootless UAL rule that
 * `buildReconciledKnowledgeAssetUal` already owns here in `agent`. Core cannot
 * import it: `agent` depends on `core`, not the reverse.
 *
 * A restated rule with no external anchor is a rule that can drift silently, and
 * this particular drift is not cosmetic — W2's mutation fence selects which KA a
 * graph write belongs to by round-tripping candidates through this function. If
 * the two spellings diverge at the `kaId >> 96` boundary, the fence either
 * refuses every legal write or attributes one to the wrong KA.
 *
 * This file is that anchor. It is the ONLY place both implementations are
 * visible at once, and it fails if either side changes alone.
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
 * Ids chosen to straddle the classifier boundary in both directions, because
 * that boundary is where a divergence would actually live: the largest legacy
 * id, the smallest rootless id, and a packed id whose low bits are zero.
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

describe('W2 core UAL construction is byte-identical to the agent reconciled builder', () => {
  it.each(BOUNDARY_IDS.map((kaId) => [kaId.toString()] as const))(
    'agrees for kaId %s',
    (kaIdText) => {
      const kaId = BigInt(kaIdText);
      expect(buildScopedKnowledgeAssetUal(CHAIN_ID, KA_STORAGE, kaId)).toBe(
        buildReconciledKnowledgeAssetUal(CHAIN_ID, KA_STORAGE, kaId),
      );
    },
  );

  it('covers both sides of the classifier boundary, so agreement is not vacuous', () => {
    // Without this, a builder that returned the legacy form unconditionally
    // would still "agree" on a table that happened to hold only legacy ids.
    const forms = BOUNDARY_IDS.map((kaId) =>
      kaId >> 96n === 0n ? 'legacy' : 'rootless',
    );
    expect(new Set(forms)).toEqual(new Set(['legacy', 'rootless']));

    // And prove the two forms really do produce different UALs for one id, so
    // the comparison above has something to discriminate.
    const rootless = (BigInt(AUTHOR) << 96n) | 7n;
    expect(buildReconciledKnowledgeAssetUal(CHAIN_ID, KA_STORAGE, rootless)).toBe(
      `did:dkg:${CHAIN_ID}/${AUTHOR}/7`,
    );
    expect(buildReconciledKnowledgeAssetUal(CHAIN_ID, KA_STORAGE, 7n)).toBe(
      `did:dkg:${CHAIN_ID}/${KA_STORAGE}/7`,
    );
  });

  it('round-trips every parsed candidate back through the agent builder', () => {
    // The parser's own round-trip check uses the core builder. This closes the
    // loop against the agent builder instead, so a candidate the parser accepts
    // cannot denote a different KA in the rest of the codebase.
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

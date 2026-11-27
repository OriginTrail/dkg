// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { computeCanonicalGraphScopedAuthorSealDigestV1, type ContextGraphIdV1, type AssertionCoordinateV1, type NetworkIdV1, type DecimalU64V1 } from '@origintrail-official/dkg-core';
import { finalizedPrivateRepairKeyV1 } from '../src/internal/finalized-private-placement-key.js';
import { encodeRfc64FinalizedPrivatePlacementRepairV1, digestRfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairV1 } from '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import { authorSealV1 } from './support/rfc64-local-catalog-repair-fixture.js';

describe('supervisor identity is canonical durable repair identity', () => {
  it('uses exact persisted bytes/digest and separates versions, scopes and sealed assertions', async () => {
    const seal = await authorSealV1(101n);
    const base = { contextGraphId: 'key-cg' as ContextGraphIdV1, authorAddress: seal.authorAddress, assertionCoordinate: 'asset' as AssertionCoordinateV1,
      assertionVersion: seal.assertionVersion, kaUal: seal.kaUal,
      sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal) };
    const v1 = { ...base, version: 1, inventoryScope: { networkId: 'otp:20430' as NetworkIdV1,
      contextGraphId: base.contextGraphId, authorAddress: seal.authorAddress, governanceChainId: null,
      governanceContractAddress: null, ownershipTransitionDigest: null, subGraphName: null, era: '1' as DecimalU64V1 } } as Rfc64FinalizedPrivatePlacementRepairV1;
    const v2 = { ...base, version: 2, inventoryScope: null, subGraphName: null, seal } as Rfc64FinalizedPrivatePlacementRepairV1;
    const anotherSeal = await authorSealV1(102n);
    const distinct = [v1, v2,
      { ...v1, inventoryScope: { ...(v1.version === 1 ? v1.inventoryScope : {}), era: '2' as DecimalU64V1 } },
      { ...v2, assertionCoordinate: 'other' as AssertionCoordinateV1 },
      { ...v2, seal: anotherSeal, kaUal: anotherSeal.kaUal, assertionVersion: anotherSeal.assertionVersion,
        sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(anotherSeal) },
    ] as Rfc64FinalizedPrivatePlacementRepairV1[];
    for (const repair of distinct) {
      const digest = Buffer.from(digestRfc64FinalizedPrivatePlacementRepairV1(
        encodeRfc64FinalizedPrivatePlacementRepairV1(repair))).toString('hex');
      expect(finalizedPrivateRepairKeyV1(repair)).toBe(digest);
      expect(finalizedPrivateRepairKeyV1(structuredClone(repair))).toBe(digest);
    }
    expect(new Set(distinct.map(finalizedPrivateRepairKeyV1)).size).toBe(distinct.length);
  });
});

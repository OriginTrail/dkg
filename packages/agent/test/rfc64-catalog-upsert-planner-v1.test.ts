import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  type CanonicalGraphScopedAuthorSealV1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  planRfc64CatalogProjectionTargetV1,
  planNextRfc64CatalogExactSetV1,
  type ReconcileRfc64PublicRootCatalogExactSetParamsV1,
} from '../src/dkg-agent-rfc64-catalog-upsert.js';

type Asset = ReconcileRfc64PublicRootCatalogExactSetParamsV1['assets'][number];

const AUTHOR_WALLET = new ethers.Wallet(`0x${'41'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const ASSERTION_ROOT = `0x${'ab'.repeat(32)}` as Digest32V1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;

async function plannerAsset(kaNumber: bigint, assertionVersion = '1'): Promise<Asset> {
  const reservedKaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const typedData = buildAuthorAttestationTypedData({
    chainId: 20430n,
    kav10Address: KAV10,
    merkleRoot: ethers.getBytes(ASSERTION_ROOT),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(reservedKaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = Object.freeze({
    assertionMerkleRoot: ASSERTION_ROOT,
    authorAddress: AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: '20430',
    assertedAtKav10Address: KAV10,
    reservedKaId,
    assertionFinalizedAt: '2026-08-28T10:00:00.000Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:otp:20430/${AUTHOR}/${kaNumber}`,
    assertionVersion,
    publicTripleCount: '1',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  }) as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return Object.freeze({
    assertionCoordinate: `asset-${kaNumber}`,
    projectionBytes: new Uint8Array([Number(kaNumber % 251n)]),
    seal,
  });
}

describe('RFC-64 exact-set bounded planner v1', () => {
  it('preserves catalog-only rows and replaces same-KA inventory rows in union mode', async () => {
    const catalogOnly = await plannerAsset(1n);
    const staleInventory = await plannerAsset(2n);
    const current = [catalogOnly, staleInventory];
    const refreshedInventory = Object.freeze({
      ...await plannerAsset(2n, '2'),
      projectionBytes: new Uint8Array([99]),
    }) as Asset;

    const union = planRfc64CatalogProjectionTargetV1(
      current,
      [refreshedInventory],
      'monotonic-union',
    );
    expect(union).toHaveLength(2);
    expect(union.map((asset) => asset.seal.reservedKaId)).toEqual([
      catalogOnly.seal.reservedKaId,
      refreshedInventory.seal.reservedKaId,
    ]);
    expect(union[0]?.projectionBytes).toEqual(catalogOnly.projectionBytes);
    expect(union[1]?.projectionBytes).toEqual(refreshedInventory.projectionBytes);

    const exact = planRfc64CatalogProjectionTargetV1(
      current,
      [refreshedInventory],
      'exact-replacement',
    );
    expect(exact).toEqual([refreshedInventory]);
  });

  it('frees one current-only slot before inserting into a full 1,024-row set', async () => {
    const current = await Promise.all(Array.from(
      { length: MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 },
      (_value, index) => plannerAsset(BigInt(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 + index)),
    ));
    const target = await Promise.all(Array.from(
      { length: MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 },
      (_value, index) => plannerAsset(BigInt(index)),
    ));

    const freed = planNextRfc64CatalogExactSetV1(current, target);
    expect(freed).toHaveLength(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 - 1);
    expect(freed.some(
      (asset) => asset.seal.reservedKaId === current.at(-1)?.seal.reservedKaId,
    )).toBe(false);

    const inserted = planNextRfc64CatalogExactSetV1(freed, target);
    expect(inserted).toHaveLength(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1);
    expect(inserted[0]?.seal.reservedKaId).toBe(target[0]?.seal.reservedKaId);
    expect(Math.max(freed.length, inserted.length)).toBe(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1);
  });
});

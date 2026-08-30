import {
  SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaProjectionDigestV1,
  computeSwmAuthorInventoryHeadObjectDigestV1,
  computeSwmAuthorInventoryRowsDigestV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type SignedSwmAuthorInventoryHeadEnvelopeV1,
  type SwmAuthorInventoryHeadV1,
  type SwmAuthorInventoryRowV1,
  type SwmAuthorInventoryScopeV1,
  type SwmAuthorInventorySnapshotV1,
  type UnsignedSwmAuthorInventoryHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import {
  prepareRfc64SwmInventoryCatalogTargetV1,
} from '../src/rfc64/swm-inventory-catalog-reconciler-v1.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'41'.repeat(32)}`);
const OTHER_WALLET = new ethers.Wallet(`0x${'42'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const NETWORK_ID = 'otp:20430';
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/r1-1-reconcile' as ContextGraphIdV1;
const GOVERNANCE = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const ASSERTION_ROOT = `0x${'ab'.repeat(32)}` as Digest32V1;
const PROJECTION = new TextEncoder().encode(
  '<https://example.org/r1> <https://schema.org/name> "R1.1" .\n',
);
const SCOPE = Object.freeze({
  networkId: NETWORK_ID,
  contextGraphId: CONTEXT_GRAPH_ID,
  governanceChainId: '20430',
  governanceContractAddress: GOVERNANCE,
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
}) as SwmAuthorInventoryScopeV1;
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;

describe('RFC-64 R1.1 signed SWM inventory to catalog target', () => {
  it('authenticates and detaches one complete target before catalog mutation', async () => {
    const seal = await authorSeal();
    const row = inventoryRow(seal, PROJECTION);
    const snapshot = await signedSnapshot([row], AUTHOR_WALLET);
    const callerProjection = new Uint8Array(PROJECTION);
    const resolveAsset = vi.fn(async (resolvedRow: Readonly<SwmAuthorInventoryRowV1>) => ({
      assertionCoordinate: resolvedRow.assertionCoordinate,
      projectionBytes: callerProjection,
      seal,
    }));

    const target = await prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot,
      resolveAsset,
    });
    callerProjection.fill(0);

    expect(resolveAsset).toHaveBeenCalledOnce();
    expect(resolveAsset.mock.calls[0]![0]).not.toBe(row);
    expect(target).toMatchObject({
      inventoryHeadObjectDigest: snapshot.head.objectDigest,
      inventoryScope: SCOPE,
      catalogScope: { ...SCOPE, bucketCount: '1' },
    });
    expect(target.assets).toHaveLength(1);
    expect(target.assets[0]).toMatchObject({
      assertionCoordinate: row.assertionCoordinate,
      seal,
    });
    expect(target.assets[0]!.projectionBytes).toEqual(PROJECTION);
    expect(Object.isFrozen(target.assets)).toBe(true);
    expect(Object.isFrozen(target.assets[0])).toBe(true);
  });

  it('rejects a signed row whose resolver substitutes different projection bytes', async () => {
    const seal = await authorSeal();
    const row = inventoryRow(seal, PROJECTION);
    const snapshot = await signedSnapshot([row], AUTHOR_WALLET);

    await expect(prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot,
      resolveAsset: async () => ({
        assertionCoordinate: row.assertionCoordinate,
        projectionBytes: new TextEncoder().encode(
          '<https://example.org/r1> <https://schema.org/name> "substituted" .\n',
        ),
        seal,
      }),
    })).rejects.toMatchObject({ code: 'swm-catalog-reconcile-binding' });
  });

  it('rejects an inventory head whose signature does not recover to its scoped author', async () => {
    const seal = await authorSeal();
    const row = inventoryRow(seal, PROJECTION);
    const snapshot = await signedSnapshot([row], OTHER_WALLET);
    const resolveAsset = vi.fn();

    await expect(prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot,
      resolveAsset,
    })).rejects.toMatchObject({ code: 'swm-catalog-reconcile-signature' });
    expect(resolveAsset).not.toHaveBeenCalled();
  });
});

function inventoryRow(
  seal: CanonicalGraphScopedAuthorSealV1,
  projectionBytes: Uint8Array,
): SwmAuthorInventoryRowV1 {
  return Object.freeze({
    assertionCoordinate: 'r1-draft',
    assertionVersion: seal.assertionVersion,
    kaUal: seal.kaUal,
    shareOperationId: 'r1-share-operation',
    projectionDigest: computeKaProjectionDigestV1(projectionBytes),
    publicTripleCount: seal.publicTripleCount,
    privateTripleCount: seal.privateTripleCount,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
    sharedAt: '1773900000000',
    expiresAt: null,
  }) as SwmAuthorInventoryRowV1;
}

async function signedSnapshot(
  rows: readonly SwmAuthorInventoryRowV1[],
  signingWallet: ethers.Wallet,
): Promise<SwmAuthorInventorySnapshotV1> {
  const payload = Object.freeze({
    ...SCOPE,
    version: '0',
    previousHeadDigest: null,
    totalRows: rows.length.toString(),
    rowsDigest: computeSwmAuthorInventoryRowsDigestV1(rows),
    issuedAt: '1773900001000',
  }) as SwmAuthorInventoryHeadV1;
  const unsigned = Object.freeze({
    issuer: AUTHOR,
    objectType: SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: Object.freeze({ kind: 'none' as const }),
    signatureSuite: 'eip191-personal-sign-digest-v1' as const,
  }) as UnsignedSwmAuthorInventoryHeadEnvelopeV1;
  const objectDigest = computeSwmAuthorInventoryHeadObjectDigestV1(unsigned);
  const head = Object.freeze({
    ...unsigned,
    objectDigest,
    signature: await signingWallet.signMessage(ethers.getBytes(objectDigest)),
  }) as SignedSwmAuthorInventoryHeadEnvelopeV1;
  return Object.freeze({ head, rows: Object.freeze([...rows]) });
}

async function authorSeal(): Promise<CanonicalGraphScopedAuthorSealV1> {
  const kaNumber = 7n;
  const reservedKaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(ASSERTION_ROOT),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(reservedKaId),
  });
  const signature = ethers.Signature.from(await AUTHOR_WALLET.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot: ASSERTION_ROOT,
    authorAddress: AUTHOR,
    authorAttestationR: signature.r,
    authorAttestationVS: signature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: DEPLOYMENT.assertedAtChainId,
    assertedAtKav10Address: KAV10,
    reservedKaId,
    assertionFinalizedAt: '2026-08-28T10:00:00.000Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: '1',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  return seal;
}

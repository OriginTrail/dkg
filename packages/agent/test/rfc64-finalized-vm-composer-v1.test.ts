import {
  AUTHOR_SCHEME_VERSION_V1,
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  buildAuthorAttestationTypedData,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeAuthorCatalogScopeDigestV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeControlObjectDigestHex,
  verifyAuthorCatalogDirectoryPathV1,
  verifyCatalogSealBindingV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type Digest32V1,
  type EvmAddressV1,
  type FinalizedVmSetRowV1,
  type KaIdV1,
  type NetworkIdV1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  verifyControlEnvelopeIssuerSignatureV1,
  type FinalizedVmChainInventoryV1,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  FinalizedVmCompositionErrorV1,
  composeFinalizedVmSetV1,
  type ComposeFinalizedVmSetRequestV1,
  type FinalizedVmPlacementEvidenceV1,
} from '../src/rfc64/finalized-vm-composer-v1.js';
import {
  readVerifiedAuthorCatalogRowAuthorshipV1,
  verifyAuthorCatalogRowAuthorshipV1,
} from '../src/rfc64/catalog-row-authorship.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'11'.repeat(32)}`);
const CATALOG_WALLET = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const OTHER_AUTHOR = `0x${'aa'.repeat(20)}` as EvmAddressV1;
const CATALOG_ISSUER = CATALOG_WALLET.address.toLowerCase() as EvmAddressV1;
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CHAIN_ID = '20430' as const;
const CONTEXT_GRAPH_NAME = 'agent-blackbox-vm' as const;
const ON_CHAIN_CONTEXT_GRAPH_ID = '14' as const;
const CG_STORAGE = `0x${'33'.repeat(20)}` as EvmAddressV1;
const KA_STORAGE = `0x${'44'.repeat(20)}` as EvmAddressV1;
const KAV10 = `0x${'55'.repeat(20)}` as EvmAddressV1;
const PUBLISHER = `0x${'66'.repeat(20)}` as EvmAddressV1;
const BLOCK_HASH = `0x${'77'.repeat(32)}` as Digest32V1;
const ROOT_1 = `0x${'88'.repeat(32)}` as Digest32V1;
const ROOT_2 = `0x${'99'.repeat(32)}` as Digest32V1;
const ZERO_DIGEST = `0x${'00'.repeat(32)}` as Digest32V1;
const KA_1 = packKaId(1n);
const KA_2 = packKaId(2n);

describe('RFC-64 finalized VM placement composition', () => {
  it('joins an authorized root-lane subset in finalized chain ordinal order', async () => {
    const placement = await createPlacement(KA_2, ROOT_2);
    const request = requestFor([placement]);

    const composed = composeFinalizedVmSetV1(request);
    const authorship = readVerifiedAuthorCatalogRowAuthorshipV1(placement.authorship);

    expect(composed.catalogLane).toEqual({
      contextGraphId: CONTEXT_GRAPH_NAME,
      subGraphName: null,
    });
    expect(composed.rows).toEqual([{
      chainId: CHAIN_ID,
      contractAddress: CG_STORAGE,
      ordinal: '1',
      ual: ual(2n),
      authorAddress: AUTHOR,
      assertionVersion: '2',
      assertionRoot: ROOT_2,
      finalizedBlockNumber: '123',
      finalizedBlockHash: BLOCK_HASH,
      placementEvidenceDigest: authorship.catalogRowDigest,
    } satisfies FinalizedVmSetRowV1]);
    expect(composed.evidence).toMatchObject({
      rowCount: '1',
      highestFinalizedOrdinal: '1',
      scope: {
        networkId: NETWORK_ID,
        chainId: CHAIN_ID,
        contractAddress: CG_STORAGE,
      },
    });
    expect(Object.isFrozen(composed)).toBe(true);
    expect(Object.isFrozen(composed.rows)).toBe(true);
    expect(Object.isFrozen(composed.rows[0])).toBe(true);
  });

  it('orders multiple joined placements by finalized inventory ordinal', async () => {
    const first = await createPlacement(KA_1, ROOT_1);
    const second = await createPlacement(KA_2, ROOT_2);

    const composed = composeFinalizedVmSetV1(requestFor([second, first]));

    expect(composed.rows.map(({ ordinal, ual, placementEvidenceDigest }) => ({
      ordinal,
      ual,
      placementEvidenceDigest,
    }))).toEqual([
      {
        ordinal: '0',
        ual: ual(1n),
        placementEvidenceDigest:
          readVerifiedAuthorCatalogRowAuthorshipV1(first.authorship).catalogRowDigest,
      },
      {
        ordinal: '1',
        ual: ual(2n),
        placementEvidenceDigest:
          readVerifiedAuthorCatalogRowAuthorshipV1(second.authorship).catalogRowDigest,
      },
    ]);
    expect(composed.materializations.map(({ candidate, placement, row }) => ({
      candidateOrdinal: candidate.ordinal,
      placementKaId: readVerifiedAuthorCatalogRowAuthorshipV1(placement.authorship).row.kaId,
      rowOrdinal: row.ordinal,
    }))).toEqual([
      { candidateOrdinal: '0', placementKaId: KA_1, rowOrdinal: '0' },
      { candidateOrdinal: '1', placementKaId: KA_2, rowOrdinal: '1' },
    ]);
    expect(Object.isFrozen(composed.materializations)).toBe(true);
    expect(composed.materializations.every(Object.isFrozen)).toBe(true);
    expect(composed.evidence).toMatchObject({
      rowCount: '2',
      highestFinalizedOrdinal: '1',
    });
  });

  it('fails closed on structural capability forgeries and duplicate placement', async () => {
    const placement = await createPlacement(KA_2, ROOT_2);
    expectCode(() => composeFinalizedVmSetV1(requestFor([{
      ...placement,
      authorship: Object.freeze(Object.create(null)) as never,
    }])), 'finalized-vm-composition-placement');
    expectCode(
      () => composeFinalizedVmSetV1(requestFor([placement, placement])),
      'finalized-vm-composition-duplicate',
    );
  });

  it('requires a recoverable author attestation and rejects spliced valid capabilities', async () => {
    const first = await createPlacement(KA_1, ROOT_1);
    const second = await createPlacement(KA_2, ROOT_2);
    const unsigned = await createPlacement(KA_2, ROOT_2, false);

    expectCode(
      () => composeFinalizedVmSetV1(requestFor([unsigned])),
      'finalized-vm-composition-placement',
    );
    expectCode(
      () => composeFinalizedVmSetV1(requestFor([{
        authorship: first.authorship,
        sealBinding: second.sealBinding,
      }])),
      'finalized-vm-composition-mismatch',
    );
  });

  it('binds lane, author attestation, root, publisher, and deployment to chain truth', async () => {
    const placement = await createPlacement(KA_2, ROOT_2);
    const base = requestFor([placement]);
    const mutations: Array<(row: Record<string, unknown>) => void> = [
      (row) => { row.assertionRoot = ROOT_1; },
      (row) => { row.attestedAuthorAddress = null; },
      (row) => { row.publisherAddress = null; },
    ];
    for (const mutate of mutations) {
      const inventory = structuredClone(base.inventory) as unknown as Record<string, unknown>;
      const rows = inventory.rows as Array<Record<string, unknown>>;
      mutate(rows[1]!);
      expectCode(
        () => composeFinalizedVmSetV1({ ...base, inventory } as never),
        'finalized-vm-composition-mismatch',
      );
    }

    expectCode(() => composeFinalizedVmSetV1({
      ...base,
      catalogLane: { contextGraphId: 'another-graph', subGraphName: null },
    } as never), 'finalized-vm-composition-mismatch');
    expectCode(() => composeFinalizedVmSetV1({
      ...base,
      assertedAtKav10Address: `0x${'ab'.repeat(20)}`,
    } as never), 'finalized-vm-composition-mismatch');
  });

  it('rejects a valid placement when the selected catalog author is different', async () => {
    const placement = await createPlacement(KA_2, ROOT_2);
    expectCode(() => composeFinalizedVmSetV1({
      ...requestFor([placement]),
      catalogAuthorAddress: OTHER_AUTHOR,
    }), 'finalized-vm-composition-mismatch');
  });

  it('rejects placements absent from the finalized inventory and malformed unplaced rows', async () => {
    const placement = await createPlacement(KA_2, ROOT_2);
    const base = requestFor([placement]);
    const firstOnly = {
      ...structuredClone(base.inventory),
      highestFinalizedOrdinal: '0',
      rows: [structuredClone(base.inventory.rows[0])],
    };
    expectCode(
      () => composeFinalizedVmSetV1({ ...base, inventory: firstOnly } as never),
      'finalized-vm-composition-mismatch',
    );

    const malformed = structuredClone(base.inventory);
    (malformed.rows[0] as { ual: string }).ual = ual(999n);
    expectCode(
      () => composeFinalizedVmSetV1({ ...base, inventory: malformed } as never),
      'finalized-vm-composition-inventory',
    );
  });

  it('binds the cleartext catalog lane to the exact same-anchor numeric Context Graph', async () => {
    const placement = await createPlacement(KA_2, ROOT_2);
    const base = requestFor([placement]);
    expectCode(() => composeFinalizedVmSetV1({
      ...base,
      inventory: { ...base.inventory, contextGraphId: '15' },
    } as never), 'finalized-vm-composition-mismatch');
    expectCode(() => composeFinalizedVmSetV1({
      ...base,
      finalizedContextGraph: {
        ...base.finalizedContextGraph,
        nameHash: ethers.keccak256(ethers.toUtf8Bytes('another-graph')).toLowerCase(),
      },
    } as never), 'finalized-vm-composition-mismatch');
  });

  it('accepts an empty placement lane without weakening inventory validation', () => {
    const composed = composeFinalizedVmSetV1(requestFor([]));
    expect(composed.rows).toEqual([]);
    expect(composed.evidence).toMatchObject({
      rowCount: '0',
      highestFinalizedOrdinal: null,
    });
  });

  it('requires every finalized private author asset to be present in the catalog', async () => {
    const placement = await createPlacement(KA_1, ROOT_1);
    const request = requestFor([placement]);

    expect(() => composeFinalizedVmSetV1({
      ...request,
      finalizedContextGraph: {
        ...request.finalizedContextGraph,
        accessPolicy: 1,
      },
    })).toThrow(/known-incomplete: no-authorized-provider/u);
  });

  it('accepts the legacy completeness option without allowing it to weaken private policy', async () => {
    const placement = await createPlacement(KA_1, ROOT_1);
    const publicRequest = {
      ...requestFor([placement]),
      requireCompleteAuthorSet: false,
    } satisfies ComposeFinalizedVmSetRequestV1;

    expect(composeFinalizedVmSetV1(publicRequest).rows).toHaveLength(1);
    expect(composeFinalizedVmSetV1({
      ...publicRequest,
      requireCompleteAuthorSet: true,
    }).rows).toHaveLength(1);
    expect(() => composeFinalizedVmSetV1({
      ...publicRequest,
      finalizedContextGraph: {
        ...publicRequest.finalizedContextGraph,
        accessPolicy: 1,
      },
    })).toThrow(/known-incomplete: no-authorized-provider/u);
  });
});

function requestFor(
  placements: readonly FinalizedVmPlacementEvidenceV1[],
): ComposeFinalizedVmSetRequestV1 {
  return {
    assertedAtKav10Address: KAV10,
    catalogAuthorAddress: AUTHOR,
    catalogLane: {
      contextGraphId: CONTEXT_GRAPH_NAME,
      subGraphName: null,
    },
    finalizedContextGraph: {
      chainId: CHAIN_ID,
      contextGraphId: ON_CHAIN_CONTEXT_GRAPH_ID,
      governanceContract: CG_STORAGE,
      blockNumber: '123',
      blockHash: BLOCK_HASH,
      owner: AUTHOR,
      active: true,
      accessPolicy: 0,
      publishPolicy: 1,
      publishAuthority: null,
      publishAuthorityAccountId: '0',
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH_NAME)).toLowerCase(),
    },
    inventory: inventory(),
    placements: [...placements],
  };
}

function inventory(): FinalizedVmChainInventoryV1 {
  return {
    networkId: NETWORK_ID,
    contextGraphId: ON_CHAIN_CONTEXT_GRAPH_ID,
    chainId: CHAIN_ID,
    contractAddress: CG_STORAGE,
    knowledgeAssetStorageAddress: KA_STORAGE,
    finalizedBlockNumber: '123',
    finalizedBlockHash: BLOCK_HASH,
    highestFinalizedOrdinal: '1',
    rows: [
      candidate(KA_1, 0, ROOT_1, '1'),
      candidate(KA_2, 1, ROOT_2, '2'),
    ],
  };
}

function candidate(
  kaId: KaIdV1,
  ordinal: number,
  assertionRoot: Digest32V1,
  assertionVersion: string,
): FinalizedVmChainInventoryV1['rows'][number] {
  const kaNumber = BigInt(kaId) & ((1n << 96n) - 1n);
  return {
    chainId: CHAIN_ID,
    contractAddress: CG_STORAGE,
    knowledgeAssetStorageAddress: KA_STORAGE,
    ordinal: String(ordinal) as never,
    kaId,
    ual: ual(kaNumber),
    authorAddress: AUTHOR,
    attestedAuthorAddress: AUTHOR,
    publisherAddress: PUBLISHER,
    assertionVersion: assertionVersion as never,
    assertionRoot,
    finalizedBlockNumber: '123',
    finalizedBlockHash: BLOCK_HASH,
  };
}

async function createPlacement(
  kaId: KaIdV1,
  assertionRoot: Digest32V1,
  validAttestation = true,
): Promise<FinalizedVmPlacementEvidenceV1> {
  const assertionVersion = kaId === KA_1 ? '1' : '2';
  const scope = {
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_NAME,
    governanceChainId: CHAIN_ID,
    governanceContractAddress: CG_STORAGE,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount: '1',
  } as AuthorCatalogScopeV1;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(CHAIN_ID),
    kav10Address: KAV10,
    merkleRoot: ethers.getBytes(assertionRoot),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(kaId),
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
  });
  const attestation = AUTHOR_WALLET.signingKey.sign(ethers.TypedDataEncoder.hash(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot: assertionRoot,
    authorAddress: AUTHOR,
    authorAttestationR: validAttestation ? attestation.r : `0x${'aa'.repeat(32)}`,
    authorAttestationVS: validAttestation ? attestation.yParityAndS : `0x${'bb'.repeat(32)}`,
    authorSchemeVersion: '1',
    assertedAtChainId: CHAIN_ID,
    assertedAtKav10Address: KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-22T08:00:00.000Z',
    contentScopeVersion: '2',
    kaUal: ual(BigInt(kaId) & ((1n << 96n) - 1n)),
    assertionVersion,
    publicTripleCount: '10',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as CanonicalGraphScopedAuthorSealV1;
  const row = {
    kaId,
    assertionCoordinate: 'vm-fixture',
    assertionVersion,
    projectionId: 'cg-shared-v1',
    projectionDigest: ZERO_DIGEST,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
    transfer: {
      codec: 'dkg-ka-bundle-v1',
      projectionId: 'cg-shared-v1',
      projectionDigest: ZERO_DIGEST,
      byteLength: '16',
      chunkSize: '262144',
      chunkCount: '1',
      blobDigest: `0x${'cc'.repeat(32)}`,
      chunkTreeRoot: `0x${'dd'.repeat(32)}`,
    },
  } as AuthorCatalogRowV1;
  const scopeDigest = computeAuthorCatalogScopeDigestV1(scope);

  const delegation = await signEnvelope({
    issuer: AUTHOR,
    objectType: AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
    payload: {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_NAME,
      governanceChainId: CHAIN_ID,
      governanceContractAddress: CG_STORAGE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0',
      previousDelegationDigest: null,
      catalogIssuerKey: CATALOG_ISSUER,
      authorAuthorityEvidenceDigest: null,
      effectiveAt: '1700000000000',
      expiresAt: '1700000120000',
    },
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }, AUTHOR_WALLET) as SignedAuthorCatalogIssuerDelegationEnvelopeV1;

  const bucketPayload = {
    catalogScopeDigest: scopeDigest,
    era: '0',
    bucketCount: '1',
    bucketId: '0',
    rows: [row],
  };
  const bucket = await signEnvelope({
    issuer: CATALOG_ISSUER,
    objectType: AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
    payload: bucketPayload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }, CATALOG_WALLET) as SignedAuthorCatalogBucketEnvelopeV1;
  const directory = await signEnvelope({
    issuer: CATALOG_ISSUER,
    objectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
    payload: {
      catalogScopeDigest: scopeDigest,
      era: '0',
      level: '0',
      firstBucketId: '0',
      entries: [{
        bucketId: '0',
        bucketDigest: bucket.objectDigest,
        rowCount: '1',
        byteLength: String(canonicalBytes(bucketPayload).byteLength),
      }],
    },
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }, CATALOG_WALLET) as SignedAuthorCatalogDirectoryNodeEnvelopeV1;
  const head = await signEnvelope({
    issuer: CATALOG_ISSUER,
    objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    payload: {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_NAME,
      governanceChainId: CHAIN_ID,
      governanceContractAddress: CG_STORAGE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogIssuerDelegationDigest: delegation.objectDigest,
      era: '0',
      version: '0',
      previousHeadDigest: null,
      bucketCount: '1',
      totalRows: '1',
      directoryHeight: '0',
      directoryRootDigest: directory.objectDigest,
      issuedAt: '1700000000123',
    },
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }, CATALOG_WALLET) as SignedAuthorCatalogHeadEnvelopeV1;

  const authorship = verifyAuthorCatalogRowAuthorshipV1({
    catalogIssuerDelegation: delegation,
    catalogIssuerDelegationSignature: await verifyControlEnvelopeIssuerSignatureV1(delegation),
    parentAuthorAgentEvidence: null,
    catalogHead: head,
    catalogHeadSignature: await verifyControlEnvelopeIssuerSignatureV1(head),
    directoryPathEnvelopes: [directory],
    directoryPathSignatures: [await verifyControlEnvelopeIssuerSignatureV1(directory)],
    directoryPathProof: verifyAuthorCatalogDirectoryPathV1(head, [directory], '0'),
    catalogBucket: bucket,
    catalogBucketSignature: await verifyControlEnvelopeIssuerSignatureV1(bucket),
    targetKaId: kaId,
  });
  const sealBinding = verifyCatalogSealBindingV1(
    scope,
    row,
    canonicalizeCanonicalGraphScopedAuthorSealBytesV1(seal),
    {
      networkId: NETWORK_ID,
      assertedAtChainId: CHAIN_ID,
      assertedAtKav10Address: KAV10,
    },
  );
  return { authorship, sealBinding };
}

async function signEnvelope(
  unsigned: UnsignedControlEnvelopeV1,
  wallet: ethers.Wallet,
): Promise<SignedControlEnvelopeV1> {
  const objectDigest = computeControlObjectDigestHex(unsigned);
  return {
    ...unsigned,
    objectDigest,
    signature: await wallet.signMessage(ethers.getBytes(objectDigest)),
  };
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function packKaId(kaNumber: bigint): KaIdV1 {
  return ((BigInt(AUTHOR) << 96n) | kaNumber).toString() as KaIdV1;
}

function ual(kaNumber: bigint): string {
  return `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`;
}

function expectCode(operation: () => unknown, code: FinalizedVmCompositionErrorV1['code']): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(FinalizedVmCompositionErrorV1);
    expect((error as FinalizedVmCompositionErrorV1).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

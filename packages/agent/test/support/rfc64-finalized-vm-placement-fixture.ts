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
  type KaIdV1,
  type NetworkIdV1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

import {
  verifyAuthorCatalogRowAuthorshipV1,
} from '../../src/rfc64/catalog-row-authorship.js';
import type { FinalizedVmPlacementEvidenceV1 } from '../../src/rfc64/finalized-vm-composer-v1.js';

export const RFC64_VM_AUTHOR_WALLET = new ethers.Wallet(`0x${'11'.repeat(32)}`);
export const RFC64_VM_CATALOG_WALLET = new ethers.Wallet(`0x${'22'.repeat(32)}`);
export const RFC64_VM_AUTHOR = RFC64_VM_AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
export const RFC64_VM_CATALOG_ISSUER =
  RFC64_VM_CATALOG_WALLET.address.toLowerCase() as EvmAddressV1;
export const RFC64_VM_NETWORK_ID = 'otp:20430' as NetworkIdV1;
export const RFC64_VM_CHAIN_ID = '20430' as const;
export const RFC64_VM_CONTEXT_GRAPH_NAME = 'agent-blackbox-vm' as const;
export const RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID = '14' as const;
export const RFC64_VM_CG_STORAGE = `0x${'33'.repeat(20)}` as EvmAddressV1;
export const RFC64_VM_KA_STORAGE = `0x${'44'.repeat(20)}` as EvmAddressV1;
export const RFC64_VM_KAV10 = `0x${'55'.repeat(20)}` as EvmAddressV1;
export const RFC64_VM_PUBLISHER = `0x${'66'.repeat(20)}` as EvmAddressV1;
export const RFC64_VM_BLOCK_HASH = `0x${'77'.repeat(32)}` as Digest32V1;
export const RFC64_VM_ASSERTION_ROOT = `0x${'88'.repeat(32)}` as Digest32V1;
export const RFC64_VM_POLICY_DIGEST = `0x${'ab'.repeat(32)}` as Digest32V1;
const ZERO_DIGEST = `0x${'00'.repeat(32)}` as Digest32V1;

export function rfc64VmPackKaId(kaNumber: bigint): KaIdV1 {
  return ((BigInt(RFC64_VM_AUTHOR) << 96n) | kaNumber).toString() as KaIdV1;
}

export function rfc64VmUal(kaNumber: bigint): string {
  return `did:dkg:${RFC64_VM_NETWORK_ID}/${RFC64_VM_AUTHOR}/${kaNumber}`;
}

export async function createRfc64FinalizedVmPlacementFixture(options: {
  readonly kaNumber?: bigint;
  readonly assertionRoot?: Digest32V1;
  readonly publicTripleCount?: number;
} = {}): Promise<FinalizedVmPlacementEvidenceV1> {
  const kaNumber = options.kaNumber ?? 1n;
  const kaId = rfc64VmPackKaId(kaNumber);
  const assertionRoot = options.assertionRoot ?? RFC64_VM_ASSERTION_ROOT;
  const publicTripleCount = options.publicTripleCount ?? 10;
  if (!Number.isSafeInteger(publicTripleCount) || publicTripleCount < 1) {
    throw new RangeError('publicTripleCount must be a positive safe integer');
  }
  const scope = {
    networkId: RFC64_VM_NETWORK_ID,
    contextGraphId: RFC64_VM_CONTEXT_GRAPH_NAME,
    governanceChainId: RFC64_VM_CHAIN_ID,
    governanceContractAddress: RFC64_VM_CG_STORAGE,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: RFC64_VM_AUTHOR,
    era: '0',
    bucketCount: '1',
  } as AuthorCatalogScopeV1;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(RFC64_VM_CHAIN_ID),
    kav10Address: RFC64_VM_KAV10,
    merkleRoot: ethers.getBytes(assertionRoot),
    authorAddress: RFC64_VM_AUTHOR,
    reservedKaId: BigInt(kaId),
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
  });
  const attestation = RFC64_VM_AUTHOR_WALLET.signingKey.sign(
    ethers.TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message),
  );
  const seal = {
    assertionMerkleRoot: assertionRoot,
    authorAddress: RFC64_VM_AUTHOR,
    authorAttestationR: attestation.r,
    authorAttestationVS: attestation.yParityAndS,
    authorSchemeVersion: String(AUTHOR_SCHEME_VERSION_V1),
    assertedAtChainId: RFC64_VM_CHAIN_ID,
    assertedAtKav10Address: RFC64_VM_KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-22T08:00:00.000Z',
    contentScopeVersion: '2',
    kaUal: rfc64VmUal(kaNumber),
    assertionVersion: '2',
    publicTripleCount: String(publicTripleCount),
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as CanonicalGraphScopedAuthorSealV1;
  const row = {
    kaId,
    assertionCoordinate: 'vm-runtime-fixture',
    assertionVersion: '2',
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
    issuer: RFC64_VM_AUTHOR,
    objectType: AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
    payload: {
      networkId: RFC64_VM_NETWORK_ID,
      contextGraphId: RFC64_VM_CONTEXT_GRAPH_NAME,
      governanceChainId: RFC64_VM_CHAIN_ID,
      governanceContractAddress: RFC64_VM_CG_STORAGE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: RFC64_VM_AUTHOR,
      catalogEra: '0',
      previousDelegationDigest: null,
      catalogIssuerKey: RFC64_VM_CATALOG_ISSUER,
      authorAuthorityEvidenceDigest: null,
      effectiveAt: '1700000000000',
      expiresAt: '1700000120000',
    },
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }, RFC64_VM_AUTHOR_WALLET) as SignedAuthorCatalogIssuerDelegationEnvelopeV1;

  const bucketPayload = {
    catalogScopeDigest: scopeDigest,
    era: '0',
    bucketCount: '1',
    bucketId: '0',
    rows: [row],
  };
  const bucket = await signEnvelope({
    issuer: RFC64_VM_CATALOG_ISSUER,
    objectType: AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
    payload: bucketPayload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }, RFC64_VM_CATALOG_WALLET) as SignedAuthorCatalogBucketEnvelopeV1;
  const directory = await signEnvelope({
    issuer: RFC64_VM_CATALOG_ISSUER,
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
  }, RFC64_VM_CATALOG_WALLET) as SignedAuthorCatalogDirectoryNodeEnvelopeV1;
  const head = await signEnvelope({
    issuer: RFC64_VM_CATALOG_ISSUER,
    objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    payload: {
      networkId: RFC64_VM_NETWORK_ID,
      contextGraphId: RFC64_VM_CONTEXT_GRAPH_NAME,
      governanceChainId: RFC64_VM_CHAIN_ID,
      governanceContractAddress: RFC64_VM_CG_STORAGE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: RFC64_VM_AUTHOR,
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
  }, RFC64_VM_CATALOG_WALLET) as SignedAuthorCatalogHeadEnvelopeV1;

  return {
    authorship: verifyAuthorCatalogRowAuthorshipV1({
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
    }),
    sealBinding: verifyCatalogSealBindingV1(
      scope,
      row,
      canonicalizeCanonicalGraphScopedAuthorSealBytesV1(seal),
      {
        networkId: RFC64_VM_NETWORK_ID,
        assertedAtChainId: RFC64_VM_CHAIN_ID,
        assertedAtKav10Address: RFC64_VM_KAV10,
      },
    ),
  };
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

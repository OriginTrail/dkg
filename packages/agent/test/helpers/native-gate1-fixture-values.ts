import {
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  assertAuthorCatalogRowV1,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeAuthorCatalogHeadObjectDigestV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeControlObjectDigestHex,
  computeKaChunkTreeRootV1,
  encodeOpaqueKaBundleV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type AuthorCatalogHeadV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { type TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

export const AUTHOR_WALLET = new ethers.Wallet(`0x${'66'.repeat(32)}`);
export const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
export const NETWORK_ID = 'otp:20430' as NetworkIdV1;
export const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/native-gate-1' as ContextGraphIdV1;
export const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
export const GOVERNANCE_CONTRACT =
  '0x5555555555555555555555555555555555555555' as EvmAddressV1;
export const POLICY_DIGEST = `0x${'75'.repeat(32)}` as Digest32V1;
export const MISSING_DELEGATION_DIGEST = `0x${'76'.repeat(32)}` as Digest32V1;
export const KA_NUMBER = 7n;
export const KA_ID = ((BigInt(AUTHOR) << 96n) | KA_NUMBER).toString();
export const UAL = `did:dkg:${NETWORK_ID}/${AUTHOR}/${KA_NUMBER}`;
export const SECOND_KA_NUMBER = 8n;
export const SECOND_KA_ID = ((BigInt(AUTHOR) << 96n) | SECOND_KA_NUMBER).toString();
export const SECOND_UAL = `did:dkg:${NETWORK_ID}/${AUTHOR}/${SECOND_KA_NUMBER}`;
export const THIRD_KA_NUMBER = 9n;
export const PROJECTION =
  '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n';
export const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f' as Digest32V1;
export const UTF8 = new TextEncoder();
export const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;
export const TRANSACTION_TEST_VM_GRAPH = 'urn:rfc64:test:private-vm-generation';
export const TRANSACTION_TEST_VM_SUBJECT = 'urn:rfc64:test:private-vm-asset';
export const TRANSACTION_TEST_VM_PREDICATE = 'urn:rfc64:test:private-vm-head';

export async function readExactSemanticPairForTest(
  store: TripleStore,
  graph: string,
  sealMetaGraph: string,
  sealSubject: string,
): Promise<{
  readonly graph: readonly Readonly<Record<string, string>>[];
  readonly seal: readonly Readonly<Record<string, string>>[];
}> {
  const [graphResult, sealResult] = await Promise.all([
    store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`,
    ),
    store.query(
      `SELECT ?p ?o WHERE { GRAPH <${sealMetaGraph}> { `
        + `<${sealSubject}> ?p ?o } } ORDER BY ?p ?o`,
    ),
  ]);
  if (graphResult.type !== 'bindings' || sealResult.type !== 'bindings') {
    throw new Error('exact semantic pair test read did not return bindings');
  }
  return Object.freeze({
    graph: Object.freeze(graphResult.bindings.map((row) => Object.freeze({ ...row }))),
    seal: Object.freeze(sealResult.bindings.map((row) => Object.freeze({ ...row }))),
  });
}

export async function setTransactionTestVmGeneration(
  store: TripleStore,
  generation: 'predecessor' | 'target',
): Promise<void> {
  if (store.replaceGraph === undefined) {
    throw new Error('transaction test requires atomic graph replacement');
  }
  await store.replaceGraph(TRANSACTION_TEST_VM_GRAPH, [{
    subject: TRANSACTION_TEST_VM_SUBJECT,
    predicate: TRANSACTION_TEST_VM_PREDICATE,
    object: `"${generation}"`,
    graph: TRANSACTION_TEST_VM_GRAPH,
  }]);
}

export async function readTransactionTestVmGeneration(
  store: TripleStore,
): Promise<'predecessor' | 'target'> {
  const result = await store.query(
    `SELECT ?generation WHERE { GRAPH <${TRANSACTION_TEST_VM_GRAPH}> { `
      + `<${TRANSACTION_TEST_VM_SUBJECT}> <${TRANSACTION_TEST_VM_PREDICATE}> ?generation } }`,
  );
  if (result.type !== 'bindings' || result.bindings.length !== 1) {
    throw new Error('transaction test VM generation is not exact');
  }
  const generation = result.bindings[0]?.generation;
  if (generation === '"predecessor"') return 'predecessor';
  if (generation === '"target"') return 'target';
  throw new Error('transaction test VM generation is invalid');
}

export async function buildDirectCatalogIssuerDelegation(options: {
  readonly scope?: AuthorCatalogScopeV1;
  readonly contextGraphId?: ContextGraphIdV1;
  readonly effectiveAt?: string;
  readonly expiresAt?: string;
} = {}): Promise<SignedAuthorCatalogIssuerDelegationEnvelopeV1> {
  const scope = options.scope ?? {
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount: '1',
  } as AuthorCatalogScopeV1;
  const unsigned = testUnsignedEnvelope(
    AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
    {
      authorAddress: scope.authorAddress,
      authorAuthorityEvidenceDigest: null,
      catalogEra: scope.era,
      catalogIssuerKey: AUTHOR,
      contextGraphId: options.contextGraphId ?? scope.contextGraphId,
      effectiveAt: options.effectiveAt ?? '1773899999000',
      expiresAt: options.expiresAt ?? '1774000000000',
      governanceChainId: scope.governanceChainId,
      governanceContractAddress: scope.governanceContractAddress,
      networkId: scope.networkId,
      ownershipTransitionDigest: scope.ownershipTransitionDigest,
      previousDelegationDigest: null,
      subGraphName: scope.subGraphName,
    },
  );
  return signTestEnvelope(
    unsigned,
    computeControlObjectDigestHex(unsigned) as Digest32V1,
  ) as Promise<SignedAuthorCatalogIssuerDelegationEnvelopeV1>;
}

export async function rewriteCatalogHeadDelegation(
  sourceHead: SignedAuthorCatalogHeadEnvelopeV1,
  catalogIssuerDelegationDigest: Digest32V1,
): Promise<SignedAuthorCatalogHeadEnvelopeV1> {
  const headPayload = {
    ...sourceHead.payload,
    catalogIssuerDelegationDigest,
  } as AuthorCatalogHeadV1;
  const unsigned = testUnsignedEnvelope(AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1, headPayload);
  return signTestEnvelope(
    unsigned,
    computeAuthorCatalogHeadObjectDigestV1(unsigned),
  ) as Promise<SignedAuthorCatalogHeadEnvelopeV1>;
}

export async function buildInvalidEmptyGenesis(
  sourceHead: SignedAuthorCatalogHeadEnvelopeV1,
  sourceDirectory: SignedAuthorCatalogDirectoryNodeEnvelopeV1,
): Promise<{
  head: SignedAuthorCatalogHeadEnvelopeV1;
  stagedObjects: readonly SignedControlEnvelopeV1[];
}> {
  const headPayload = {
    ...sourceHead.payload,
    directoryRootDigest: sourceDirectory.objectDigest,
  } as AuthorCatalogHeadV1;
  const headUnsigned = testUnsignedEnvelope(AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1, headPayload);
  const head = await signTestEnvelope(
    headUnsigned,
    computeAuthorCatalogHeadObjectDigestV1(headUnsigned),
  ) as SignedAuthorCatalogHeadEnvelopeV1;
  return Object.freeze({ head, stagedObjects: Object.freeze([sourceDirectory, head]) });
}

export async function buildMalformedEmptySuccessor(
  sourceHead: SignedAuthorCatalogHeadEnvelopeV1,
  sourceDirectory: SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  descriptorOverrides: Readonly<Record<string, string>>,
): Promise<{
  head: SignedAuthorCatalogHeadEnvelopeV1;
  stagedObjects: readonly SignedControlEnvelopeV1[];
}> {
  const sourceDescriptor = sourceDirectory.payload.entries[0];
  if (sourceDescriptor === undefined) throw new Error('empty successor descriptor is missing');
  const directoryUnsigned = testUnsignedEnvelope(
    AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
    {
      ...sourceDirectory.payload,
      entries: [{ ...sourceDescriptor, ...descriptorOverrides }],
    },
  );
  // Deliberately bypass the directory-specific encoder: these fixtures prove
  // the receiver rejects signed but structurally malformed empty descriptors.
  const directory = await signTestEnvelope(
    directoryUnsigned,
    computeControlObjectDigestHex(directoryUnsigned) as Digest32V1,
  ) as SignedAuthorCatalogDirectoryNodeEnvelopeV1;
  const headUnsigned = testUnsignedEnvelope(AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1, {
    ...sourceHead.payload,
    directoryRootDigest: directory.objectDigest,
  });
  const head = await signTestEnvelope(
    headUnsigned,
    computeAuthorCatalogHeadObjectDigestV1(headUnsigned),
  ) as SignedAuthorCatalogHeadEnvelopeV1;
  return Object.freeze({ head, stagedObjects: Object.freeze([directory, head]) });
}

export function testUnsignedEnvelope(
  objectType: string,
  payload: unknown,
): UnsignedControlEnvelopeV1 {
  return Object.freeze({
    issuer: AUTHOR,
    objectType,
    payload,
    signatureEvidence: Object.freeze({ kind: 'none' }),
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }) as UnsignedControlEnvelopeV1;
}

export async function signTestEnvelope(
  unsigned: UnsignedControlEnvelopeV1,
  objectDigest: Digest32V1,
): Promise<SignedControlEnvelopeV1> {
  return Object.freeze({
    ...unsigned,
    objectDigest,
    signature: await AUTHOR_WALLET.signMessage(ethers.getBytes(objectDigest)),
  }) as SignedControlEnvelopeV1;
}

export function alternateRecoveryEncoding(signature: string): string {
  const recovery = signature.slice(-2);
  if (recovery === '1b') return `${signature.slice(0, -2)}00`;
  if (recovery === '1c') return `${signature.slice(0, -2)}01`;
  throw new Error('test fixture signature did not use canonical v=27/28 encoding');
}

export async function buildRowBundle(
  signingWallet: ethers.Wallet = AUTHOR_WALLET,
  options: {
    readonly kaNumber?: bigint;
    readonly assertionCoordinate?: string;
  } = {},
): Promise<{ row: AuthorCatalogRowV1; bundleBytes: Uint8Array; kaUal: string }> {
  const kaNumber = options.kaNumber ?? KA_NUMBER;
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const kaUal = `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(ASSERTION_ROOT),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(kaId),
  });
  const authorSignature = ethers.Signature.from(await signingWallet.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  const seal = {
    assertionMerkleRoot: ASSERTION_ROOT,
    authorAddress: AUTHOR,
    authorAttestationR: authorSignature.r,
    authorAttestationVS: authorSignature.yParityAndS,
    authorSchemeVersion: '1',
    assertedAtChainId: '20430',
    assertedAtKav10Address: KAV10,
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal,
    assertionVersion: '1',
    publicTripleCount: '2',
    privateTripleCount: '0',
    privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
  assertCanonicalGraphScopedAuthorSealV1(seal);
  const encoded = encodeOpaqueKaBundleV1(
    UTF8.encode(PROJECTION),
    canonicalizeCanonicalGraphScopedAuthorSealBytesV1(seal),
  );
  const byteLength = BigInt(encoded.bundleBytes.byteLength);
  const row = {
    kaId,
    assertionCoordinate: options.assertionCoordinate ?? 'gate-1-object',
    assertionVersion: '1',
    projectionId: 'cg-shared-v1',
    projectionDigest: encoded.projectionDigest,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
    transfer: {
      codec: 'dkg-ka-bundle-v1',
      projectionId: 'cg-shared-v1',
      projectionDigest: encoded.projectionDigest,
      byteLength: byteLength.toString(),
      chunkSize: '262144',
      chunkCount: (((byteLength - 1n) / 262_144n) + 1n).toString(),
      blobDigest: encoded.blobDigest,
      chunkTreeRoot: computeKaChunkTreeRootV1(encoded.bundleBytes),
    },
  } as unknown as AuthorCatalogRowV1;
  assertAuthorCatalogRowV1(row);
  return { row, bundleBytes: encoded.bundleBytes, kaUal };
}

import {
  assertAuthorCatalogRowV1,
  assertAuthorCatalogScopeV1,
  assertCanonicalGraphScopedAuthorSealV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  compileRfc64SharedProjectionStreamOperationV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaProjectionDigestV1,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  verifyCatalogSealBindingV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
} from '@origintrail-official/dkg-core';

export const RFC64_PROJECTION_TEST_AUTHOR =
  '0x3333333333333333333333333333333333333333';
export const RFC64_PROJECTION_TEST_KAV10 =
  '0x4444444444444444444444444444444444444444';
export const RFC64_PROJECTION_TEST_KA_ID =
  '23158417847463239084714197001737581570653996933112267175388663934063917137927';
export const RFC64_PROJECTION_TEST_GRAPH =
  `did:dkg:context-graph:v1/root/a%2Fb/_shared_memory/${RFC64_PROJECTION_TEST_AUTHOR}/7`;

export interface Rfc64ProjectionTestTriple {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
}

export interface Rfc64SharedProjectionTestFixtureOptions {
  readonly triples?: readonly Rfc64ProjectionTestTriple[];
  readonly projectionBytes?: Uint8Array;
  readonly publicTripleCount?: string;
  readonly contextGraphId?: string;
  readonly assertionCoordinate?: string;
}

/** One shared seal-bound fixture for gateway and certified-adapter suites. */
export function createRfc64SharedProjectionTestFixture(
  options: Rfc64SharedProjectionTestFixtureOptions = {},
) {
  const triples = options.triples ?? Object.freeze([
    Object.freeze({ subject: 'urn:a', predicate: 'urn:p', object: '"alpha"' }),
    Object.freeze({ subject: 'urn:z', predicate: 'urn:p', object: '"zeta"' }),
  ]);
  const projectionBytes = options.projectionBytes?.slice()
    ?? encodeCanonicalCgSharedPublicRootProjectionV1(triples);
  const publicTripleCount = options.publicTripleCount ?? String(triples.length);
  const contextGraphId = options.contextGraphId ?? 'a/b';
  const scope = validScope({
    networkId: 'otp:20430',
    contextGraphId,
    governanceChainId: '20430',
    governanceContractAddress: '0x5555555555555555555555555555555555555555',
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: RFC64_PROJECTION_TEST_AUTHOR,
    era: '0',
    bucketCount: '1',
  });
  const profile = {
    networkId: 'otp:20430',
    assertedAtChainId: '20430',
    assertedAtKav10Address: RFC64_PROJECTION_TEST_KAV10,
  } as CatalogSealDeploymentProfileV1;
  const seal = validSeal({
    assertionMerkleRoot: `0x${'aa'.repeat(32)}`,
    authorAddress: RFC64_PROJECTION_TEST_AUTHOR,
    authorAttestationR: `0x${'11'.repeat(32)}`,
    authorAttestationVS: `0x${'22'.repeat(32)}`,
    authorSchemeVersion: '1',
    assertedAtChainId: '20430',
    assertedAtKav10Address: RFC64_PROJECTION_TEST_KAV10,
    reservedKaId: RFC64_PROJECTION_TEST_KA_ID,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: `did:dkg:otp:20430/${RFC64_PROJECTION_TEST_AUTHOR}/7`,
    assertionVersion: '2',
    publicTripleCount,
    privateTripleCount: '0',
    privateMerkleRoot: null,
  });
  const projectionDigest = computeKaProjectionDigestV1(projectionBytes);
  const row = validRow({
    kaId: RFC64_PROJECTION_TEST_KA_ID,
    assertionCoordinate: options.assertionCoordinate ?? 'name λ',
    assertionVersion: '2',
    projectionId: 'cg-shared-v1',
    projectionDigest,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
    transfer: {
      codec: 'dkg-ka-bundle-v1',
      projectionId: 'cg-shared-v1',
      projectionDigest,
      byteLength: '4096',
      chunkSize: '262144',
      chunkCount: '1',
      blobDigest: `0x${'11'.repeat(32)}`,
      chunkTreeRoot: `0x${'22'.repeat(32)}`,
    },
  });
  const request = Object.freeze({
    sealBinding: verifyCatalogSealBindingV1(
      scope,
      row,
      canonicalizeCanonicalGraphScopedAuthorSealBytesV1(seal),
      profile,
    ),
  });
  const operation = compileRfc64SharedProjectionStreamOperationV1(request);
  return Object.freeze({
    graph: operation.graphIri,
    operation,
    profile,
    projectionBytes,
    projectionDigest,
    request,
    row,
    scope,
    seal,
    triples,
  });
}

function validScope(value: unknown): AuthorCatalogScopeV1 {
  assertAuthorCatalogScopeV1(value);
  return value;
}

function validRow(value: unknown): AuthorCatalogRowV1 {
  assertAuthorCatalogRowV1(value);
  return value;
}

function validSeal(value: unknown): CanonicalGraphScopedAuthorSealV1 {
  assertCanonicalGraphScopedAuthorSealV1(value);
  return value;
}

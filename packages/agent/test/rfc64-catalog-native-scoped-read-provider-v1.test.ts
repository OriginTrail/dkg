import {
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  KA_TRANSFER_CHUNK_SIZE_V1,
  KA_TRANSFER_CODEC_V1,
  KA_TRANSFER_PROJECTION_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  assertAuthorCatalogRowV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  computeAuthorCatalogBucketObjectDigestV1,
  computeAuthorCatalogDirectoryNodeObjectDigestV1,
  computeAuthorCatalogHeadObjectDigestV1,
  computeAuthorCatalogScopeDigestV1,
  computeKaChunkTreeRootV1,
  encodeOpaqueKaBundleV1,
  type AuthorCatalogBucketV1,
  type AuthorCatalogDirectoryNodeV1,
  type AuthorCatalogHeadV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type ByteLengthV1,
  type CountV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type ContextGraphPolicyV1,
  type MemberRosterV1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import {
  produceEmptyAuthorCatalogGenesisV1,
} from '../src/rfc64/author-catalog-producer.js';
import { createRfc64CatalogNativeScopedReadProviderV1 } from '../src/rfc64/catalog-native-scoped-read-provider-v1.js';
import type { AcceptedRfc64CatalogAccessSnapshotV1 } from '../src/rfc64/catalog-access-policy-v1.js';
import { produceDirectAuthorCatalogIssuerDelegationV1 } from '../src/rfc64/public-catalog-issuer-delegation-v1.js';
import type { Rfc64PublicCatalogNativeFetchScopeV1 } from '../src/rfc64/public-catalog-native-transport-v1.js';

const WALLET = new ethers.Wallet(`0x${'65'.repeat(32)}`);
const AUTHOR = WALLET.address.toLowerCase() as EvmAddressV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/private-scoped-provider';
const POLICY_DIGEST = `0x${'73'.repeat(32)}` as Digest32V1;
const SEAL_DIGEST = `0x${'44'.repeat(32)}` as Digest32V1;
const UTF8 = new TextEncoder();

function acceptedPrivatePolicy(options: {
  era?: string;
  includeAuthor?: boolean;
} = {}) {
  const era = options.era ?? '0';
  const policy = {
    networkId: 'otp:20430',
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    era,
    version: '0',
    previousPolicyDigest: null,
    accessPolicy: 1,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'owner-signed-unregistered',
      ownerAddress: AUTHOR,
      ownerAuthorityEra: era,
    },
    effectiveAt: '0',
    issuedAt: '0',
  } as ContextGraphPolicyV1;
  const roster = {
    networkId: policy.networkId,
    contextGraphId: policy.contextGraphId,
    ownershipTransitionDigest: policy.ownershipTransitionDigest,
    era: policy.era,
    version: '0',
    previousRosterDigest: null,
    policyDigest: POLICY_DIGEST,
    administrativeDelegationDigest: policy.administrativeDelegationDigest,
    members: options.includeAuthor === false
      ? []
      : [{ agentAddress: AUTHOR, roles: ['holder', 'provider'] }],
    issuedAt: '0',
  } as MemberRosterV1;
  return Object.freeze({ policy, policyDigest: POLICY_DIGEST, roster });
}

function acceptedPublicPolicy(): AcceptedRfc64CatalogAccessSnapshotV1 {
  const privateSnapshot = acceptedPrivatePolicy();
  return Object.freeze({
    policy: Object.freeze({ ...privateSnapshot.policy, accessPolicy: 0 }),
    policyDigest: privateSnapshot.policyDigest,
    roster: null,
  });
}

async function providerFixture(
  accepted: AcceptedRfc64CatalogAccessSnapshotV1 = acceptedPrivatePolicy(),
  verifyIssuerSignature: typeof verifyControlEnvelopeIssuerSignatureV1 =
    verifyControlEnvelopeIssuerSignatureV1,
  rowCount = 1,
  resolveAcceptedPolicySnapshot: () => AcceptedRfc64CatalogAccessSnapshotV1 | null
    | Promise<AcceptedRfc64CatalogAccessSnapshotV1 | null> = async () => accepted,
  onAuthorCatalogBucketProof?: () => void,
) {
  const catalogScope = {
    networkId: 'otp:20430',
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount: '1',
  } as AuthorCatalogScopeV1;
  const signer = {
    issuer: AUTHOR,
    signDigest: (digest: Uint8Array) => WALLET.signMessage(digest),
  };
  const delegation = await produceDirectAuthorCatalogIssuerDelegationV1({
    scope: catalogScope,
    signer,
    effectiveAt: '1773899999000' as never,
    expiresAt: '1774000000000' as never,
    catalogHeadIssuedAt: '1773900000000' as never,
  });
  const genesis = await produceEmptyAuthorCatalogGenesisV1({
    scope: catalogScope,
    catalogIssuerDelegationDigest:
      delegation.authorization.catalogIssuerDelegation.objectDigest as Digest32V1,
    issuedAt: '1773900000000' as never,
    signer,
  });
  const bundle = encodeOpaqueKaBundleV1(
    UTF8.encode('<https://example.org/private> <https://schema.org/name> "Private" .\n'),
    new Uint8Array(),
  );
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const row = {
      kaId: ((BigInt(AUTHOR) << 96n) | BigInt(index + 1)).toString(),
      assertionCoordinate: `private-release-${String(index + 1).padStart(4, '0')}`,
      assertionVersion: '1',
      projectionId: KA_TRANSFER_PROJECTION_V1,
      projectionDigest: `0x${'11'.repeat(32)}`,
      sealDigest: SEAL_DIGEST,
      transfer: {
        codec: KA_TRANSFER_CODEC_V1,
        projectionId: KA_TRANSFER_PROJECTION_V1,
        projectionDigest: `0x${'11'.repeat(32)}`,
        byteLength: bundle.bundleBytes.byteLength.toString(),
        chunkSize: KA_TRANSFER_CHUNK_SIZE_V1,
        chunkCount: '1',
        blobDigest: bundle.blobDigest,
        chunkTreeRoot: computeKaChunkTreeRootV1(bundle.bundleBytes),
      },
    } as unknown as AuthorCatalogRowV1;
    assertAuthorCatalogRowV1(row);
    return row;
  });
  const successor = await produceExactSetFixtureV1(
    catalogScope,
    delegation.authorization.catalogIssuerDelegation.objectDigest as Digest32V1,
    genesis.head.objectDigest as Digest32V1,
    rows,
  );
  const envelopes: SignedControlEnvelopeV1[] = [
    delegation.authorization.catalogIssuerDelegation,
    ...successor.stagedObjects,
  ];
  const stored = new Map<string, {
    readonly envelope: SignedControlEnvelopeV1;
    readonly issuerSignature: Awaited<ReturnType<typeof verifyControlEnvelopeIssuerSignatureV1>>;
  }>();
  for (const envelope of envelopes) {
    stored.set(envelope.objectDigest, {
      envelope,
      issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
    });
  }
  const unrelated = genesis.head;
  stored.set(unrelated.objectDigest, {
    envelope: unrelated,
    issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(unrelated),
  });
  const controlRead = vi.fn(async ({
    objectDigest,
    verifyIssuerSignature: verifyStoredIssuerSignature,
  }: {
    objectDigest: Digest32V1;
    verifyIssuerSignature: typeof verifyControlEnvelopeIssuerSignatureV1;
  }) => {
    const retained = stored.get(objectDigest);
    if (retained === undefined) return null;
    return {
      envelope: retained.envelope,
      issuerSignature: await verifyStoredIssuerSignature(retained.envelope),
    };
  });
  const bundleRead = vi.fn(async (blobDigest: Digest32V1) =>
    blobDigest === bundle.blobDigest ? bundle.bundleBytes : null);
  const resolve = createRfc64CatalogNativeScopedReadProviderV1({
    controlObjects: { getVerifiedObjectByDigest: controlRead } as never,
    kaBundles: { readKaBundleByDigest: bundleRead },
    verifyIssuerSignature,
    resolveAcceptedPolicySnapshot,
    onAuthorCatalogBucketProof,
  });
  const scope = Object.freeze({
    networkId: successor.head.payload.networkId,
    contextGraphId: successor.head.payload.contextGraphId,
    subGraphName: successor.head.payload.subGraphName,
    authorAddress: successor.head.payload.authorAddress,
    catalogEra: successor.head.payload.era,
    catalogVersion: successor.head.payload.version,
    policyDigest: POLICY_DIGEST,
    catalogHeadObjectDigest: successor.head.objectDigest as Digest32V1,
  }) satisfies Rfc64PublicCatalogNativeFetchScopeV1;
  return {
    bundle,
    bundleRead,
    controlRead,
    delegation: delegation.authorization.catalogIssuerDelegation,
    genesis,
    resolve,
    rows,
    scope,
    stored,
    successor,
  };
}

async function produceExactSetFixtureV1(
  scope: AuthorCatalogScopeV1,
  catalogIssuerDelegationDigest: Digest32V1,
  previousHeadDigest: Digest32V1,
  rows: AuthorCatalogRowV1[],
) {
  const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  const bucketPayload: AuthorCatalogBucketV1 = {
    catalogScopeDigest,
    era: scope.era,
    bucketCount: scope.bucketCount,
    bucketId: '0' as DecimalU64V1,
    rows,
  };
  const bucket = await signFixtureEnvelopeV1(
    scope.authorAddress,
    AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
    bucketPayload,
    computeAuthorCatalogBucketObjectDigestV1,
  );
  const directoryPayload: AuthorCatalogDirectoryNodeV1 = {
    catalogScopeDigest,
    era: scope.era,
    level: '0' as DecimalU64V1,
    firstBucketId: '0' as DecimalU64V1,
    entries: [{
      bucketId: '0' as DecimalU64V1,
      bucketDigest: bucket.objectDigest as Digest32V1,
      rowCount: rows.length.toString() as CountV1,
      byteLength: canonicalizeAuthorCatalogBucketPayloadBytesV1(bucketPayload)
        .byteLength.toString() as ByteLengthV1,
    }],
  };
  const directory = await signFixtureEnvelopeV1(
    scope.authorAddress,
    AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
    directoryPayload,
    (value) => computeAuthorCatalogDirectoryNodeObjectDigestV1(value, scope.bucketCount),
  );
  const headPayload: AuthorCatalogHeadV1 = {
    networkId: scope.networkId,
    contextGraphId: scope.contextGraphId,
    governanceChainId: scope.governanceChainId,
    governanceContractAddress: scope.governanceContractAddress,
    ownershipTransitionDigest: scope.ownershipTransitionDigest,
    subGraphName: scope.subGraphName,
    authorAddress: scope.authorAddress,
    catalogIssuerDelegationDigest,
    era: scope.era,
    version: '1' as DecimalU64V1,
    previousHeadDigest,
    bucketCount: scope.bucketCount,
    totalRows: rows.length.toString() as CountV1,
    directoryHeight: '0' as DecimalU64V1,
    directoryRootDigest: directory.objectDigest as Digest32V1,
    issuedAt: '1773900001000' as never,
  };
  const head = await signFixtureEnvelopeV1(
    scope.authorAddress,
    AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    headPayload,
    computeAuthorCatalogHeadObjectDigestV1,
  );
  return Object.freeze({
    bucket,
    directoryPath: Object.freeze([directory]),
    head,
    stagedObjects: Object.freeze([bucket, directory, head]),
  });
}

async function signFixtureEnvelopeV1(
  issuer: EvmAddressV1,
  objectType: string,
  payload: unknown,
  computeDigest: (input: UnsignedControlEnvelopeV1) => Digest32V1,
): Promise<SignedControlEnvelopeV1> {
  const unsigned = {
    issuer,
    objectType,
    payload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as UnsignedControlEnvelopeV1;
  const objectDigest = computeDigest(unsigned);
  return {
    ...unsigned,
    objectDigest,
    signature: await WALLET.signMessage(ethers.getBytes(objectDigest)),
  } as SignedControlEnvelopeV1;
}

describe('RFC-64 catalog native scoped read provider v1', () => {
  it('closes one exact signed bounded head and exposes only its reachable digests', async () => {
    const fixture = await providerFixture();
    const capability = await fixture.resolve(fixture.scope);
    expect(capability).not.toBeNull();
    expect(capability?.scope).toEqual(fixture.scope);

    await expect(capability?.readCatalogObjectByDigest(
      fixture.successor.directoryPath[0]!.objectDigest as Digest32V1,
    )).resolves.toEqual(fixture.successor.directoryPath[0]);
    await expect(capability?.readCatalogObjectByDigest(
      fixture.successor.bucket!.objectDigest as Digest32V1,
    )).resolves.toEqual(fixture.successor.bucket);
    await expect(capability?.readCatalogObjectByDigest(
      fixture.delegation.objectDigest as Digest32V1,
    )).resolves.toEqual(fixture.delegation);
    await expect(capability?.readKaBundleByDigest(fixture.bundle.blobDigest))
      .resolves.toEqual(fixture.bundle.bundleBytes);

    // This is a valid signed object in the same shared store, but it is not in
    // the requested successor closure.
    await expect(capability?.readCatalogObjectByDigest(
      fixture.genesis.head.objectDigest as Digest32V1,
    )).resolves.toBeNull();
    await expect(capability?.readKaBundleByDigest(
      `0x${'91'.repeat(32)}` as Digest32V1,
    )).resolves.toBeNull();
  });

  it('closes the same exact digest boundary for an accepted public catalog', async () => {
    const fixture = await providerFixture(acceptedPublicPolicy());
    const capability = await fixture.resolve(fixture.scope);
    expect(capability).not.toBeNull();
    await expect(capability?.readCatalogObjectByDigest(
      fixture.successor.directoryPath[0]!.objectDigest as Digest32V1,
    )).resolves.toEqual(fixture.successor.directoryPath[0]);
    await expect(capability?.readKaBundleByDigest(fixture.bundle.blobDigest))
      .resolves.toEqual(fixture.bundle.bundleBytes);
    await expect(capability?.readCatalogObjectByDigest(
      fixture.genesis.head.objectDigest as Digest32V1,
    )).resolves.toBeNull();
    await expect(capability?.readKaBundleByDigest(
      `0x${'91'.repeat(32)}` as Digest32V1,
    )).resolves.toBeNull();
  });

  it.each([
    {
      label: 'context graph',
      mutate: (scope: Rfc64PublicCatalogNativeFetchScopeV1) => ({
        ...scope,
        contextGraphId:
          '0x1111111111111111111111111111111111111111/other-private' as never,
      }),
    },
    {
      label: 'head digest',
      mutate: (scope: Rfc64PublicCatalogNativeFetchScopeV1) => ({
        ...scope,
        catalogHeadObjectDigest: `0x${'92'.repeat(32)}` as Digest32V1,
      }),
    },
    {
      label: 'catalog version',
      mutate: (scope: Rfc64PublicCatalogNativeFetchScopeV1) => ({
        ...scope,
        catalogVersion: '2' as never,
      }),
    },
    {
      label: 'subgraph',
      mutate: (scope: Rfc64PublicCatalogNativeFetchScopeV1) => ({
        ...scope,
        subGraphName: 'private-lane' as never,
      }),
    },
    {
      label: 'author',
      mutate: (scope: Rfc64PublicCatalogNativeFetchScopeV1) => ({
        ...scope,
        authorAddress: `0x${'12'.repeat(20)}` as EvmAddressV1,
      }),
    },
    {
      label: 'catalog era',
      mutate: (scope: Rfc64PublicCatalogNativeFetchScopeV1) => ({
        ...scope,
        catalogEra: '1' as never,
      }),
    },
    {
      label: 'policy digest',
      mutate: (scope: Rfc64PublicCatalogNativeFetchScopeV1) => ({
        ...scope,
        policyDigest: `0x${'13'.repeat(32)}` as Digest32V1,
      }),
    },
  ])('refuses a mismatched $label without granting a capability', async ({ mutate }) => {
    const fixture = await providerFixture();
    const accepted = await fixture.resolve(fixture.scope);
    expect(accepted).not.toBeNull();
    await expect(fixture.resolve(mutate(fixture.scope))).resolves.toBeNull();
    await expect(fixture.resolve(fixture.scope)).resolves.toBe(accepted);
    expect(fixture.bundleRead).not.toHaveBeenCalled();
  });

  it('refuses a closure when its exact direct-author delegation is absent', async () => {
    const fixture = await providerFixture();
    const delegationDigest = fixture.delegation.objectDigest;
    const retainedDelegation = fixture.stored.get(delegationDigest)!;
    fixture.controlRead.mockImplementation(async ({ objectDigest }) =>
      objectDigest === delegationDigest ? null : fixture.stored.get(objectDigest) ?? null);
    await expect(fixture.resolve(fixture.scope)).resolves.toBeNull();
    expect(fixture.bundleRead).not.toHaveBeenCalled();

    fixture.controlRead.mockImplementation(async ({ objectDigest }) =>
      objectDigest === delegationDigest
        ? retainedDelegation
        : fixture.stored.get(objectDigest) ?? null);
    await expect(fixture.resolve(fixture.scope)).resolves.not.toBeNull();
  });

  it('denies private bundle delivery when the configured signature verifier rejects cache', async () => {
    const configuredVerifier = vi.fn(async () => {
      throw new Error('catalog signer revoked by configured verifier');
    });
    const fixture = await providerFixture(acceptedPrivatePolicy(), configuredVerifier);

    const delivered = await fixture.resolve(fixture.scope).then(async (capability) => (
      capability === null
        ? null
        : capability.readKaBundleByDigest(fixture.bundle.blobDigest)
    ));
    expect(delivered).toBeNull();
    expect(configuredVerifier).toHaveBeenCalledWith(fixture.successor.head);
    expect(fixture.bundleRead).not.toHaveBeenCalled();
  });

  it('refuses a retained head from an old accepted-policy era', async () => {
    const fixture = await providerFixture(acceptedPrivatePolicy({ era: '1' }));
    await expect(fixture.resolve(fixture.scope)).resolves.toBeNull();
    expect(fixture.bundleRead).not.toHaveBeenCalled();
  });

  it('refuses a head whose author is absent from the current private roster', async () => {
    const fixture = await providerFixture(acceptedPrivatePolicy({ includeAuthor: false }));
    await expect(fixture.resolve(fixture.scope)).resolves.toBeNull();
    expect(fixture.bundleRead).not.toHaveBeenCalled();
  });

  it('constructs and reuses one exact 500-row capability without rebuilding its closure', async () => {
    const onAuthorCatalogBucketProof = vi.fn();
    const fixture = await providerFixture(
      acceptedPrivatePolicy(),
      verifyControlEnvelopeIssuerSignatureV1,
      500,
      undefined,
      onAuthorCatalogBucketProof,
    );
    const capability = await fixture.resolve(fixture.scope);
    expect(capability).not.toBeNull();
    expect(fixture.rows).toHaveLength(500);
    expect(fixture.controlRead).toHaveBeenCalledTimes(4);
    expect(onAuthorCatalogBucketProof).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 500; index += 1) {
      await expect(fixture.resolve(fixture.scope)).resolves.toBe(capability);
    }
    expect(fixture.controlRead).toHaveBeenCalledTimes(4);
    expect(onAuthorCatalogBucketProof).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('coalesces concurrent construction of the same exact scoped capability', async () => {
    const fixture = await providerFixture();
    const releases: Array<() => void> = [];
    const original = fixture.controlRead.getMockImplementation()!;
    fixture.controlRead.mockImplementation(async (input) => {
      if (input.objectDigest === fixture.scope.catalogHeadObjectDigest) {
        await new Promise<void>((resolve) => { releases.push(resolve); });
      }
      return original(input);
    });

    const resolutions = Array.from({ length: 32 }, () => fixture.resolve(fixture.scope));
    while (releases.length === 0) await Promise.resolve();
    expect(releases).toHaveLength(1);
    releases[0]!();
    const capabilities = await Promise.all(resolutions);
    expect(capabilities[0]).not.toBeNull();
    expect(capabilities.every((capability) => capability === capabilities[0])).toBe(true);
    expect(fixture.controlRead).toHaveBeenCalledTimes(4);
  });

  it('denies a cached exact-head capability after private author membership is revoked', async () => {
    let current = acceptedPrivatePolicy();
    const fixture = await providerFixture(
      current,
      verifyControlEnvelopeIssuerSignatureV1,
      1,
      async () => current,
    );
    const capability = await fixture.resolve(fixture.scope);
    expect(capability).not.toBeNull();

    current = acceptedPrivatePolicy({ includeAuthor: false });
    await expect(fixture.resolve(fixture.scope)).resolves.toBeNull();
    await expect(capability?.readKaBundleByDigest(fixture.bundle.blobDigest))
      .rejects.toThrow('requested catalog scope is not accepted-current authority');
    expect(fixture.bundleRead).not.toHaveBeenCalled();

    current = acceptedPrivatePolicy();
    const restored = await fixture.resolve(fixture.scope);
    expect(restored).not.toBeNull();
    expect(restored).not.toBe(capability);
    expect(fixture.controlRead).toHaveBeenCalledTimes(8);
  });
});

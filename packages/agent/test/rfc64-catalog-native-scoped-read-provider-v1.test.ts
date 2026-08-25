import {
  KA_TRANSFER_CHUNK_SIZE_V1,
  KA_TRANSFER_CODEC_V1,
  KA_TRANSFER_PROJECTION_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  assertAuthorCatalogRowV1,
  computeKaChunkTreeRootV1,
  encodeOpaqueKaBundleV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type EvmAddressV1,
  type ContextGraphPolicyV1,
  type MemberRosterV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import {
  produceEmptyAuthorCatalogGenesisV1,
  produceSparseAuthorCatalogSuccessorV1,
} from '../src/rfc64/author-catalog-producer.js';
import { createRfc64CatalogNativeScopedReadProviderV1 } from '../src/rfc64/catalog-native-scoped-read-provider-v1.js';
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

async function providerFixture(accepted = acceptedPrivatePolicy()) {
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
  const row = {
    kaId: ((BigInt(AUTHOR) << 96n) | 1n).toString(),
    assertionCoordinate: 'private-release-1',
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
  const successor = await produceSparseAuthorCatalogSuccessorV1({
    previousHead: genesis.head,
    previousDirectoryPath: genesis.directoryPath,
    previousBucket: null,
    selectedBucketId: '0' as never,
    nextRows: [row],
    issuedAt: '1773900001000' as never,
    signer,
  });
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
  const controlRead = vi.fn(async ({ objectDigest }: { objectDigest: Digest32V1 }) =>
    stored.get(objectDigest) ?? null);
  const bundleRead = vi.fn(async (blobDigest: Digest32V1) =>
    blobDigest === bundle.blobDigest ? bundle.bundleBytes : null);
  const resolve = createRfc64CatalogNativeScopedReadProviderV1({
    controlObjects: { getVerifiedObjectByDigest: controlRead } as never,
    kaBundles: { readKaBundleByDigest: bundleRead },
    resolveAcceptedPolicySnapshot: async () => accepted,
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
    scope,
    stored,
    successor,
  };
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
  ])('refuses a mismatched $label without granting a capability', async ({ mutate }) => {
    const fixture = await providerFixture();
    await expect(fixture.resolve(mutate(fixture.scope))).resolves.toBeNull();
    expect(fixture.bundleRead).not.toHaveBeenCalled();
  });

  it('refuses a closure when its exact direct-author delegation is absent', async () => {
    const fixture = await providerFixture();
    const delegationDigest = fixture.delegation.objectDigest;
    fixture.controlRead.mockImplementation(async ({ objectDigest }) =>
      objectDigest === delegationDigest ? null : fixture.stored.get(objectDigest) ?? null);
    await expect(fixture.resolve(fixture.scope)).resolves.toBeNull();
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
});

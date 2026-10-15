/**
 * GH#3134 — the scoped read provider under a head of more than one bucket: every directory node,
 * bucket and row bundle reachable from the head is served, each bucket proven when first asked for;
 * anything else reads as absent. A catalog of real signed assets is placed in one bucket, then moved
 * to more buckets by the capacity transition producer.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  encodeOpaqueKaBundleV1,
  type AuthorCatalogScopeV1,
  type ContextGraphPolicyV1,
  type CountV1,
  type Digest32V1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import type { AcceptedRfc64CatalogAccessSnapshotV1 } from '../src/rfc64/catalog-access-policy-v1.js';
import { produceAuthorCatalogCapacityTransitionV1 } from '../src/rfc64/author-catalog-capacity-transition-v1.js';
import { createRfc64CatalogNativeScopedReadProviderV1 } from '../src/rfc64/catalog-native-scoped-read-provider-v1.js';
import type { Rfc64PublicCatalogSuccessorAssetInputV1 } from '../src/rfc64/public-catalog-successor-producer-v1.js';
import {
  PRODUCER_DEPLOYMENT,
  producerAssetV1,
  producerGenesisV1,
  producerOverMemoryV1,
  producerSignerV1,
  type ProducerHistoryV1,
} from './support/rfc64-successor-producer-fixture.js';

const POLICY_DIGEST = `0x${'73'.repeat(32)}` as Digest32V1;
const KA_NUMBERS = [1, 2, 3, 4, 5, 6];

describe('serving a head of more than one bucket (GH#3134)', () => {
  it('serves its directory, every bucket and every row bundle, proving each bucket when first asked', async () => {
    const served = await servedCatalog('4');
    const capability = (await served.resolve(served.scope))!;

    expect(await capability.readCatalogObjectByDigest(served.moved.head.objectDigest as Digest32V1))
      .toEqual(served.moved.head);
    expect(await capability.readCatalogObjectByDigest(served.moved.head.payload.catalogIssuerDelegationDigest))
      .toEqual(served.delegation);
    for (const node of served.moved.directoryNodes) {
      expect(await capability.readCatalogObjectByDigest(node.objectDigest as Digest32V1)).toEqual(node);
    }
    for (const bucket of served.moved.buckets) {
      expect(await capability.readCatalogObjectByDigest(bucket.objectDigest as Digest32V1)).toEqual(bucket);
    }
    expect(served.proofs).toHaveBeenCalledTimes(served.moved.buckets.length);
    for (const [blobDigest, bundleBytes] of served.bundles) {
      expect(await capability.readKaBundleByDigest(blobDigest as Digest32V1)).toEqual(bundleBytes);
    }
    // The bundles are placed by their KAs' buckets, which are proven already.
    expect(served.proofs).toHaveBeenCalledTimes(served.moved.buckets.length);
  });

  it('serves a catalog whose directory has two levels', async () => {
    const served = await servedCatalog('512');
    const capability = (await served.resolve(served.scope))!;
    expect(served.moved.head.payload.directoryHeight).toBe('1');

    for (const node of served.moved.directoryNodes) {
      expect(await capability.readCatalogObjectByDigest(node.objectDigest as Digest32V1)).toEqual(node);
    }
    for (const bucket of served.moved.buckets) {
      expect(await capability.readCatalogObjectByDigest(bucket.objectDigest as Digest32V1)).toEqual(bucket);
    }
    for (const [blobDigest, bundleBytes] of served.bundles) {
      expect(await capability.readKaBundleByDigest(blobDigest as Digest32V1)).toEqual(bundleBytes);
    }
  });

  it('reads as absent what the head does not reach', async () => {
    const served = await servedCatalog('4');
    const capability = (await served.resolve(served.scope))!;
    const outside = await producerAssetV1(99);
    const outsideBundle = bundleOf(outside);
    served.bundles.set(outsideBundle.blobDigest, outsideBundle.bundleBytes);

    // The one-bucket catalog's bucket, before the move: another scope's object.
    expect(await capability.readCatalogObjectByDigest(served.oneBucket.objectDigest as Digest32V1)).toBeNull();
    expect(await capability.readKaBundleByDigest(outsideBundle.blobDigest)).toBeNull();
    expect(await capability.readCatalogObjectByDigest(`0x${'ab'.repeat(32)}` as Digest32V1)).toBeNull();
  });
});

async function servedCatalog(bucketCount: string) {
  const { scope, authorization, history: genesis } = await producerGenesisV1();
  const objects = new Map<string, SignedControlEnvelopeV1>();
  const add = (envelopes: readonly SignedControlEnvelopeV1[]) => {
    for (const envelope of envelopes) objects.set(envelope.objectDigest, envelope);
  };
  add([authorization.catalogIssuerDelegation as SignedControlEnvelopeV1, genesis.previousHead, ...genesis.previousDirectoryPath]);
  const bundles = new Map<string, Uint8Array>();
  const producer = producerOverMemoryV1();
  let history: ProducerHistoryV1 = genesis;
  let bucket: SignedAuthorCatalogBucketEnvelopeV1 | null = null;
  for (let count = 1; count <= KA_NUMBERS.length; count += 1) {
    const assets = await Promise.all(KA_NUMBERS.slice(0, count).map((kaNumber) => producerAssetV1(kaNumber)));
    const produced = await producer.produceAndStageExactSet({
      ...history,
      assets,
      deployment: PRODUCER_DEPLOYMENT,
      issuedAt: String(1773900001000 + count) as never,
      catalogSigner: producerSignerV1(),
      catalogIssuerAuthorization: authorization,
    });
    add(produced.publication.stagedObjects);
    for (const asset of assets) {
      const encoded = bundleOf(asset);
      bundles.set(encoded.blobDigest, encoded.bundleBytes);
    }
    bucket = produced.publication.bucket;
    history = { previousHead: produced.publication.head, previousDirectoryPath: produced.publication.directoryPath, previousBucket: bucket };
  }
  const moved = await produceAuthorCatalogCapacityTransitionV1({
    previousHead: history.previousHead,
    bucketCount: bucketCount as CountV1,
    rows: bucket!.payload.rows,
    issuedAt: '1773900009000' as never,
    signer: producerSignerV1(),
  });
  add(moved.stagedObjects);
  const proofs = vi.fn();
  const accepted = acceptedPublicPolicy(scope);
  const resolve = createRfc64CatalogNativeScopedReadProviderV1({
    controlObjects: {
      getVerifiedObjectByDigest: async ({ objectDigest, verifyIssuerSignature }) => {
        const envelope = objects.get(objectDigest);
        return envelope === undefined ? null : { envelope, issuerSignature: await verifyIssuerSignature(envelope) };
      },
    } as never,
    kaBundles: { readKaBundleByDigest: async (blobDigest) => bundles.get(blobDigest) ?? null },
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    resolveAcceptedPolicySnapshot: async () => accepted,
    onAuthorCatalogBucketProof: proofs,
  });
  const head = moved.head.payload;
  return {
    resolve,
    proofs,
    moved,
    bundles,
    oneBucket: bucket!,
    delegation: authorization.catalogIssuerDelegation,
    scope: Object.freeze({
      networkId: head.networkId,
      contextGraphId: head.contextGraphId,
      subGraphName: head.subGraphName,
      authorAddress: head.authorAddress,
      catalogEra: head.era,
      catalogVersion: head.version,
      policyDigest: POLICY_DIGEST,
      catalogHeadObjectDigest: moved.head.objectDigest as Digest32V1,
    }),
  };
}

function bundleOf(asset: Rfc64PublicCatalogSuccessorAssetInputV1) {
  return encodeOpaqueKaBundleV1(asset.projectionBytes, canonicalizeCanonicalGraphScopedAuthorSealBytesV1(asset.seal));
}

function acceptedPublicPolicy(scope: AuthorCatalogScopeV1): AcceptedRfc64CatalogAccessSnapshotV1 {
  const policy = {
    networkId: scope.networkId,
    contextGraphId: scope.contextGraphId,
    governanceChainId: scope.governanceChainId,
    governanceContractAddress: scope.governanceContractAddress,
    ownershipTransitionDigest: scope.ownershipTransitionDigest,
    era: scope.era,
    version: '0',
    previousPolicyDigest: null,
    accessPolicy: 0,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: { kind: 'owner-signed-unregistered', ownerAddress: scope.authorAddress, ownerAuthorityEra: scope.era },
    effectiveAt: '0',
    issuedAt: '0',
  } as unknown as ContextGraphPolicyV1;
  return Object.freeze({ policy, policyDigest: POLICY_DIGEST, roster: null });
}

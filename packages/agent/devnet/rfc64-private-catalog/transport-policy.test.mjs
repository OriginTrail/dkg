// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1 } from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { produceEmptyAuthorCatalogGenesisV1 } from '../../src/rfc64/author-catalog-producer.ts';
import { mintRfc64CatalogNativeScopedReadCapabilityV1 } from
  '../../src/rfc64/catalog-native-scoped-read-capability-v1-internal.ts';
import {
  RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
  Rfc64PublicCatalogNativeTransportV1,
} from '../../src/rfc64/public-catalog-native-transport-v1.ts';
import { Rfc64CatalogAccessPolicyRegistryV1 } from
  '../../src/rfc64/catalog-access-policy-v1.ts';
import {
  CONTEXT_GRAPH_ID,
  NETWORK_ID,
  createPrivatePolicyAndRoster,
  createReceiverRevokedPolicyAndRoster,
  ownerWallet,
  roleAgentAddress,
} from './fixture.mjs';
import { hasExactMemoryContents } from './run.mjs';
import {
  readExpectedPrivateMemoryV1,
  seedExpectedPrivateMemoryV1,
} from './fixtures/private-memory-fixture.mjs';
import { createMemoryProtocolRouterPairV1 } from
  './fixtures/in-memory-transport-fixture.mjs';

test('native transport enforces an authoritative roster rotation before object reads', async () => {
  const configured = createPrivatePolicyAndRoster();
  const wallet = ownerWallet();
  const produced = await produceEmptyAuthorCatalogGenesisV1({
    scope: {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: 'private-release-gate',
      authorAddress: wallet.address.toLowerCase(),
      era: '0',
      bucketCount: '1',
    },
    catalogIssuerDelegationDigest: `0x${'74'.repeat(32)}`,
    issuedAt: '1773900000000',
    signer: {
      issuer: wallet.address.toLowerCase(),
      signDigest: async (digest) => wallet.signMessage(digest),
    },
  });
  const catalogObjects = new Map(
    produced.stagedObjects.map((envelope) => [envelope.objectDigest, envelope]),
  );
  const scope = Object.freeze({
    networkId: produced.head.payload.networkId,
    contextGraphId: produced.head.payload.contextGraphId,
    subGraphName: produced.head.payload.subGraphName,
    authorAddress: produced.head.payload.authorAddress,
    catalogEra: produced.head.payload.era,
    catalogVersion: produced.head.payload.version,
    policyDigest: configured.policyDigest,
    catalogHeadObjectDigest: produced.head.objectDigest,
  });
  const providerRegistry = new Rfc64CatalogAccessPolicyRegistryV1({
    localAgentAddress: roleAgentAddress('provider2'),
    resolveRemoteAgentAddress: async () => roleAgentAddress('receiver'),
  });
  const receiverRegistry = new Rfc64CatalogAccessPolicyRegistryV1({
    localAgentAddress: roleAgentAddress('receiver'),
    resolveRemoteAgentAddress: async () => roleAgentAddress('provider2'),
  });
  for (const registry of [providerRegistry, receiverRegistry]) {
    registry.acceptCurrent({
      policy: configured.policy,
      policyDigest: configured.policyDigest,
      roster: configured.roster,
    });
  }

  const [providerRouter, receiverRouter] = createMemoryProtocolRouterPairV1();
  let catalogReads = 0;
  const provider = new Rfc64PublicCatalogNativeTransportV1(providerRouter, {
    resolveScopedReadCapability: async (requestedScope) => (
      mintRfc64CatalogNativeScopedReadCapabilityV1({
        scope: requestedScope,
        readCatalogObjectByDigest: async (digest) => {
          catalogReads += 1;
          return catalogObjects.get(digest) ?? null;
        },
        readKaBundleByDigest: async () => null,
      })
    ),
    authorizeCatalogOperation: providerRegistry.authorize,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
  });
  const receiver = new Rfc64PublicCatalogNativeTransportV1(receiverRouter, {
    readCatalogObjectByDigest: async () => null,
    readKaBundleByDigest: async () => null,
    authorizeCatalogOperation: receiverRegistry.authorize,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
  });
  const store = new OxigraphStore();
  provider.start();
  receiver.start();
  try {
    await seedExpectedPrivateMemoryV1(store);
    const memoryBeforeRevocation = await readExpectedPrivateMemoryV1(store);
    const root = produced.directoryPath[0];
    const request = {
      ...scope,
      kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
      targetObjectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
      targetObjectDigest: root.objectDigest,
    };
    const fetched = await receiver.fetchCatalogObject(providerRouter.peerId, request);
    assert.equal(fetched.envelope.objectDigest, root.objectDigest);
    assert.equal(catalogReads, 1);

    const revoked = createReceiverRevokedPolicyAndRoster();
    providerRegistry.acceptAuthoritativeCurrent({
      policy: revoked.policy,
      policyDigest: revoked.policyDigest,
      roster: revoked.roster,
    });
    await assert.rejects(
      receiver.fetchCatalogObject(providerRouter.peerId, request),
      (error) => error?.code === 'catalog-native-policy-denied',
    );
    assert.equal(catalogReads, 1);
    const memoryAfterRevocation = await readExpectedPrivateMemoryV1(store);
    assert.deepEqual(memoryAfterRevocation, memoryBeforeRevocation);
    assert.equal(hasExactMemoryContents({ graphCounts: memoryAfterRevocation }), true);
  } finally {
    receiver.stop();
    provider.stop();
    await store.close();
  }
});

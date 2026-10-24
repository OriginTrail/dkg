import {
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  ProtocolRouter,
  encodeOpaqueKaBundleV1,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { produceEmptyAuthorCatalogGenesisV1 } from '../src/rfc64/author-catalog-producer.js';
import {
  RFC64_CATALOG_BUNDLE_FETCH_PROTOCOL_V2,
  RFC64_CATALOG_OBJECT_FETCH_PROTOCOL_V2,
  RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
  RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
  RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
  Rfc64PublicCatalogNativeTransportV1,
  encodeRfc64PublicCatalogObjectFetchRequestV1,
  type Rfc64CatalogNativeScopedReadCapabilityV1,
  type Rfc64PublicCatalogNativeFetchScopeV1,
} from '../src/rfc64/public-catalog-native-transport-v1.js';
import { mintRfc64CatalogNativeScopedReadCapabilityV1 } from '../src/rfc64/catalog-native-scoped-read-capability-v1-internal.js';
import { createRfc64CatalogAccessPolicyRegistryFixture } from './support/rfc64-catalog-access-policy-fixture.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'65'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const LOCAL_MEMBER = '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const REMOTE_MEMBER = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const CURATOR = '0x5555555555555555555555555555555555555555' as EvmAddressV1;
const POLICY_DIGEST = `0x${'73'.repeat(32)}` as Digest32V1;
const DELEGATION_DIGEST = `0x${'74'.repeat(32)}` as Digest32V1;
const UTF8 = new TextEncoder();

type NativeHandler = (data: Uint8Array, peerId: { toString(): string }) => Promise<Uint8Array>;

class MemoryProtocolRouter {
  readonly handlers = new Map<string, NativeHandler>();
  readonly sentProtocols: string[] = [];
  remote: MemoryProtocolRouter | null = null;

  constructor(readonly peerId: string) {}

  register(protocol: string, handler: NativeHandler): void {
    this.handlers.set(protocol, handler);
  }

  unregister(protocol: string): void {
    this.handlers.delete(protocol);
  }

  async send(
    _remotePeerId: string,
    protocol: string,
    data: Uint8Array,
  ): Promise<Uint8Array> {
    this.sentProtocols.push(protocol);
    const handler = this.remote?.handlers.get(protocol);
    if (handler === undefined) throw new Error(`missing in-memory handler for ${protocol}`);
    return handler(data, { toString: () => this.peerId });
  }
}

function routerPair(): readonly [MemoryProtocolRouter, MemoryProtocolRouter] {
  const provider = new MemoryProtocolRouter('provider-peer');
  const receiver = new MemoryProtocolRouter('receiver-peer');
  provider.remote = receiver;
  receiver.remote = provider;
  return [provider, receiver];
}

async function contentFixture() {
  const produced = await produceEmptyAuthorCatalogGenesisV1({
    scope: {
      networkId: 'otp:20430',
      contextGraphId: '0x1111111111111111111111111111111111111111/private-scoped',
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: 'member-subgraph',
      authorAddress: AUTHOR,
      era: '0',
      bucketCount: '1',
    } as AuthorCatalogScopeV1,
    catalogIssuerDelegationDigest: DELEGATION_DIGEST,
    issuedAt: '1773900000000',
    signer: {
      issuer: AUTHOR,
      signDigest: async (digest) => AUTHOR_WALLET.signMessage(digest),
    },
  });
  const catalogObjects = new Map<string, SignedControlEnvelopeV1>(
    produced.stagedObjects.map((envelope) => [envelope.objectDigest, envelope]),
  );
  const bundle = encodeOpaqueKaBundleV1(UTF8.encode('private payload'), new Uint8Array());
  const scope = Object.freeze({
    networkId: produced.head.payload.networkId,
    contextGraphId: produced.head.payload.contextGraphId,
    subGraphName: produced.head.payload.subGraphName,
    authorAddress: produced.head.payload.authorAddress,
    catalogEra: produced.head.payload.era,
    catalogVersion: produced.head.payload.version,
    policyDigest: POLICY_DIGEST,
    catalogHeadObjectDigest: produced.head.objectDigest,
  }) satisfies Rfc64PublicCatalogNativeFetchScopeV1;
  return { produced, catalogObjects, bundle, scope };
}

function privateRegistry(
  localAgentAddress: EvmAddressV1,
  remoteAgentAddress: EvmAddressV1,
  contextGraphId: ContextGraphIdV1,
) {
  return createRfc64CatalogAccessPolicyRegistryFixture({
    localAgentAddress,
    remoteAgentAddress,
    contextGraphId,
    accessPolicy: 1,
    publishPolicy: 0,
    policyDigest: POLICY_DIGEST,
    ownerAddress: AUTHOR,
    curatorAddress: CURATOR,
  });
}

function capability(
  scope: Rfc64PublicCatalogNativeFetchScopeV1,
  readCatalogObjectByDigest: Rfc64CatalogNativeScopedReadCapabilityV1['readCatalogObjectByDigest'],
  readKaBundleByDigest: Rfc64CatalogNativeScopedReadCapabilityV1['readKaBundleByDigest'],
): Rfc64CatalogNativeScopedReadCapabilityV1 {
  return mintRfc64CatalogNativeScopedReadCapabilityV1({
    scope,
    readCatalogObjectByDigest,
    readKaBundleByDigest,
  });
}

function requestCatalogObject(
  scope: Rfc64PublicCatalogNativeFetchScopeV1,
  objectDigest: Digest32V1,
) {
  return {
    ...scope,
    kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
    targetObjectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
    targetObjectDigest: objectDigest,
  } as const;
}

describe('RFC-64 private exact-scope native transport', () => {
  it('serves catalog objects and bundles between current provider members', async () => {
    const fixture = await contentFixture();
    const [providerRouter, receiverRouter] = routerPair();
    const readObject = vi.fn(async (digest: Digest32V1) => fixture.catalogObjects.get(digest) ?? null);
    const readBundle = vi.fn(async (digest: Digest32V1) =>
      digest === fixture.bundle.blobDigest ? fixture.bundle.bundleBytes : null);
    const resolveCapability = vi.fn(async (scope: Rfc64PublicCatalogNativeFetchScopeV1) =>
      capability(scope, readObject, readBundle));
    const providerPolicy = privateRegistry(
      LOCAL_MEMBER,
      REMOTE_MEMBER,
      fixture.scope.contextGraphId,
    );
    const receiverPolicy = privateRegistry(
      REMOTE_MEMBER,
      LOCAL_MEMBER,
      fixture.scope.contextGraphId,
    );
    const provider = new Rfc64PublicCatalogNativeTransportV1(
      providerRouter as unknown as ProtocolRouter,
      {
        resolveScopedReadCapability: resolveCapability,
        authorizeCatalogOperation: providerPolicy.authorize,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    const receiver = new Rfc64PublicCatalogNativeTransportV1(
      receiverRouter as unknown as ProtocolRouter,
      {
        readCatalogObjectByDigest: async () => null,
        readKaBundleByDigest: async () => null,
        authorizeCatalogOperation: receiverPolicy.authorize,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    provider.start();
    receiver.start();

    expect(provider.privateScopeBoundReadsConfigured).toBe(true);
    const root = fixture.produced.directoryPath[0]!;
    await expect(receiver.fetchCatalogObject(
      providerRouter.peerId,
      requestCatalogObject(fixture.scope, root.objectDigest as Digest32V1),
    )).resolves.toMatchObject({ envelope: root });
    await expect(receiver.fetchKaBundle(providerRouter.peerId, {
      ...fixture.scope,
      kind: RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
      blobDigest: fixture.bundle.blobDigest,
      byteLength: fixture.bundle.bundleBytes.byteLength.toString() as never,
    })).resolves.toEqual(fixture.bundle.bundleBytes);
    expect(resolveCapability).toHaveBeenCalledTimes(2);
    expect(readObject).toHaveBeenCalledWith(root.objectDigest);
    expect(readBundle).toHaveBeenCalledWith(fixture.bundle.blobDigest);
    expect(receiverRouter.sentProtocols).toEqual([
      RFC64_CATALOG_OBJECT_FETCH_PROTOCOL_V2,
      RFC64_CATALOG_BUNDLE_FETCH_PROTOCOL_V2,
    ]);

    const v1Response = await receiverRouter.send(
      providerRouter.peerId,
      RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
      encodeRfc64PublicCatalogObjectFetchRequestV1(
        requestCatalogObject(fixture.scope, root.objectDigest as Digest32V1),
      ),
    );
    expect(v1Response).toEqual(Uint8Array.of(2));
    expect(resolveCapability).toHaveBeenCalledTimes(2);

    receiver.stop();
    provider.stop();
  });

  it.each([
    { label: 'outsider', providerAuthorization: async () => null },
    {
      label: 'cross-CG member',
      providerAuthorization: undefined,
    },
  ])('denies $label before scoped capability resolution or digest lookup', async ({ label, providerAuthorization }) => {
    const fixture = await contentFixture();
    const [providerRouter, receiverRouter] = routerPair();
    const readObject = vi.fn(async () => null);
    const resolveCapability = vi.fn(async (scope: Rfc64PublicCatalogNativeFetchScopeV1) =>
      capability(scope, readObject, async () => null));
    const providerPolicy = privateRegistry(
      LOCAL_MEMBER,
      REMOTE_MEMBER,
      fixture.scope.contextGraphId,
    );
    const provider = new Rfc64PublicCatalogNativeTransportV1(
      providerRouter as unknown as ProtocolRouter,
      {
        resolveScopedReadCapability: resolveCapability,
        authorizeCatalogOperation: providerAuthorization ?? providerPolicy.authorize,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    const receiver = new Rfc64PublicCatalogNativeTransportV1(
      receiverRouter as unknown as ProtocolRouter,
      {
        readCatalogObjectByDigest: async () => null,
        readKaBundleByDigest: async () => null,
        authorizeCatalogOperation: async () => ({ accessPolicy: 1, policyDigest: POLICY_DIGEST }),
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    provider.start();
    receiver.start();
    const requestScope = label === 'cross-CG member'
      ? {
          ...fixture.scope,
          contextGraphId:
            '0x1111111111111111111111111111111111111111/another-private-cg' as ContextGraphIdV1,
        }
      : fixture.scope;

    await expect(receiver.fetchCatalogObject(
      providerRouter.peerId,
      requestCatalogObject(
        requestScope,
        fixture.produced.directoryPath[0]!.objectDigest as Digest32V1,
      ),
    )).rejects.toThrow(/policy/u);
    expect(resolveCapability).not.toHaveBeenCalled();
    expect(readObject).not.toHaveBeenCalled();

    receiver.stop();
    provider.stop();
  });

  it('rechecks current private membership after capability resolution and before digest lookup', async () => {
    const fixture = await contentFixture();
    const [providerRouter, receiverRouter] = routerPair();
    const readObject = vi.fn(async () => fixture.produced.directoryPath[0]!);
    let current = true;
    const provider = new Rfc64PublicCatalogNativeTransportV1(
      providerRouter as unknown as ProtocolRouter,
      {
        resolveScopedReadCapability: async (scope) => {
          current = false;
          return capability(scope, readObject, async () => null);
        },
        authorizeCatalogOperation: async () => current
          ? { accessPolicy: 1, policyDigest: POLICY_DIGEST }
          : null,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    const receiver = new Rfc64PublicCatalogNativeTransportV1(
      receiverRouter as unknown as ProtocolRouter,
      {
        readCatalogObjectByDigest: async () => null,
        readKaBundleByDigest: async () => null,
        authorizeCatalogOperation: async () => ({ accessPolicy: 1, policyDigest: POLICY_DIGEST }),
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    provider.start();
    receiver.start();

    await expect(receiver.fetchCatalogObject(
      providerRouter.peerId,
      requestCatalogObject(
        fixture.scope,
        fixture.produced.directoryPath[0]!.objectDigest as Digest32V1,
      ),
    )).rejects.toThrow(/policy/u);
    expect(readObject).not.toHaveBeenCalled();

    receiver.stop();
    provider.stop();
  });

  it.each([
    {
      label: 'catalog head',
      mutate: (scope: Rfc64PublicCatalogNativeFetchScopeV1) => ({
        ...scope,
        catalogHeadObjectDigest: `0x${'99'.repeat(32)}` as Digest32V1,
      }),
    },
    {
      label: 'subgraph scope',
      mutate: (scope: Rfc64PublicCatalogNativeFetchScopeV1) => ({
        ...scope,
        subGraphName: 'another-subgraph' as never,
      }),
    },
  ])('rejects a capability for the wrong $label before digest lookup', async ({ mutate }) => {
    const fixture = await contentFixture();
    const [providerRouter, receiverRouter] = routerPair();
    const readObject = vi.fn(async () => fixture.produced.directoryPath[0]!);
    const provider = new Rfc64PublicCatalogNativeTransportV1(
      providerRouter as unknown as ProtocolRouter,
      {
        resolveScopedReadCapability: async () =>
          capability(fixture.scope, readObject, async () => null),
        authorizeCatalogOperation: async () => ({ accessPolicy: 1, policyDigest: POLICY_DIGEST }),
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    const receiver = new Rfc64PublicCatalogNativeTransportV1(
      receiverRouter as unknown as ProtocolRouter,
      {
        readCatalogObjectByDigest: async () => null,
        readKaBundleByDigest: async () => null,
        authorizeCatalogOperation: async () => ({ accessPolicy: 1, policyDigest: POLICY_DIGEST }),
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    provider.start();
    receiver.start();

    await expect(receiver.fetchCatalogObject(
      providerRouter.peerId,
      requestCatalogObject(
        mutate(fixture.scope),
        fixture.produced.directoryPath[0]!.objectDigest as Digest32V1,
      ),
    )).rejects.toThrow(/exact requested catalog head scope/u);
    expect(readObject).not.toHaveBeenCalled();

    receiver.stop();
    provider.stop();
  });

  it('denies public V1 inbound reads when only a global digest reader is configured', async () => {
    const fixture = await contentFixture();
    const [providerRouter, receiverRouter] = routerPair();
    const readObject = vi.fn(async (digest: Digest32V1) => fixture.catalogObjects.get(digest) ?? null);
    const publicAuthorization = async () => ({ accessPolicy: 0 as const, policyDigest: POLICY_DIGEST });
    const provider = new Rfc64PublicCatalogNativeTransportV1(
      providerRouter as unknown as ProtocolRouter,
      {
        readCatalogObjectByDigest: readObject,
        readKaBundleByDigest: async () => null,
        authorizeCatalogOperation: publicAuthorization,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    const receiver = new Rfc64PublicCatalogNativeTransportV1(
      receiverRouter as unknown as ProtocolRouter,
      {
        readCatalogObjectByDigest: async () => null,
        readKaBundleByDigest: async () => null,
        authorizeCatalogOperation: publicAuthorization,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    provider.start();
    receiver.start();

    const root = fixture.produced.directoryPath[0]!;
    await expect(receiver.fetchCatalogObject(
      providerRouter.peerId,
      requestCatalogObject(fixture.scope, root.objectDigest as Digest32V1),
    )).rejects.toMatchObject({
      code: 'catalog-native-policy-denied',
      message: expect.stringContaining('exact-scope read capability is not configured'),
    });
    expect(provider.privateScopeBoundReadsConfigured).toBe(false);
    expect(readObject).not.toHaveBeenCalled();
    expect(receiverRouter.sentProtocols).toEqual([
      RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
    ]);

    receiver.stop();
    provider.stop();
  });
});

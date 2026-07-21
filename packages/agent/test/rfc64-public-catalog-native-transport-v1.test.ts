import { multiaddr } from '@multiformats/multiaddr';
import {
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  DKGNode,
  ProtocolRouter,
  canonicalizeSignedControlEnvelopeBytes,
  computeControlSignatureVariantDigestHex,
  encodeOpaqueKaBundleV1,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
  type EvmAddressV1,
  type MemberRosterV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { produceEmptyAuthorCatalogGenesisV1 } from '../src/rfc64/author-catalog-producer.js';
import { Rfc64CatalogAccessPolicyRegistryV1 } from '../src/rfc64/catalog-access-policy-v1.js';
import {
  RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
  RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1,
  RFC64_PUBLIC_CATALOG_EXACT_SET_BUNDLE_BYTES_MAX_V1,
  RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
  RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
  Rfc64PublicCatalogNativeTransportV1,
  assertRfc64PublicCatalogExactSetBundleBytesV1,
  type Rfc64PublicCatalogNativeFetchScopeV1,
  Rfc64PublicCatalogNativeTransportErrorV1,
} from '../src/rfc64/public-catalog-native-transport-v1.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'65'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const POLICY_DIGEST = `0x${'73'.repeat(32)}` as Digest32V1;
const DELEGATION_DIGEST = `0x${'74'.repeat(32)}` as Digest32V1;
const LOCAL_MEMBER = '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const REMOTE_MEMBER = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const CURATOR = '0x5555555555555555555555555555555555555555' as EvmAddressV1;
const UTF8 = new TextEncoder();

const nodes: DKGNode[] = [];
const transports: Rfc64PublicCatalogNativeTransportV1[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) transport.stop();
  for (const node of nodes.splice(0)) {
    try { await node.stop(); } catch {}
  }
});

async function startNode(): Promise<DKGNode> {
  const node = new DKGNode({
    listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
    enableMdns: false,
  });
  nodes.push(node);
  await node.start();
  return node;
}

async function connect(from: DKGNode, to: DKGNode): Promise<void> {
  const address = to.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
  if (address === undefined) throw new Error('test node has no TCP multiaddr');
  await from.libp2p.dial(multiaddr(address));
}

function policyRegistry(
  localAgentAddress: EvmAddressV1,
  remoteAgentAddress: EvmAddressV1,
  contextGraphId: ContextGraphIdV1,
  accessPolicy: 0 | 1,
  publishPolicy: 0 | 1,
): Rfc64CatalogAccessPolicyRegistryV1 {
  const registry = new Rfc64CatalogAccessPolicyRegistryV1({
    localAgentAddress,
    resolveRemoteAgentAddress: async () => remoteAgentAddress,
  });
  const policy = {
    networkId: 'otp:20430',
    contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy,
    publishPolicy,
    publishAuthority: publishPolicy === 0 ? CURATOR : null,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'owner-signed-unregistered',
      ownerAddress: AUTHOR,
      ownerAuthorityEra: '0',
    },
    effectiveAt: '0',
    issuedAt: '0',
  } satisfies ContextGraphPolicyV1;
  const roster = accessPolicy === 0 ? null : {
    networkId: policy.networkId,
    contextGraphId: policy.contextGraphId,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousRosterDigest: null,
    policyDigest: POLICY_DIGEST,
    administrativeDelegationDigest: null,
    members: [
      { agentAddress: LOCAL_MEMBER, roles: ['holder', 'provider'] },
      { agentAddress: REMOTE_MEMBER, roles: ['holder', 'provider'] },
    ],
    issuedAt: '0',
  } satisfies MemberRosterV1;
  registry.accept({ policy, policyDigest: POLICY_DIGEST, roster });
  return registry;
}

describe('RFC-64 public catalog native content transport v1', () => {
  it('accepts the exact-set bundle-byte ceiling and rejects one byte over it', () => {
    const ceiling = BigInt(RFC64_PUBLIC_CATALOG_EXACT_SET_BUNDLE_BYTES_MAX_V1);
    expect(assertRfc64PublicCatalogExactSetBundleBytesV1([
      (ceiling - 1n).toString() as never,
      '1' as never,
    ])).toBe(ceiling);
    expect(() => assertRfc64PublicCatalogExactSetBundleBytesV1([
      ceiling.toString() as never,
      '1' as never,
    ])).toThrow(/exceed.*ceiling/);
  });

  // Only the publicly-readable cells are servable over the native content protocols: the serve path
  // resolves by digest out of an agent-wide store and is not bound back to the authorizing graph, so
  // private content stays denied (see requireCatalogPolicy). publishPolicy must not affect this —
  // it governs finalized-VM admission only, never read/SWM authorization.
  it.each([
    { accessPolicy: 0 as const, publishPolicy: 0 as const },
    { accessPolicy: 0 as const, publishPolicy: 1 as const },
  ])(
    'fetches exact directory and bundle digests for accessPolicy=$accessPolicy publishPolicy=$publishPolicy',
    async ({ accessPolicy, publishPolicy }) => {
    const [authorNode, receiverNode] = await Promise.all([startNode(), startNode()]);
    await connect(receiverNode, authorNode);

    const produced = await produceEmptyAuthorCatalogGenesisV1({
      scope: {
        networkId: 'otp:20430',
        contextGraphId: '0x1111111111111111111111111111111111111111/native-transport',
        governanceChainId: '20430',
        governanceContractAddress: '0x2222222222222222222222222222222222222222',
        ownershipTransitionDigest: null,
        subGraphName: null,
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
    const bundle = encodeOpaqueKaBundleV1(
      UTF8.encode('<https://example.org/a> <https://schema.org/name> "A" .\n'),
      new Uint8Array(),
    );
    const bundles = new Map<string, Uint8Array>([[bundle.blobDigest, bundle.bundleBytes]]);
    const authorCatalogReads = vi.fn(async (digest: Digest32V1) => catalogObjects.get(digest) ?? null);
    const authorBundleReads = vi.fn(async (digest: Digest32V1) => bundles.get(digest) ?? null);
    const authorAuthorizations: string[] = [];
    const receiverAuthorizations: string[] = [];
    const authorPolicy = policyRegistry(
      LOCAL_MEMBER,
      REMOTE_MEMBER,
      produced.head.payload.contextGraphId,
      accessPolicy,
      publishPolicy,
    );
    const receiverPolicy = policyRegistry(
      REMOTE_MEMBER,
      LOCAL_MEMBER,
      produced.head.payload.contextGraphId,
      accessPolicy,
      publishPolicy,
    );

    const authorTransport = new Rfc64PublicCatalogNativeTransportV1(
      new ProtocolRouter(authorNode),
      {
        readCatalogObjectByDigest: authorCatalogReads,
        readKaBundleByDigest: authorBundleReads,
        authorizeCatalogOperation: async (input) => {
          authorAuthorizations.push(input.operation);
          return authorPolicy.authorize(input);
        },
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    const receiverTransport = new Rfc64PublicCatalogNativeTransportV1(
      new ProtocolRouter(receiverNode),
      {
        readCatalogObjectByDigest: async () => null,
        readKaBundleByDigest: async () => null,
        authorizeCatalogOperation: async (input) => {
          receiverAuthorizations.push(input.operation);
          return receiverPolicy.authorize(input);
        },
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    transports.push(authorTransport, receiverTransport);
    authorTransport.start();
    receiverTransport.start();

    expect(RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1)
      .toBe('/dkg/catalog/1/control-object/by-digest');
    expect(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1)
      .toBe('/dkg/catalog/1/ka-bundle/by-digest');

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
    const fetchedRoot = await receiverTransport.fetchCatalogObject(authorNode.peerId, {
      ...scope,
      kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
      targetObjectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
      targetObjectDigest: produced.head.payload.directoryRootDigest,
    });
    expect(fetchedRoot?.envelope).toEqual(produced.directoryPath[0]);

    const fetchedBundle = await receiverTransport.fetchKaBundle(authorNode.peerId, {
      ...scope,
      kind: RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
      blobDigest: bundle.blobDigest,
      byteLength: bundle.bundleBytes.byteLength.toString() as never,
    });
    expect(fetchedBundle).toEqual(bundle.bundleBytes);
    expect(fetchedBundle).not.toBe(bundle.bundleBytes);

    expect(authorCatalogReads).toHaveBeenCalledWith(produced.head.payload.directoryRootDigest);
    expect(authorBundleReads).toHaveBeenCalledWith(bundle.blobDigest);
    expect(authorAuthorizations).toEqual([
      'catalog-object-fetch-inbound',
      'catalog-object-fetch-inbound',
      'ka-bundle-fetch-inbound',
      'ka-bundle-fetch-inbound',
    ]);
    expect(receiverAuthorizations).toEqual([
      'catalog-object-fetch-outbound',
      'catalog-object-fetch-outbound',
      'catalog-object-fetch-outbound',
      'ka-bundle-fetch-outbound',
      'ka-bundle-fetch-outbound',
    ]);
    },
    30_000,
  );

  it('denies an unauthorized request before provider lookup', async () => {
    const [authorNode, receiverNode] = await Promise.all([startNode(), startNode()]);
    await connect(receiverNode, authorNode);
    const providerRead = vi.fn(async () => null);
    const authorTransport = new Rfc64PublicCatalogNativeTransportV1(
      new ProtocolRouter(authorNode),
      {
        readCatalogObjectByDigest: providerRead,
        readKaBundleByDigest: async () => null,
        authorizeCatalogOperation: async () => null,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    const receiverTransport = new Rfc64PublicCatalogNativeTransportV1(
      new ProtocolRouter(receiverNode),
      {
        readCatalogObjectByDigest: async () => null,
        readKaBundleByDigest: async () => null,
        authorizeCatalogOperation: async () => ({
          accessPolicy: 0,
          policyDigest: POLICY_DIGEST,
        }),
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    transports.push(authorTransport, receiverTransport);
    authorTransport.start();
    receiverTransport.start();

    await expect(receiverTransport.fetchCatalogObject(authorNode.peerId, {
      kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
      networkId: 'otp:20430' as never,
      contextGraphId: '0x1111111111111111111111111111111111111111/denied' as never,
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0' as never,
      catalogVersion: '1' as never,
      policyDigest: POLICY_DIGEST,
      catalogHeadObjectDigest: `0x${'81'.repeat(32)}` as Digest32V1,
      targetObjectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
      targetObjectDigest: `0x${'82'.repeat(32)}` as Digest32V1,
    }, { timeoutMs: 4_000 })).rejects.toThrow(/policy/);
    expect(providerRead).not.toHaveBeenCalled();
  }, 15_000);

  it('denies a private-policy request before provider lookup on both content protocols', async () => {
    const [authorNode, receiverNode] = await Promise.all([startNode(), startNode()]);
    await connect(receiverNode, authorNode);
    const providerObjectRead = vi.fn(async () => null);
    const providerBundleRead = vi.fn(async () => null);
    const authorTransport = new Rfc64PublicCatalogNativeTransportV1(
      new ProtocolRouter(authorNode),
      {
        readCatalogObjectByDigest: providerObjectRead,
        readKaBundleByDigest: providerBundleRead,
        // A provider that has itself accepted a private cell must STILL refuse to serve that cell's
        // content over the native protocols. The serve path resolves purely by the digest in the
        // request, out of a store shared by every graph on the node, so serving private content here
        // would hand it to anyone authorized under any public cell the node happens to hold.
        authorizeCatalogOperation: async () => ({
          accessPolicy: 1,
          policyDigest: POLICY_DIGEST,
        }),
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    const receiverTransport = new Rfc64PublicCatalogNativeTransportV1(
      new ProtocolRouter(receiverNode),
      {
        readCatalogObjectByDigest: async () => null,
        readKaBundleByDigest: async () => null,
        authorizeCatalogOperation: async () => ({
          accessPolicy: 0,
          policyDigest: POLICY_DIGEST,
        }),
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    transports.push(authorTransport, receiverTransport);
    authorTransport.start();
    receiverTransport.start();

    const scope = {
      networkId: 'otp:20430' as never,
      contextGraphId: '0x1111111111111111111111111111111111111111/private-denied' as never,
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0' as never,
      catalogVersion: '1' as never,
      policyDigest: POLICY_DIGEST,
      catalogHeadObjectDigest: `0x${'81'.repeat(32)}` as Digest32V1,
    };

    await expect(receiverTransport.fetchCatalogObject(authorNode.peerId, {
      kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
      ...scope,
      targetObjectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
      targetObjectDigest: `0x${'82'.repeat(32)}` as Digest32V1,
    }, { timeoutMs: 4_000 })).rejects.toThrow(/policy/);
    expect(providerObjectRead).not.toHaveBeenCalled();

    const encoded = encodeOpaqueKaBundleV1(UTF8.encode('private'), new Uint8Array());
    await expect(receiverTransport.fetchKaBundle(authorNode.peerId, {
      kind: RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
      ...scope,
      blobDigest: encoded.blobDigest,
      byteLength: encoded.bundleBytes.byteLength.toString() as never,
    }, { timeoutMs: 4_000 })).rejects.toThrow(/policy/);
    expect(providerBundleRead).not.toHaveBeenCalled();
  }, 20_000);

  it('rechecks provider authorization after an awaited catalog-object miss', async () => {
    const [authorNode, receiverNode] = await Promise.all([startNode(), startNode()]);
    await connect(receiverNode, authorNode);
    const providerRead = vi.fn(async () => null);
    let providerAuthorizationChecks = 0;
    const authorTransport = new Rfc64PublicCatalogNativeTransportV1(
      new ProtocolRouter(authorNode),
      {
        readCatalogObjectByDigest: providerRead,
        readKaBundleByDigest: async () => null,
        authorizeCatalogOperation: async () => {
          providerAuthorizationChecks += 1;
          return providerAuthorizationChecks === 1 ? {
            accessPolicy: 0,
            policyDigest: POLICY_DIGEST,
          } : null;
        },
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    const receiverTransport = new Rfc64PublicCatalogNativeTransportV1(
      new ProtocolRouter(receiverNode),
      {
        readCatalogObjectByDigest: async () => null,
        readKaBundleByDigest: async () => null,
        authorizeCatalogOperation: async () => ({
          accessPolicy: 0,
          policyDigest: POLICY_DIGEST,
        }),
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    transports.push(authorTransport, receiverTransport);
    authorTransport.start();
    receiverTransport.start();

    await expect(receiverTransport.fetchCatalogObject(authorNode.peerId, {
      kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
      networkId: 'otp:20430' as never,
      contextGraphId: '0x1111111111111111111111111111111111111111/revoked' as never,
      subGraphName: 'member-subgraph' as never,
      authorAddress: AUTHOR,
      catalogEra: '0' as never,
      catalogVersion: '1' as never,
      policyDigest: POLICY_DIGEST,
      catalogHeadObjectDigest: `0x${'81'.repeat(32)}` as Digest32V1,
      targetObjectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
      targetObjectDigest: `0x${'82'.repeat(32)}` as Digest32V1,
    }, { timeoutMs: 4_000 })).rejects.toMatchObject({
      code: 'catalog-native-policy-denied',
    });
    expect(providerRead).toHaveBeenCalledOnce();
    expect(providerAuthorizationChecks).toBe(2);
  }, 15_000);

  it('rechecks current authorization after the outbound bundle-fetch await', async () => {
    const bundle = encodeOpaqueKaBundleV1(UTF8.encode('x'), new Uint8Array()).bundleBytes;
    const response = new Uint8Array(bundle.byteLength + 1);
    response[0] = 1;
    response.set(bundle, 1);
    const send = vi.fn(async () => response);
    let authorizationChecks = 0;
    const transport = new Rfc64PublicCatalogNativeTransportV1({
      register: () => {},
      unregister: () => {},
      send,
    } as unknown as ProtocolRouter, {
      readCatalogObjectByDigest: async () => null,
      readKaBundleByDigest: async () => null,
      authorizeCatalogOperation: async () => {
        authorizationChecks += 1;
        return authorizationChecks === 1 ? {
          accessPolicy: 0,
          policyDigest: POLICY_DIGEST,
        } : null;
      },
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    transports.push(transport);
    transport.start();

    await expect(transport.fetchKaBundle('remote-peer', {
      kind: RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
      networkId: 'otp:20430' as never,
      contextGraphId: '0x1111111111111111111111111111111111111111/recheck' as never,
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0' as never,
      catalogVersion: '1' as never,
      policyDigest: POLICY_DIGEST,
      catalogHeadObjectDigest: `0x${'81'.repeat(32)}` as Digest32V1,
      blobDigest: encodeOpaqueKaBundleV1(UTF8.encode('x'), new Uint8Array()).blobDigest,
      byteLength: bundle.byteLength.toString() as never,
    })).rejects.toMatchObject({ code: 'catalog-native-policy-denied' });
    expect(send).toHaveBeenCalledOnce();
    expect(authorizationChecks).toBe(2);
  });

  it('rejects a stale registry digest before sending a native fetch request', async () => {
    const send = vi.fn(async () => Uint8Array.of(0));
    const transport = new Rfc64PublicCatalogNativeTransportV1({
      register: () => {},
      unregister: () => {},
      send,
    } as unknown as ProtocolRouter, {
      readCatalogObjectByDigest: async () => null,
      readKaBundleByDigest: async () => null,
      authorizeCatalogOperation: async () => ({
        accessPolicy: 0,
        policyDigest: `0x${'99'.repeat(32)}` as Digest32V1,
      }),
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    transports.push(transport);
    transport.start();

    await expect(transport.fetchCatalogObject('remote-peer', {
      kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
      networkId: 'otp:20430' as never,
      contextGraphId: '0x1111111111111111111111111111111111111111/stale' as never,
      subGraphName: null,
      authorAddress: AUTHOR,
      catalogEra: '0' as never,
      catalogVersion: '1' as never,
      policyDigest: POLICY_DIGEST,
      catalogHeadObjectDigest: `0x${'81'.repeat(32)}` as Digest32V1,
      targetObjectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
      targetObjectDigest: `0x${'82'.repeat(32)}` as Digest32V1,
    })).rejects.toMatchObject({ code: 'catalog-native-policy-denied' });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a generic signature proof minted for another exact signature variant', async () => {
    const produced = await produceEmptyAuthorCatalogGenesisV1({
      scope: {
        networkId: 'otp:20430',
        contextGraphId: '0x1111111111111111111111111111111111111111/variant-binding',
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        subGraphName: null,
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
    const original = produced.directoryPath[0]!;
    const originalProof = await verifyControlEnvelopeIssuerSignatureV1(original);
    const alternate = Object.freeze({
      ...original,
      signature: alternateRecoveryEncoding(original.signature),
    }) as SignedControlEnvelopeV1;
    expect(ethers.verifyMessage(
      ethers.getBytes(alternate.objectDigest),
      alternate.signature,
    ).toLowerCase()).toBe(AUTHOR);
    expect(computeControlSignatureVariantDigestHex(
      alternate.objectDigest,
      alternate.signature,
    )).not.toBe(computeControlSignatureVariantDigestHex(
      original.objectDigest,
      original.signature,
    ));

    const bytes = canonicalizeSignedControlEnvelopeBytes(alternate);
    const response = new Uint8Array(bytes.byteLength + 1);
    response[0] = 1;
    response.set(bytes, 1);
    const router = {
      register: () => {},
      unregister: () => {},
      send: async () => response,
    } as unknown as ProtocolRouter;
    const verifyIssuerSignature = vi.fn(async () => originalProof);
    const transport = new Rfc64PublicCatalogNativeTransportV1(router, {
      readCatalogObjectByDigest: async () => null,
      readKaBundleByDigest: async () => null,
      authorizeCatalogOperation: async () => ({
        accessPolicy: 0,
        policyDigest: POLICY_DIGEST,
      }),
      verifyIssuerSignature,
    });
    transports.push(transport);
    transport.start();

    const scope = {
      networkId: produced.head.payload.networkId,
      contextGraphId: produced.head.payload.contextGraphId,
      subGraphName: produced.head.payload.subGraphName,
      authorAddress: produced.head.payload.authorAddress,
      catalogEra: produced.head.payload.era,
      catalogVersion: produced.head.payload.version,
      policyDigest: POLICY_DIGEST,
      catalogHeadObjectDigest: produced.head.objectDigest,
    } satisfies Rfc64PublicCatalogNativeFetchScopeV1;
    await expect(transport.fetchCatalogObject('peer-a', {
      ...scope,
      kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
      targetObjectType: alternate.objectType,
      targetObjectDigest: alternate.objectDigest as Digest32V1,
    })).rejects.toEqual(expect.objectContaining({
      code: 'catalog-native-signature',
    }) as Partial<Rfc64PublicCatalogNativeTransportErrorV1>);
    expect(verifyIssuerSignature).toHaveBeenCalledOnce();
  });
});

function alternateRecoveryEncoding(signature: string): string {
  const recovery = signature.slice(-2);
  if (recovery === '1b') return `${signature.slice(0, -2)}00`;
  if (recovery === '1c') return `${signature.slice(0, -2)}01`;
  throw new Error('test fixture signature did not use canonical v=27/28 encoding');
}

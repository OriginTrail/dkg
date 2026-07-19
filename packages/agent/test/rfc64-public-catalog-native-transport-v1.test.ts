import { multiaddr } from '@multiformats/multiaddr';
import {
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  DKGNode,
  ProtocolRouter,
  encodeOpaqueKaBundleV1,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type EvmAddressV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { produceEmptyAuthorCatalogGenesisV1 } from '../src/rfc64/author-catalog-producer.js';
import {
  RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
  RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1,
  RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
  RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
  Rfc64PublicCatalogNativeTransportV1,
  type Rfc64PublicCatalogNativeFetchScopeV1,
} from '../src/rfc64/public-catalog-native-transport-v1.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'65'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const POLICY_DIGEST = `0x${'73'.repeat(32)}` as Digest32V1;
const DELEGATION_DIGEST = `0x${'74'.repeat(32)}` as Digest32V1;
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

describe('RFC-64 public catalog native content transport v1', () => {
  it('fetches exact directory and bundle digests across two live libp2p nodes', async () => {
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
    const openPolicy = () => Object.freeze({ accessPolicy: 0 as const, policyDigest: POLICY_DIGEST });

    const authorTransport = new Rfc64PublicCatalogNativeTransportV1(
      new ProtocolRouter(authorNode),
      {
        readCatalogObjectByDigest: authorCatalogReads,
        readKaBundleByDigest: authorBundleReads,
        authorizeOpenCatalogOperation: async (input) => {
          authorAuthorizations.push(input.operation);
          return openPolicy();
        },
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      },
    );
    const receiverTransport = new Rfc64PublicCatalogNativeTransportV1(
      new ProtocolRouter(receiverNode),
      {
        readCatalogObjectByDigest: async () => null,
        readKaBundleByDigest: async () => null,
        authorizeOpenCatalogOperation: async (input) => {
          receiverAuthorizations.push(input.operation);
          return openPolicy();
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
      'ka-bundle-fetch-outbound',
      'ka-bundle-fetch-outbound',
    ]);
  }, 30_000);

  it('denies a private-policy request before provider lookup', async () => {
    const [authorNode, receiverNode] = await Promise.all([startNode(), startNode()]);
    await connect(receiverNode, authorNode);
    const providerRead = vi.fn(async () => null);
    const authorTransport = new Rfc64PublicCatalogNativeTransportV1(
      new ProtocolRouter(authorNode),
      {
        readCatalogObjectByDigest: providerRead,
        readKaBundleByDigest: async () => null,
        authorizeOpenCatalogOperation: async () => ({
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
        authorizeOpenCatalogOperation: async () => ({
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
});

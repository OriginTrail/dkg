import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  DKGNode,
  ProtocolRouter,
  assertAuthorCatalogRowV1,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeAuthorCatalogRowDigestV1,
  computeAuthorCatalogScopeDigestV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaChunkTreeRootV1,
  deriveAuthorCatalogScopeFromHeadV1,
  encodeOpaqueKaBundleV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  produceEmptyAuthorCatalogGenesisV1,
  produceSparseAuthorCatalogSuccessorV1,
} from '../src/rfc64/author-catalog-producer.js';
import {
  Rfc64PublicCatalogNativeReceiverV1,
} from '../src/rfc64/public-catalog-native-receiver-v1.js';
import {
  Rfc64PublicCatalogNativeTransportV1,
} from '../src/rfc64/public-catalog-native-transport-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  Rfc64PublicCatalogTransportV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from '../src/rfc64/public-catalog-transport-v1.js';
import {
  openRfc64PersistenceV1,
  type Rfc64PersistenceV1,
} from '../src/rfc64/persistence-v1.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'66'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/native-gate-1' as ContextGraphIdV1;
const GOVERNANCE = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const POLICY_DIGEST = `0x${'75'.repeat(32)}` as Digest32V1;
const DELEGATION_DIGEST = `0x${'76'.repeat(32)}` as Digest32V1;
const KA_NUMBER = 7n;
const KA_ID = ((BigInt(AUTHOR) << 96n) | KA_NUMBER).toString();
const UAL = `did:dkg:${NETWORK_ID}/${AUTHOR}/${KA_NUMBER}`;
const PROJECTION =
  '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
  + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n';
const ASSERTION_ROOT =
  '0x8d7a7be6029c98db1a7300bf47008c90084d5de4a3b97a68c043c0ea4773609f' as Digest32V1;
const UTF8 = new TextEncoder();
const DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: KAV10,
}) as CatalogSealDeploymentProfileV1;

const temporaryDirectories: string[] = [];
const nodes: DKGNode[] = [];
const persistences: Rfc64PersistenceV1[] = [];
const headTransports: Rfc64PublicCatalogTransportV1[] = [];
const nativeTransports: Rfc64PublicCatalogNativeTransportV1[] = [];

afterEach(async () => {
  for (const transport of nativeTransports.splice(0)) transport.stop();
  for (const transport of headTransports.splice(0)) transport.stop();
  for (const persistence of persistences.splice(0)) {
    try { await persistence.close(); } catch {}
  }
  for (const node of nodes.splice(0)) {
    try { await node.stop(); } catch {}
  }
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

async function openPersistence(label: string): Promise<Rfc64PersistenceV1> {
  const directory = await mkdtemp(join(tmpdir(), `dkg-rfc64-native-${label}-`));
  temporaryDirectories.push(directory);
  const persistence = await openRfc64PersistenceV1(
    directory,
    { yieldAfterPurgeBatch: async () => {} },
  );
  persistences.push(persistence);
  return persistence;
}

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

describe('RFC-64 Gate 1 native successor to public SWM', () => {
  it('fetches head to row to bundle and activates one exact KA on a live receiver', async () => {
    const fixture = await setupLiveReceiver();
    const evidence = await fixture.synchronize();

    const expectedRowDigest = computeAuthorCatalogRowDigestV1(
      computeAuthorCatalogScopeDigestV1(
        deriveAuthorCatalogScopeFromHeadV1(fixture.successor.head.payload),
      ),
      fixture.rowBundle.row,
    );
    expect(evidence).toEqual({
      inventoryDigest: fixture.successor.head.objectDigest,
      catalogRowDigest: expectedRowDigest,
      contentDigest: fixture.rowBundle.row.projectionDigest,
      bundleDigest: fixture.rowBundle.row.transfer.blobDigest,
      kaUal: UAL,
      inventoryRowCount: 1,
      activatedTripleCount: 2,
      swmGraph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${KA_NUMBER}`,
    });

    const activated = await fixture.receiverStore.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${evidence.swmGraph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`,
    );
    expect(activated).toMatchObject({ type: 'bindings' });
    if (activated.type !== 'bindings') throw new Error('receiver SWM query was not bindings');
    expect(activated.bindings).toEqual([
      {
        s: 'https://example.org/alice',
        p: 'https://schema.org/age',
        o: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
      },
      {
        s: 'https://example.org/alice',
        p: 'https://schema.org/name',
        o: '"Alice"',
      },
    ]);
    const seals = await fixture.receiverStore.query(
      'SELECT ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } '
        + 'FILTER(STRENDS(STR(?g), "/_meta")) } ORDER BY ?s ?p ?o',
    );
    expect(seals).toMatchObject({ type: 'bindings' });
    if (seals.type !== 'bindings') throw new Error('receiver seal query was not bindings');
    expect(seals.bindings).toHaveLength(14);
    expect(seals.bindings).toContainEqual(expect.objectContaining({
      p: 'http://dkg.io/ontology/authorAttestationR',
    }));

    expect(fixture.authorObjectRead.mock.calls.map(([digest]) => digest)).toEqual([
      fixture.successor.head.payload.directoryRootDigest,
      fixture.successor.bucket?.objectDigest,
    ]);
    expect(fixture.authorBundleRead).toHaveBeenCalledOnce();
    expect(fixture.authorBundleRead).toHaveBeenCalledWith(
      fixture.rowBundle.row.transfer.blobDigest,
    );
  }, 30_000);

  it('rejects a live bundle whose AuthorAttestation does not recover its catalog author', async () => {
    const attacker = new ethers.Wallet(`0x${'77'.repeat(32)}`);
    const fixture = await setupLiveReceiver(attacker);

    await expect(fixture.synchronize()).rejects.toMatchObject({
      code: 'catalog-native-receiver-transfer',
    });
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
  }, 30_000);
});

async function setupLiveReceiver(signingWallet = AUTHOR_WALLET) {
  const [authorNode, receiverNode, authorPersistence, receiverPersistence] = await Promise.all([
    startNode(),
    startNode(),
    openPersistence('author'),
    openPersistence('receiver'),
  ]);
  await connect(receiverNode, authorNode);
  const receiverStore = new OxigraphStore();
  const scope = {
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: '20430',
    governanceContractAddress: GOVERNANCE,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount: '1',
  } as AuthorCatalogScopeV1;
  const signer = {
    issuer: AUTHOR,
    signDigest: async (digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest),
  };
  const rowBundle = await buildRowBundle(signingWallet);
  const genesis = await produceEmptyAuthorCatalogGenesisV1({
    scope,
    catalogIssuerDelegationDigest: DELEGATION_DIGEST,
    issuedAt: '1773900000000' as never,
    signer,
  });
  const successor = await produceSparseAuthorCatalogSuccessorV1({
    previousHead: genesis.head,
    previousDirectoryPath: genesis.directoryPath,
    previousBucket: null,
    selectedBucketId: '0' as never,
    nextRows: [rowBundle.row],
    issuedAt: '1773900001000' as never,
    signer,
  });
  const authorObjects = new Map<string, SignedControlEnvelopeV1>(
    successor.stagedObjects.map((envelope) => [envelope.objectDigest, envelope]),
  );
  const authorObjectRead = vi.fn(async (digest: Digest32V1) =>
    authorObjects.get(digest) ?? null);
  const authorBundleRead = vi.fn(async (digest: Digest32V1) =>
    digest === rowBundle.row.transfer.blobDigest ? rowBundle.bundleBytes : null);
  const verifiedObjects = await Promise.all(
    [...genesis.stagedObjects, ...successor.stagedObjects].map(async (envelope) => ({
      envelope,
      issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
    })),
  );
  const staged = await authorPersistence.controlObjects.stageVerifiedObjects(verifiedObjects);
  const headKeys = staged.objects.at(-1);
  if (headKeys === undefined) throw new Error('successor head was not staged');
  const receivedAnnouncements: Rfc64PublicCatalogHeadAnnouncementV1[] = [];
  const openPolicy = async () => Object.freeze({
    accessPolicy: 0 as const,
    policyDigest: POLICY_DIGEST,
  });
  const authorHeadTransport = new Rfc64PublicCatalogTransportV1(
    new ProtocolRouter(authorNode),
    {
      controlObjects: authorPersistence.controlObjects,
      authorizeOpenCatalogOperation: openPolicy,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      onCatalogHeadAvailable: async () => {},
    },
  );
  const receiverHeadTransport = new Rfc64PublicCatalogTransportV1(
    new ProtocolRouter(receiverNode),
    {
      controlObjects: receiverPersistence.controlObjects,
      authorizeOpenCatalogOperation: openPolicy,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      onCatalogHeadAvailable: async (announcement) => {
        receivedAnnouncements.push(announcement);
      },
    },
  );
  const authorNativeTransport = new Rfc64PublicCatalogNativeTransportV1(
    new ProtocolRouter(authorNode),
    {
      readCatalogObjectByDigest: authorObjectRead,
      readKaBundleByDigest: authorBundleRead,
      authorizeOpenCatalogOperation: openPolicy,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    },
  );
  const receiverNativeTransport = new Rfc64PublicCatalogNativeTransportV1(
    new ProtocolRouter(receiverNode),
    {
      readCatalogObjectByDigest: async () => null,
      readKaBundleByDigest: async () => null,
      authorizeOpenCatalogOperation: openPolicy,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    },
  );
  headTransports.push(authorHeadTransport, receiverHeadTransport);
  nativeTransports.push(authorNativeTransport, receiverNativeTransport);
  authorHeadTransport.start();
  receiverHeadTransport.start();
  authorNativeTransport.start();
  receiverNativeTransport.start();
  const announcement = Object.freeze({
    kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
    networkId: successor.head.payload.networkId,
    contextGraphId: successor.head.payload.contextGraphId,
    subGraphName: successor.head.payload.subGraphName,
    authorAddress: successor.head.payload.authorAddress,
    catalogEra: successor.head.payload.era,
    catalogVersion: successor.head.payload.version,
    policyDigest: POLICY_DIGEST,
    catalogHeadObjectDigest: headKeys.objectDigest,
    signatureVariantDigest: headKeys.signatureVariantDigest,
  }) satisfies Rfc64PublicCatalogHeadAnnouncementV1;
  await authorHeadTransport.announceCatalogHead(receiverNode.peerId, announcement);
  expect(receivedAnnouncements).toEqual([announcement]);
  const receiver = new Rfc64PublicCatalogNativeReceiverV1({
    headTransport: receiverHeadTransport,
    contentTransport: receiverNativeTransport,
    controlObjects: receiverPersistence.controlObjects,
    store: receiverStore,
  });
  return {
    authorBundleRead,
    authorObjectRead,
    receiverStore,
    rowBundle,
    successor,
    synchronize: () => receiver.synchronizeOnePublicOpenRow(
      authorNode.peerId,
      receivedAnnouncements[0],
      DEPLOYMENT,
    ),
  };
}

async function buildRowBundle(
  signingWallet: ethers.Wallet = AUTHOR_WALLET,
): Promise<{ row: AuthorCatalogRowV1; bundleBytes: Uint8Array }> {
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(ASSERTION_ROOT),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(KA_ID),
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
    reservedKaId: KA_ID,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal: UAL,
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
    kaId: KA_ID,
    assertionCoordinate: 'gate-1-object',
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
  return { row, bundleBytes: encoded.bundleBytes };
}

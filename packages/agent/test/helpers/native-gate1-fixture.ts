import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { multiaddr } from '@multiformats/multiaddr';
import {
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  DKGNode,
  ProtocolRouter,
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { expect, vi } from 'vitest';
import {
  produceEmptyAuthorCatalogGenesisV1,
  produceSparseAuthorCatalogSuccessorV1,
} from '../../src/rfc64/author-catalog-producer.js';
import {
  createRfc64CatalogNativeScopedReadProviderV1,
} from '../../src/rfc64/catalog-native-scoped-read-provider-v1.js';
import type { AcceptedRfc64CatalogAccessSnapshotV1 } from '../../src/rfc64/catalog-access-policy-v1.js';
import {
  Rfc64PublicCatalogNativeReceiverV1,
  rfc64CatalogSignatureVariantDigestV1,
  type Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1,
} from '../../src/rfc64/public-catalog-native-receiver-v1.js';
import { acquireRfc64LegacySwmBoundaryReceiverLeaseV1 } from '../../src/rfc64/legacy-swm-boundary-v1.js';
import { Rfc64PublicCatalogNativeTransportV1 } from '../../src/rfc64/public-catalog-native-transport-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  Rfc64PublicCatalogTransportV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from '../../src/rfc64/public-catalog-transport-v1.js';
import { openRfc64PersistenceV1, type Rfc64PersistenceV1 } from '../../src/rfc64/persistence-v1.js';
import {
  AUTHOR_WALLET,
  AUTHOR,
  NETWORK_ID,
  CONTEXT_GRAPH_ID,
  GOVERNANCE_CONTRACT,
  POLICY_DIGEST,
  MISSING_DELEGATION_DIGEST,
  SECOND_KA_NUMBER,
  THIRD_KA_NUMBER,
  DEPLOYMENT,
  buildDirectCatalogIssuerDelegation,
  rewriteCatalogHeadDelegation,
  buildInvalidEmptyGenesis,
  buildMalformedEmptySuccessor,
  buildRowBundle,
} from './native-gate1-fixture-values.js';

export function createNativeGate1FixtureOwner(options: {
  readonly rootDirectory?: string;
  readonly receiverDirectory?: string;
} = {}) {
  const temporaryDirectories: string[] = [];
  const nodes: DKGNode[] = [];
  const persistences: Rfc64PersistenceV1[] = [];
  const headTransports: Rfc64PublicCatalogTransportV1[] = [];
  const nativeTransports: Rfc64PublicCatalogNativeTransportV1[] = [];

  async function dispose() {
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
  }

  async function openPersistence(label: string): Promise<{
    directory: string;
    persistence: Rfc64PersistenceV1;
  }> {
    const directory = label === 'receiver' && options.receiverDirectory
      ? options.receiverDirectory
      : await mkdtemp(join(options.rootDirectory ?? tmpdir(), `dkg-rfc64-native-${label}-`));
    temporaryDirectories.push(directory);
    const persistence = await openRfc64PersistenceV1(
      directory,
      { yieldAfterPurgeBatch: async () => {} },
    );
    persistences.push(persistence);
    return { directory, persistence };
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

  async function setupLiveReceiver(signingWallet = AUTHOR_WALLET) {
    const [authorNode, receiverNode, authorOpened, receiverOpened] = await Promise.all([
      startNode(),
      startNode(),
      openPersistence('author'),
      openPersistence('receiver'),
    ]);
    const authorPersistence = authorOpened.persistence;
    const receiverPersistence = receiverOpened.persistence;
    await connect(receiverNode, authorNode);
    const receiverStore = new OxigraphStore();
    const scope = {
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
    const governedScope = Object.freeze({
      ...scope,
      governanceChainId: '20430',
      governanceContractAddress: GOVERNANCE_CONTRACT,
      ownershipTransitionDigest: `0x${'57'.repeat(32)}` as Digest32V1,
    }) as AuthorCatalogScopeV1;
    const signer = {
      issuer: AUTHOR,
      signDigest: async (digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest),
    };
    const catalogIssuerDelegation = await buildDirectCatalogIssuerDelegation();
    const governedCatalogIssuerDelegation = await buildDirectCatalogIssuerDelegation({
      scope: governedScope,
    });
    const forgedCatalogIssuerDelegation = Object.freeze({
      ...catalogIssuerDelegation,
      signature: await new ethers.Wallet(`0x${'78'.repeat(32)}`).signMessage(
        ethers.getBytes(catalogIssuerDelegation.objectDigest),
      ),
    }) as SignedAuthorCatalogIssuerDelegationEnvelopeV1;
    const crossLaneDelegation = await buildDirectCatalogIssuerDelegation({
      contextGraphId:
        '0x1111111111111111111111111111111111111111/native-gate-1-other' as ContextGraphIdV1,
    });
    const expiredDelegation = await buildDirectCatalogIssuerDelegation({
      effectiveAt: '1773890000000',
      expiresAt: '1773899999999',
    });
    const rowBundle = await buildRowBundle(signingWallet);
    const secondRowBundle = await buildRowBundle(signingWallet, {
      kaNumber: SECOND_KA_NUMBER,
      assertionCoordinate: 'gate-2-object',
    });
    const thirdRowBundle = await buildRowBundle(signingWallet, {
      kaNumber: THIRD_KA_NUMBER,
      assertionCoordinate: 'gate-2-replacement-object',
    });
    const genesis = await produceEmptyAuthorCatalogGenesisV1({
      scope,
      catalogIssuerDelegationDigest: catalogIssuerDelegation.objectDigest,
      issuedAt: '1773900000000' as never,
      signer,
    });
    const governedGenesis = await produceEmptyAuthorCatalogGenesisV1({
      scope: governedScope,
      catalogIssuerDelegationDigest: governedCatalogIssuerDelegation.objectDigest,
      issuedAt: '1773900000000' as never,
      signer,
    });
    const scopeDigest = computeAuthorCatalogScopeDigestV1(scope);
    const successor = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: genesis.head,
      previousDirectoryPath: genesis.directoryPath,
      previousBucket: null,
      selectedBucketId: '0' as never,
      nextRows: [rowBundle.row],
      issuedAt: '1773900001000' as never,
      signer,
    });
    const multiAssetSuccessor = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: successor.head,
      previousDirectoryPath: successor.directoryPath,
      previousBucket: successor.bucket,
      selectedBucketId: '0' as never,
      nextRows: [rowBundle.row, secondRowBundle.row],
      issuedAt: '1773900001002' as never,
      signer,
    });
    const emptySuccessor = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: successor.head,
      previousDirectoryPath: successor.directoryPath,
      previousBucket: successor.bucket,
      selectedBucketId: '0' as never,
      nextRows: [],
      issuedAt: '1773900001001' as never,
      signer,
    });
    const malformedEmptySuccessors = await Promise.all([
      buildMalformedEmptySuccessor(
        emptySuccessor.head,
        emptySuccessor.directoryPath[0]!,
        { byteLength: '1' },
      ),
      buildMalformedEmptySuccessor(
        emptySuccessor.head,
        emptySuccessor.directoryPath[0]!,
        { bucketDigest: `0x${'91'.repeat(32)}` },
      ),
    ]);
    const removalSuccessor = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: multiAssetSuccessor.head,
      previousDirectoryPath: multiAssetSuccessor.directoryPath,
      previousBucket: multiAssetSuccessor.bucket,
      selectedBucketId: '0' as never,
      nextRows: [rowBundle.row],
      issuedAt: '1773900001003' as never,
      signer,
    });
    const threeAssetSuccessor = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: multiAssetSuccessor.head,
      previousDirectoryPath: multiAssetSuccessor.directoryPath,
      previousBucket: multiAssetSuccessor.bucket,
      selectedBucketId: '0' as never,
      nextRows: [rowBundle.row, secondRowBundle.row, thirdRowBundle.row],
      issuedAt: '1773900001004' as never,
      signer,
    });
    const replacementSuccessor = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: threeAssetSuccessor.head,
      previousDirectoryPath: threeAssetSuccessor.directoryPath,
      previousBucket: threeAssetSuccessor.bucket,
      selectedBucketId: '0' as never,
      nextRows: [rowBundle.row, thirdRowBundle.row],
      issuedAt: '1773900001005' as never,
      signer,
    });
    const governedSuccessor = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: governedGenesis.head,
      previousDirectoryPath: governedGenesis.directoryPath,
      previousBucket: null,
      selectedBucketId: '0' as never,
      nextRows: [rowBundle.row],
      issuedAt: '1773900001000' as never,
      signer,
    });
    const competingSuccessor = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: genesis.head,
      previousDirectoryPath: genesis.directoryPath,
      previousBucket: null,
      selectedBucketId: '0' as never,
      nextRows: [rowBundle.row],
      issuedAt: '1773900001001' as never,
      signer,
    });
    const alternateSecondSuccessor = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: competingSuccessor.head,
      previousDirectoryPath: competingSuccessor.directoryPath,
      previousBucket: competingSuccessor.bucket,
      selectedBucketId: '0' as never,
      nextRows: [rowBundle.row, secondRowBundle.row],
      issuedAt: '1773900001006' as never,
      signer,
    });
    const alternateThirdSuccessor = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: alternateSecondSuccessor.head,
      previousDirectoryPath: alternateSecondSuccessor.directoryPath,
      previousBucket: alternateSecondSuccessor.bucket,
      selectedBucketId: '0' as never,
      nextRows: [rowBundle.row, secondRowBundle.row, thirdRowBundle.row],
      issuedAt: '1773900001007' as never,
      signer,
    });
    const crossLaneHead = await rewriteCatalogHeadDelegation(
      successor.head,
      crossLaneDelegation.objectDigest,
    );
    const expiredHead = await rewriteCatalogHeadDelegation(
      successor.head,
      expiredDelegation.objectDigest,
    );
    const missingDelegationHead = await rewriteCatalogHeadDelegation(
      successor.head,
      MISSING_DELEGATION_DIGEST,
    );
    const missingDelegationGenesisHead = await rewriteCatalogHeadDelegation(
      genesis.head,
      MISSING_DELEGATION_DIGEST,
    );
    const invalidGenesis = await buildInvalidEmptyGenesis(
      genesis.head,
      successor.directoryPath[0]!,
    );
    const authorEnvelopes: readonly SignedControlEnvelopeV1[] = Object.freeze([
      catalogIssuerDelegation,
      governedCatalogIssuerDelegation,
      crossLaneDelegation,
      expiredDelegation,
      ...genesis.stagedObjects,
      ...governedGenesis.stagedObjects,
      ...invalidGenesis.stagedObjects,
      ...successor.stagedObjects,
      ...emptySuccessor.stagedObjects,
      ...malformedEmptySuccessors.flatMap(({ stagedObjects }) => stagedObjects),
      ...multiAssetSuccessor.stagedObjects,
      ...removalSuccessor.stagedObjects,
      ...threeAssetSuccessor.stagedObjects,
      ...replacementSuccessor.stagedObjects,
      ...governedSuccessor.stagedObjects,
      ...competingSuccessor.stagedObjects,
      ...alternateSecondSuccessor.stagedObjects,
      ...alternateThirdSuccessor.stagedObjects,
      crossLaneHead,
      expiredHead,
      missingDelegationHead,
      missingDelegationGenesisHead,
    ]);
    const authorObjects = new Map<string, SignedControlEnvelopeV1>(
      authorEnvelopes.map((envelope) => [envelope.objectDigest, envelope]),
    );
    const authorObjectRead = vi.fn(async (digest: Digest32V1) =>
      authorObjects.get(digest) ?? null);
    const bundleBytesByDigest = new Map<string, Uint8Array>([
      [rowBundle.row.transfer.blobDigest, rowBundle.bundleBytes],
      [secondRowBundle.row.transfer.blobDigest, secondRowBundle.bundleBytes],
      [thirdRowBundle.row.transfer.blobDigest, thirdRowBundle.bundleBytes],
    ]);
    const authorBundleRead = vi.fn(async (digest: Digest32V1) =>
      bundleBytesByDigest.get(digest) ?? null);
    const verifiedObjects = await Promise.all(
      authorEnvelopes.map(async (envelope) => ({
        envelope,
        issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
      })),
    );
    for (let offset = 0; offset < verifiedObjects.length; offset += 16) {
      await authorPersistence.controlObjects.stageVerifiedObjects(
        verifiedObjects.slice(offset, offset + 16),
      );
    }
    const receivedAnnouncements: Rfc64PublicCatalogHeadAnnouncementV1[] = [];
    const openPolicy = async () => Object.freeze({
      accessPolicy: 0 as const,
      policyDigest: POLICY_DIGEST,
    });
    const acceptedPublicPolicy = (
      selectedScope: Readonly<AuthorCatalogScopeV1>,
    ): AcceptedRfc64CatalogAccessSnapshotV1 => Object.freeze({
      policy: Object.freeze({
        networkId: selectedScope.networkId,
        contextGraphId: selectedScope.contextGraphId,
        governanceChainId: selectedScope.governanceChainId,
        governanceContractAddress: selectedScope.governanceContractAddress,
        ownershipTransitionDigest: selectedScope.ownershipTransitionDigest,
        era: selectedScope.era,
        version: '0',
        previousPolicyDigest: null,
        accessPolicy: 0,
        publishPolicy: 1,
        publishAuthority: null,
        publishAuthorityAccountId: '0',
        projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
        administrativeDelegationDigest: null,
        source: selectedScope.governanceChainId === null
          ? {
              kind: 'owner-signed-unregistered',
              ownerAddress: AUTHOR,
              ownerAuthorityEra: selectedScope.era,
            }
          : {
              kind: 'finalized-chain',
              chainId: selectedScope.governanceChainId,
              contractAddress: selectedScope.governanceContractAddress!,
              blockNumber: '123',
              blockHash: `0x${'77'.repeat(32)}` as Digest32V1,
            },
        effectiveAt: '1773900000000',
        issuedAt: '1773900000000',
      } satisfies ContextGraphPolicyV1),
      policyDigest: POLICY_DIGEST,
      roster: null,
    });
    const scopedControlObjects = {
      getVerifiedObjectByDigest: async ({
        objectDigest,
        verifyIssuerSignature,
      }: Parameters<Rfc64PersistenceV1['controlObjects']['getVerifiedObjectByDigest']>[0]) => {
        const envelope = await authorObjectRead(objectDigest);
        if (envelope === null) return null;
        return Object.freeze({
          envelope,
          issuerSignature: await verifyIssuerSignature(envelope),
        });
      },
    };
    const createScopedProvider = (selectedScope: Readonly<AuthorCatalogScopeV1>) =>
      createRfc64CatalogNativeScopedReadProviderV1({
        controlObjects: scopedControlObjects,
        kaBundles: { readKaBundleByDigest: authorBundleRead },
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
        resolveAcceptedPolicySnapshot: async () => acceptedPublicPolicy(selectedScope),
      });
    const resolveUngovernedScopedRead = createScopedProvider(scope);
    const resolveGovernedScopedRead = createScopedProvider(governedScope);
    const governedHeadDigests = new Set([
      governedGenesis.head.objectDigest,
      governedSuccessor.head.objectDigest,
    ]);
    const resolveScopedReadCapability = async (
      requestedScope: Parameters<typeof resolveUngovernedScopedRead>[0],
    ) => (governedHeadDigests.has(requestedScope.catalogHeadObjectDigest)
      ? resolveGovernedScopedRead(requestedScope)
      : resolveUngovernedScopedRead(requestedScope));
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
        resolveScopedReadCapability,
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
    const announcementFor = (
      head: Readonly<SignedAuthorCatalogHeadEnvelopeV1>,
    ): Readonly<Rfc64PublicCatalogHeadAnnouncementV1> => Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
      networkId: head.payload.networkId,
      contextGraphId: head.payload.contextGraphId,
      subGraphName: head.payload.subGraphName,
      authorAddress: head.payload.authorAddress,
      catalogEra: head.payload.era,
      policyDigest: POLICY_DIGEST,
      catalogVersion: head.payload.version,
      catalogHeadObjectDigest: head.objectDigest,
      signatureVariantDigest: rfc64CatalogSignatureVariantDigestV1(head),
    });
    const announcement = announcementFor(successor.head);
    const genesisAnnouncement = announcementFor(genesis.head);
    const multiAssetAnnouncement = announcementFor(multiAssetSuccessor.head);
    const emptySuccessorAnnouncement = announcementFor(emptySuccessor.head);
    const malformedEmptySuccessorAnnouncements = malformedEmptySuccessors.map(({ head }) => (
      announcementFor(head)
    ));
    const removalAnnouncement = announcementFor(removalSuccessor.head);
    const replacementAnnouncement = announcementFor(replacementSuccessor.head);
    const threeAssetAnnouncement = announcementFor(threeAssetSuccessor.head);
    const competingAnnouncement = announcementFor(competingSuccessor.head);
    const alternateThirdAnnouncement = announcementFor(alternateThirdSuccessor.head);
    const governedGenesisAnnouncement = announcementFor(governedGenesis.head);
    const governedSuccessorAnnouncement = announcementFor(governedSuccessor.head);
    const crossLaneAnnouncement = announcementFor(crossLaneHead);
    const expiredAnnouncement = announcementFor(expiredHead);
    const missingDelegationAnnouncement = announcementFor(missingDelegationHead);
    const missingDelegationGenesisAnnouncement = announcementFor(missingDelegationGenesisHead);
    const invalidGenesisAnnouncement = announcementFor(invalidGenesis.head);
    await authorHeadTransport.announceCatalogHead(receiverNode.peerId, genesisAnnouncement);
    await authorHeadTransport.announceCatalogHead(receiverNode.peerId, announcement);
    expect(receivedAnnouncements).toEqual([genesisAnnouncement, announcement]);
    const receiverHeadFetch = vi.fn(
      receiverHeadTransport.fetchCatalogHead.bind(receiverHeadTransport),
    );
    const receiverObjectFetch = vi.fn(
      receiverNativeTransport.fetchCatalogObject.bind(receiverNativeTransport),
    );
    const receiverBundleFetch = vi.fn(
      receiverNativeTransport.fetchKaBundle.bind(receiverNativeTransport),
    );
    const createReceiver = (
      inventory: Pick<
        Rfc64PersistenceV1['inventory'],
        'readAppliedCatalogHeadV1' | 'compareAndSwapAppliedCatalogHeadV1'
      >,
      controlObjects: Pick<
        Rfc64PersistenceV1['controlObjects'],
        'stageVerifiedObjects' | 'getVerifiedObjectByDigest'
      > & Partial<Pick<
        Rfc64PersistenceV1['controlObjects'],
        'getVerifiedObject'
      >> = receiverPersistence.controlObjects,
      contentTransport: Pick<
        Rfc64PublicCatalogNativeTransportV1,
        'fetchCatalogObject' | 'fetchKaBundle'
      > = {
        fetchCatalogObject: receiverObjectFetch,
        fetchKaBundle: receiverBundleFetch,
      },
      store: TripleStore = receiverStore,
      beforeAppliedHeadCommit?: Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1,
      kaBundles: Pick<
        Rfc64PersistenceV1['kaBundles'],
        'putKaBundle' | 'readKaBundleByDigest'
      > =
        receiverPersistence.kaBundles,
      verifyIssuerSignature?: typeof verifyControlEnvelopeIssuerSignatureV1,
      resolveColdBootstrapLegacySwmGraphAllowlist?: (
        scope: Readonly<AuthorCatalogScopeV1>,
      ) => Promise<ReadonlySet<string>>,
      acquireLegacySwmBoundaryLease?: (
        scope: Readonly<AuthorCatalogScopeV1>,
        request: Readonly<{ replay: boolean }>,
      ) => ReturnType<typeof acquireRfc64LegacySwmBoundaryReceiverLeaseV1>,
    ) => new Rfc64PublicCatalogNativeReceiverV1({
      headTransport: { fetchCatalogHead: receiverHeadFetch },
      contentTransport,
      controlObjects,
      inventory,
      kaBundles,
      store,
      verifyIssuerSignature,
      beforeAppliedHeadCommit,
      resolveColdBootstrapLegacySwmGraphAllowlist,
      acquireLegacySwmBoundaryLease,
    });
    const createCasObservedReceiver = (contentTransport?: Pick<
      Rfc64PublicCatalogNativeTransportV1,
      'fetchCatalogObject' | 'fetchKaBundle'
    >, store: TripleStore = receiverStore, kaBundles: Pick<
      Rfc64PersistenceV1['kaBundles'],
      'putKaBundle' | 'readKaBundleByDigest'
    > | undefined = undefined, getVerifiedObjectByDigest: Rfc64PersistenceV1[
      'controlObjects'
    ]['getVerifiedObjectByDigest'] = receiverPersistence.controlObjects
      .getVerifiedObjectByDigest.bind(receiverPersistence.controlObjects)) => {
      const compareAndSwapAppliedCatalogHeadV1 = vi.fn(
        receiverPersistence.inventory.compareAndSwapAppliedCatalogHeadV1.bind(
          receiverPersistence.inventory,
        ),
      );
      const stageVerifiedObjects = vi.fn(
        receiverPersistence.controlObjects.stageVerifiedObjects.bind(
          receiverPersistence.controlObjects,
        ),
      );
      const selectedKaBundles = kaBundles ?? {
        putKaBundle: receiverPersistence.kaBundles.putKaBundle.bind(
          receiverPersistence.kaBundles,
        ),
        // Security-path tests alter transport bundles. Keep those tests on the
        // network path; restart/cache behavior has a separate explicit test.
        readKaBundleByDigest: vi.fn(async () => null),
      };
      return Object.freeze({
        compareAndSwapAppliedCatalogHeadV1,
        stageVerifiedObjects,
        receiver: createReceiver({
          readAppliedCatalogHeadV1:
            receiverPersistence.inventory.readAppliedCatalogHeadV1.bind(
              receiverPersistence.inventory,
            ),
          compareAndSwapAppliedCatalogHeadV1,
        }, {
          stageVerifiedObjects,
          getVerifiedObjectByDigest,
        }, contentTransport, store, undefined, selectedKaBundles),
      });
    };
    const receiver = createReceiver(receiverPersistence.inventory);
    return {
      announcement,
      authorBundleRead,
      authorObjectRead,
      authorObjects,
      alternateThirdAnnouncement,
      catalogIssuerDelegation,
      competingAnnouncement,
      crossLaneAnnouncement,
      createCasObservedReceiver,
      createReceiver,
      expiredAnnouncement,
      emptySuccessor,
      emptySuccessorAnnouncement,
      malformedEmptySuccessorAnnouncements,
      forgedCatalogIssuerDelegation,
      genesis,
      genesisAnnouncement,
      governedGenesis,
      governedGenesisAnnouncement,
      governedScope,
      governedSuccessor,
      governedSuccessorAnnouncement,
      invalidGenesisAnnouncement,
      receiver,
      receiverBundleFetch,
      missingDelegationAnnouncement,
      missingDelegationGenesisAnnouncement,
      multiAssetAnnouncement,
      multiAssetSuccessor,
      removalAnnouncement,
      removalSuccessor,
      replacementAnnouncement,
      replacementSuccessor,
      receiverDirectory: receiverOpened.directory,
      receiverHeadFetch,
      receiverObjectFetch,
      receiverPersistence,
      receiverStore,
      rowBundle,
      secondRowBundle,
      thirdRowBundle,
      threeAssetAnnouncement,
      threeAssetSuccessor,
      scope,
      scopeDigest,
      successor,
      bootstrap: (
        selectedAnnouncement = genesisAnnouncement,
        selectedReceiver = receiver,
        signal?: AbortSignal,
      ) => selectedReceiver.bootstrapEmptyBoundedPublicRootCatalog(
        authorNode.peerId,
        selectedAnnouncement,
        scope,
        DEPLOYMENT,
        signal,
      ),
      bootstrapGoverned: (
        selectedReceiver = receiver,
        signal?: AbortSignal,
      ) => selectedReceiver.bootstrapEmptyBoundedPublicRootCatalog(
        authorNode.peerId,
        governedGenesisAnnouncement,
        governedScope,
        DEPLOYMENT,
        signal,
      ),
      synchronize: (
        selectedAnnouncement = announcement,
        selectedReceiver = receiver,
        signal?: AbortSignal,
      ) => selectedReceiver.synchronizeOneBoundedPublicRootRow(
        authorNode.peerId,
        selectedAnnouncement,
        scope,
        DEPLOYMENT,
        signal,
      ),
      synchronizeAny: (
        selectedAnnouncement = announcement,
        selectedReceiver = receiver,
        signal?: AbortSignal,
      ) => selectedReceiver.synchronizeBoundedPublicRootCatalog(
        authorNode.peerId,
        selectedAnnouncement,
        scope,
        DEPLOYMENT,
        signal,
      ),
      synchronizeGoverned: (
        selectedReceiver = receiver,
        signal?: AbortSignal,
      ) => selectedReceiver.synchronizeOneBoundedPublicRootRow(
        authorNode.peerId,
        governedSuccessorAnnouncement,
        governedScope,
        DEPLOYMENT,
        signal,
      ),
    };
  }


  return { setupLiveReceiver, dispose, persistences };
}

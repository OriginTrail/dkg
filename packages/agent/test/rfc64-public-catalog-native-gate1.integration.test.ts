import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  DKGNode,
  ProtocolRouter,
  assertAuthorCatalogRowV1,
  assertCanonicalGraphScopedAuthorSealV1,
  buildAuthorAttestationTypedData,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeAuthorCatalogRowDigestV1,
  computeAuthorCatalogScopeDigestV1,
  computeAuthorCatalogHeadObjectDigestV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeControlObjectDigestHex,
  computeKaChunkTreeRootV1,
  deriveAuthorCatalogScopeFromHeadV1,
  encodeOpaqueKaBundleV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type AuthorCatalogHeadV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
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
  computeRfc64AppliedInventoryDigestV1,
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
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const POLICY_DIGEST = `0x${'75'.repeat(32)}` as Digest32V1;
const MISSING_DELEGATION_DIGEST = `0x${'76'.repeat(32)}` as Digest32V1;
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

async function openPersistence(label: string): Promise<{
  directory: string;
  persistence: Rfc64PersistenceV1;
}> {
  const directory = await mkdtemp(join(tmpdir(), `dkg-rfc64-native-${label}-`));
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

describe('RFC-64 Gate 1 native successor to public SWM', () => {
  it('bootstraps exact empty genesis then activates one successor without manual seeding', async () => {
    const fixture = await setupLiveReceiver();
    const genesisEvidence = await fixture.bootstrap();
    expect(genesisEvidence).toEqual({
      inventoryDigest: computeRfc64AppliedInventoryDigestV1({
        catalogScopeDigest: fixture.scopeDigest,
        rows: [],
      }),
      catalogHeadDigest: fixture.genesis.head.objectDigest,
      inventoryRowCount: 0,
      activatedTripleCount: 0,
      stagedObjectCount: 3,
      appliedHeadStatus: 'applied',
    });
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
    const evidence = await fixture.synchronize();

    const expectedRowDigest = computeAuthorCatalogRowDigestV1(
      computeAuthorCatalogScopeDigestV1(
        deriveAuthorCatalogScopeFromHeadV1(fixture.successor.head.payload),
      ),
      fixture.rowBundle.row,
    );
    expect(evidence).toMatchObject({
      inventoryDigest: computeRfc64AppliedInventoryDigestV1({
        catalogScopeDigest: computeAuthorCatalogScopeDigestV1(
          deriveAuthorCatalogScopeFromHeadV1(fixture.successor.head.payload),
        ),
        rows: [{
          catalogRowDigest: expectedRowDigest,
          contentDigest: fixture.rowBundle.row.projectionDigest,
          sealDigest: fixture.rowBundle.row.sealDigest,
          kaUal: UAL,
          activatedTripleCount: 2,
        }],
      }),
      catalogHeadDigest: fixture.successor.head.objectDigest,
      catalogRowDigest: expectedRowDigest,
      contentDigest: fixture.rowBundle.row.projectionDigest,
      bundleDigest: fixture.rowBundle.row.transfer.blobDigest,
      kaUal: UAL,
      inventoryRowCount: 1,
      activatedTripleCount: 2,
      swmGraph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${KA_NUMBER}`,
      appliedHeadStatus: 'applied',
    });
    expect(evidence.authorship).toMatchObject({
      authorAddress: AUTHOR,
      catalogIssuerKey: AUTHOR,
      catalogIssuerDelegationObjectDigest: fixture.catalogIssuerDelegation.objectDigest,
      catalogHeadObjectDigest: fixture.successor.head.objectDigest,
      catalogRowDigest: expectedRowDigest,
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      era: '0',
      version: '1',
    });
    expect(Object.isFrozen(evidence.authorship)).toBe(true);
    expect(evidence.inventoryDigest).not.toBe(evidence.catalogHeadDigest);

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
      fixture.catalogIssuerDelegation.objectDigest,
      fixture.genesis.head.payload.directoryRootDigest,
      fixture.catalogIssuerDelegation.objectDigest,
      fixture.successor.head.payload.directoryRootDigest,
      fixture.successor.bucket?.objectDigest,
    ]);
    expect(fixture.authorBundleRead).toHaveBeenCalledOnce();
    expect(fixture.authorBundleRead).toHaveBeenCalledWith(
      fixture.rowBundle.row.transfer.blobDigest,
    );
    await expect(fixture.receiverPersistence.controlObjects.getVerifiedObjectByDigest({
      objectDigest: fixture.catalogIssuerDelegation.objectDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    })).resolves.toMatchObject({
      envelope: { objectDigest: fixture.catalogIssuerDelegation.objectDigest },
    });
  }, 30_000);

  it('rejects a signed genesis whose directory is not exactly empty', async () => {
    const fixture = await setupLiveReceiver();

    await expect(fixture.bootstrap(fixture.invalidGenesisAnnouncement)).rejects.toMatchObject({
      code: 'catalog-native-receiver-catalog',
    });
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toBeNull();
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
  }, 30_000);

  it('threads one AbortSignal and timeout through every head, object, and bundle fetch path', async () => {
    const fixture = await setupLiveReceiver();
    const signal = new AbortController().signal;

    await fixture.bootstrap(
      fixture.genesisAnnouncement,
      fixture.receiver,
      signal,
    );
    await fixture.synchronize(
      fixture.announcement,
      fixture.receiver,
      signal,
    );
    await fixture.synchronizeAny(
      fixture.announcement,
      fixture.receiver,
      signal,
    );

    expect(fixture.receiverHeadFetch).toHaveBeenCalledTimes(3);
    expect(fixture.receiverObjectFetch).toHaveBeenCalledTimes(8);
    expect(fixture.receiverBundleFetch).toHaveBeenCalledTimes(2);
    for (const fetch of [
      fixture.receiverHeadFetch,
      fixture.receiverObjectFetch,
      fixture.receiverBundleFetch,
    ]) {
      for (const call of fetch.mock.calls) {
        expect(call.at(-1)).toEqual({ timeoutMs: 10_000, signal });
      }
    }
  }, 30_000);

  it('retries genesis idempotently after verified staging wins but its CAS crashes', async () => {
    const fixture = await setupLiveReceiver();
    const crashGapReceiver = fixture.createReceiver({
      readAppliedCatalogHeadV1:
        fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1.bind(
          fixture.receiverPersistence.inventory,
        ),
      compareAndSwapAppliedCatalogHeadV1: () => {
        throw new Error('simulated crash after genesis staging and before applied-head CAS');
      },
    });

    await expect(fixture.bootstrap(
      fixture.genesisAnnouncement,
      crashGapReceiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-history' });
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toBeNull();
    await expect(fixture.bootstrap()).resolves.toMatchObject({
      appliedHeadStatus: 'applied',
      inventoryRowCount: 0,
    });
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
  }, 30_000);

  it('replays genesis after persistence restart and then accepts its successor', async () => {
    const fixture = await setupLiveReceiver();
    await expect(fixture.bootstrap()).resolves.toMatchObject({
      appliedHeadStatus: 'applied',
      inventoryRowCount: 0,
    });
    await fixture.receiverPersistence.close();
    const reopened = await openRfc64PersistenceV1(
      fixture.receiverDirectory,
      { yieldAfterPurgeBatch: async () => {} },
    );
    persistences.push(reopened);
    const restartedReceiver = fixture.createReceiver(
      reopened.inventory,
      reopened.controlObjects,
    );

    await expect(fixture.bootstrap(
      fixture.genesisAnnouncement,
      restartedReceiver,
    )).resolves.toMatchObject({
      appliedHeadStatus: 'existing',
      inventoryRowCount: 0,
    });
    expect(reopened.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toMatchObject({
      currentCatalogHeadDigest: fixture.genesis.head.objectDigest,
      appliedInventoryDigest: computeRfc64AppliedInventoryDigestV1({
        catalogScopeDigest: fixture.scopeDigest,
        rows: [],
      }),
      catalogVersion: '0',
      inventoryRowCount: '0',
    });
    await expect(fixture.synchronize(
      fixture.announcement,
      restartedReceiver,
    )).resolves.toMatchObject({
      appliedHeadStatus: 'applied',
      inventoryRowCount: 1,
    });
  }, 30_000);

  it('rejects a live bundle whose AuthorAttestation does not recover its catalog author', async () => {
    const attacker = new ethers.Wallet(`0x${'77'.repeat(32)}`);
    const fixture = await setupLiveReceiver(attacker);
    await fixture.bootstrap();

    await expect(fixture.synchronize()).rejects.toMatchObject({
      code: 'catalog-native-receiver-transfer',
    });
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
  }, 30_000);

  it('rejects a forged catalog-issuer delegation signature before activation or applied-head CAS', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    fixture.authorObjects.set(
      fixture.catalogIssuerDelegation.objectDigest,
      fixture.forgedCatalogIssuerDelegation,
    );
    fixture.authorBundleRead.mockClear();
    const observed = fixture.createCasObservedReceiver();

    await expect(fixture.synchronize(fixture.announcement, observed.receiver)).rejects.toMatchObject({
      code: 'catalog-native-receiver-authorization',
    });
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.genesis.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
    expect(fixture.authorBundleRead).not.toHaveBeenCalled();
  }, 30_000);

  it('rejects a cross-lane catalog-issuer delegation before activation or applied-head CAS', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    fixture.authorBundleRead.mockClear();
    const observed = fixture.createCasObservedReceiver();

    await expect(fixture.synchronize(
      fixture.crossLaneAnnouncement,
      observed.receiver,
    )).rejects.toMatchObject({
      code: 'catalog-native-receiver-authorization',
    });
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.genesis.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
    expect(fixture.authorBundleRead).not.toHaveBeenCalled();
  }, 30_000);

  it('rejects an expired catalog-issuer delegation before activation or applied-head CAS', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    fixture.authorBundleRead.mockClear();
    const observed = fixture.createCasObservedReceiver();

    await expect(fixture.synchronize(
      fixture.expiredAnnouncement,
      observed.receiver,
    )).rejects.toMatchObject({
      code: 'catalog-native-receiver-authorization',
    });
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.genesis.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
    expect(fixture.authorBundleRead).not.toHaveBeenCalled();
  }, 30_000);

  it('rejects a missing catalog-issuer delegation before activation or applied-head CAS', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    fixture.authorBundleRead.mockClear();
    const observed = fixture.createCasObservedReceiver();

    await expect(fixture.synchronize(
      fixture.missingDelegationAnnouncement,
      observed.receiver,
    )).rejects.toMatchObject({
      code: 'catalog-native-receiver-not-found',
    });
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.genesis.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
    expect(fixture.authorBundleRead).not.toHaveBeenCalled();
  }, 30_000);

  it('serializes one scope so a competing successor never activates over the winner', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    const winner = fixture.synchronize();
    const loser = fixture.synchronize(fixture.competingAnnouncement);

    await expect(winner).resolves.toMatchObject({ appliedHeadStatus: 'applied' });
    await expect(loser).rejects.toMatchObject({ code: 'catalog-native-receiver-history' });
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.successor.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(16);
  }, 30_000);

  it('repairs the semantic-before-CAS crash gap idempotently on a new receiver instance', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    const crashGapReceiver = fixture.createReceiver({
      readAppliedCatalogHeadV1:
        fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1.bind(
          fixture.receiverPersistence.inventory,
        ),
      compareAndSwapAppliedCatalogHeadV1: () => {
        throw new Error('simulated crash after semantic post-read and before applied-head CAS');
      },
    });
    await expect(fixture.synchronize(fixture.announcement, crashGapReceiver)).rejects.toMatchObject({
      code: 'catalog-native-receiver-history',
    });
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.genesis.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(16);

    const repaired = await fixture.synchronize(
      fixture.announcement,
      fixture.createReceiver(fixture.receiverPersistence.inventory),
    );
    expect(repaired.appliedHeadStatus).toBe('applied');
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.successor.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(16);
  }, 30_000);
});

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
  const signer = {
    issuer: AUTHOR,
    signDigest: async (digest: Uint8Array) => AUTHOR_WALLET.signMessage(digest),
  };
  const catalogIssuerDelegation = await buildDirectCatalogIssuerDelegation();
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
  const genesis = await produceEmptyAuthorCatalogGenesisV1({
    scope,
    catalogIssuerDelegationDigest: catalogIssuerDelegation.objectDigest,
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
  const competingSuccessor = await produceSparseAuthorCatalogSuccessorV1({
    previousHead: genesis.head,
    previousDirectoryPath: genesis.directoryPath,
    previousBucket: null,
    selectedBucketId: '0' as never,
    nextRows: [rowBundle.row],
    issuedAt: '1773900001001' as never,
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
  const invalidGenesis = await buildInvalidEmptyGenesis(
    genesis.head,
    successor.directoryPath[0]!,
  );
  const authorObjects = new Map<string, SignedControlEnvelopeV1>(
    [
      catalogIssuerDelegation,
      crossLaneDelegation,
      expiredDelegation,
      ...genesis.stagedObjects,
      ...invalidGenesis.stagedObjects,
      ...successor.stagedObjects,
      ...competingSuccessor.stagedObjects,
      crossLaneHead,
      expiredHead,
      missingDelegationHead,
    ]
      .map((envelope) => [envelope.objectDigest, envelope]),
  );
  const authorObjectRead = vi.fn(async (digest: Digest32V1) =>
    authorObjects.get(digest) ?? null);
  const authorBundleRead = vi.fn(async (digest: Digest32V1) =>
    digest === rowBundle.row.transfer.blobDigest ? rowBundle.bundleBytes : null);
  const verifiedObjects = await Promise.all(
    [
      catalogIssuerDelegation,
      crossLaneDelegation,
      expiredDelegation,
      ...genesis.stagedObjects,
      ...invalidGenesis.stagedObjects,
      ...successor.stagedObjects,
      ...competingSuccessor.stagedObjects,
      crossLaneHead,
      expiredHead,
      missingDelegationHead,
    ]
      .map(async (envelope) => ({
      envelope,
      issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
      })),
  );
  const staged = await authorPersistence.controlObjects.stageVerifiedObjects(verifiedObjects);
  const headKeys = staged.objects.find(
    (keys) => keys.objectDigest === successor.head.objectDigest,
  );
  const genesisHeadKeys = staged.objects.find(
    (keys) => keys.objectDigest === genesis.head.objectDigest,
  );
  const invalidGenesisHeadKeys = staged.objects.find(
    (keys) => keys.objectDigest === invalidGenesis.head.objectDigest,
  );
  const competingHeadKeys = staged.objects.find(
    (keys) => keys.objectDigest === competingSuccessor.head.objectDigest,
  );
  const crossLaneHeadKeys = staged.objects.find(
    (keys) => keys.objectDigest === crossLaneHead.objectDigest,
  );
  const expiredHeadKeys = staged.objects.find(
    (keys) => keys.objectDigest === expiredHead.objectDigest,
  );
  const missingDelegationHeadKeys = staged.objects.find(
    (keys) => keys.objectDigest === missingDelegationHead.objectDigest,
  );
  if (headKeys === undefined) throw new Error('successor head was not staged');
  if (genesisHeadKeys === undefined) throw new Error('genesis head was not staged');
  if (invalidGenesisHeadKeys === undefined) throw new Error('invalid genesis head was not staged');
  if (competingHeadKeys === undefined) throw new Error('competing successor head was not staged');
  if (crossLaneHeadKeys === undefined) throw new Error('cross-lane successor head was not staged');
  if (expiredHeadKeys === undefined) throw new Error('expired-delegation head was not staged');
  if (missingDelegationHeadKeys === undefined) throw new Error('missing-delegation head was not staged');
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
  const genesisAnnouncement = Object.freeze({
    ...announcement,
    catalogVersion: genesis.head.payload.version,
    catalogHeadObjectDigest: genesisHeadKeys.objectDigest,
    signatureVariantDigest: genesisHeadKeys.signatureVariantDigest,
  }) satisfies Rfc64PublicCatalogHeadAnnouncementV1;
  const competingAnnouncement = Object.freeze({
    ...announcement,
    catalogHeadObjectDigest: competingHeadKeys.objectDigest,
    signatureVariantDigest: competingHeadKeys.signatureVariantDigest,
  }) satisfies Rfc64PublicCatalogHeadAnnouncementV1;
  const crossLaneAnnouncement = Object.freeze({
    ...announcement,
    catalogHeadObjectDigest: crossLaneHeadKeys.objectDigest,
    signatureVariantDigest: crossLaneHeadKeys.signatureVariantDigest,
  }) satisfies Rfc64PublicCatalogHeadAnnouncementV1;
  const expiredAnnouncement = Object.freeze({
    ...announcement,
    catalogHeadObjectDigest: expiredHeadKeys.objectDigest,
    signatureVariantDigest: expiredHeadKeys.signatureVariantDigest,
  }) satisfies Rfc64PublicCatalogHeadAnnouncementV1;
  const missingDelegationAnnouncement = Object.freeze({
    ...announcement,
    catalogHeadObjectDigest: missingDelegationHeadKeys.objectDigest,
    signatureVariantDigest: missingDelegationHeadKeys.signatureVariantDigest,
  }) satisfies Rfc64PublicCatalogHeadAnnouncementV1;
  const invalidGenesisAnnouncement = Object.freeze({
    ...genesisAnnouncement,
    catalogHeadObjectDigest: invalidGenesisHeadKeys.objectDigest,
    signatureVariantDigest: invalidGenesisHeadKeys.signatureVariantDigest,
  }) satisfies Rfc64PublicCatalogHeadAnnouncementV1;
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
    controlObjects = receiverPersistence.controlObjects,
  ) => new Rfc64PublicCatalogNativeReceiverV1({
    headTransport: { fetchCatalogHead: receiverHeadFetch },
    contentTransport: {
      fetchCatalogObject: receiverObjectFetch,
      fetchKaBundle: receiverBundleFetch,
    },
    controlObjects,
    inventory,
    store: receiverStore,
  });
  const createCasObservedReceiver = () => {
    const compareAndSwapAppliedCatalogHeadV1 = vi.fn(
      receiverPersistence.inventory.compareAndSwapAppliedCatalogHeadV1.bind(
        receiverPersistence.inventory,
      ),
    );
    return Object.freeze({
      compareAndSwapAppliedCatalogHeadV1,
      receiver: createReceiver({
        readAppliedCatalogHeadV1:
          receiverPersistence.inventory.readAppliedCatalogHeadV1.bind(
            receiverPersistence.inventory,
          ),
        compareAndSwapAppliedCatalogHeadV1,
      }),
    });
  };
  const receiver = createReceiver(receiverPersistence.inventory);
  return {
    announcement,
    authorBundleRead,
    authorObjectRead,
    authorObjects,
    catalogIssuerDelegation,
    competingAnnouncement,
    crossLaneAnnouncement,
    createCasObservedReceiver,
    createReceiver,
    expiredAnnouncement,
    forgedCatalogIssuerDelegation,
    genesis,
    genesisAnnouncement,
    invalidGenesisAnnouncement,
    receiver,
    receiverBundleFetch,
    missingDelegationAnnouncement,
    receiverDirectory: receiverOpened.directory,
    receiverHeadFetch,
    receiverObjectFetch,
    receiverPersistence,
    receiverStore,
    rowBundle,
    scopeDigest,
    successor,
    bootstrap: (
      selectedAnnouncement = genesisAnnouncement,
      selectedReceiver = receiver,
      signal?: AbortSignal,
    ) => selectedReceiver.bootstrapEmptyPublicOpenCatalog(
      authorNode.peerId,
      selectedAnnouncement,
      DEPLOYMENT,
      signal,
    ),
    synchronize: (
      selectedAnnouncement = announcement,
      selectedReceiver = receiver,
      signal?: AbortSignal,
    ) => selectedReceiver.synchronizeOnePublicOpenRow(
      authorNode.peerId,
      selectedAnnouncement,
      DEPLOYMENT,
      signal,
    ),
    synchronizeAny: (
      selectedAnnouncement = announcement,
      selectedReceiver = receiver,
      signal?: AbortSignal,
    ) => selectedReceiver.synchronizePublicOpenCatalog(
      authorNode.peerId,
      selectedAnnouncement,
      DEPLOYMENT,
      signal,
    ),
  };
}

async function buildDirectCatalogIssuerDelegation(options: {
  readonly contextGraphId?: ContextGraphIdV1;
  readonly effectiveAt?: string;
  readonly expiresAt?: string;
} = {}): Promise<SignedAuthorCatalogIssuerDelegationEnvelopeV1> {
  const unsigned = testUnsignedEnvelope(
    AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
    {
      authorAddress: AUTHOR,
      authorAuthorityEvidenceDigest: null,
      catalogEra: '0',
      catalogIssuerKey: AUTHOR,
      contextGraphId: options.contextGraphId ?? CONTEXT_GRAPH_ID,
      effectiveAt: options.effectiveAt ?? '1773899999000',
      expiresAt: options.expiresAt ?? '1774000000000',
      governanceChainId: null,
      governanceContractAddress: null,
      networkId: NETWORK_ID,
      ownershipTransitionDigest: null,
      previousDelegationDigest: null,
      subGraphName: null,
    },
  );
  return signTestEnvelope(
    unsigned,
    computeControlObjectDigestHex(unsigned) as Digest32V1,
  ) as Promise<SignedAuthorCatalogIssuerDelegationEnvelopeV1>;
}

async function rewriteCatalogHeadDelegation(
  sourceHead: SignedAuthorCatalogHeadEnvelopeV1,
  catalogIssuerDelegationDigest: Digest32V1,
): Promise<SignedAuthorCatalogHeadEnvelopeV1> {
  const headPayload = {
    ...sourceHead.payload,
    catalogIssuerDelegationDigest,
  } as AuthorCatalogHeadV1;
  const unsigned = testUnsignedEnvelope(AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1, headPayload);
  return signTestEnvelope(
    unsigned,
    computeAuthorCatalogHeadObjectDigestV1(unsigned),
  ) as Promise<SignedAuthorCatalogHeadEnvelopeV1>;
}

async function buildInvalidEmptyGenesis(
  sourceHead: SignedAuthorCatalogHeadEnvelopeV1,
  sourceDirectory: SignedAuthorCatalogDirectoryNodeEnvelopeV1,
): Promise<{
  head: SignedAuthorCatalogHeadEnvelopeV1;
  stagedObjects: readonly SignedControlEnvelopeV1[];
}> {
  const headPayload = {
    ...sourceHead.payload,
    directoryRootDigest: sourceDirectory.objectDigest,
  } as AuthorCatalogHeadV1;
  const headUnsigned = testUnsignedEnvelope(AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1, headPayload);
  const head = await signTestEnvelope(
    headUnsigned,
    computeAuthorCatalogHeadObjectDigestV1(headUnsigned),
  ) as SignedAuthorCatalogHeadEnvelopeV1;
  return Object.freeze({ head, stagedObjects: Object.freeze([sourceDirectory, head]) });
}

function testUnsignedEnvelope(
  objectType: string,
  payload: unknown,
): UnsignedControlEnvelopeV1 {
  return Object.freeze({
    issuer: AUTHOR,
    objectType,
    payload,
    signatureEvidence: Object.freeze({ kind: 'none' }),
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }) as UnsignedControlEnvelopeV1;
}

async function signTestEnvelope(
  unsigned: UnsignedControlEnvelopeV1,
  objectDigest: Digest32V1,
): Promise<SignedControlEnvelopeV1> {
  return Object.freeze({
    ...unsigned,
    objectDigest,
    signature: await AUTHOR_WALLET.signMessage(ethers.getBytes(objectDigest)),
  }) as SignedControlEnvelopeV1;
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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
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
  decodeOpaqueKaBundleV1,
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  deriveAuthorCatalogScopeFromHeadV1,
  encodeOpaqueKaBundleV1,
  parseCanonicalGraphScopedAuthorSealV1,
  projectCanonicalGraphScopedAuthorSealRowsV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type AuthorCatalogHeadV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
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
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  produceEmptyAuthorCatalogGenesisV1,
  produceSparseAuthorCatalogSuccessorV1,
} from '../src/rfc64/author-catalog-producer.js';
import { createRfc64CatalogNativeScopedReadProviderV1 } from '../src/rfc64/catalog-native-scoped-read-provider-v1.js';
import type { AcceptedRfc64CatalogAccessSnapshotV1 } from '../src/rfc64/catalog-access-policy-v1.js';
import {
  Rfc64PublicCatalogNativeReceiverV1,
  rfc64CatalogSignatureVariantDigestV1,
  type Rfc64PublicCatalogNativeAppliedHeadLifecycleV1,
  type Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1,
  type Rfc64PublicCatalogNativeCommittedHeadTokenV1,
  type Rfc64PublicCatalogNativePrecommitTransactionV1,
} from '../src/rfc64/public-catalog-native-receiver-v1.js';
import { readVerifiedAuthorCatalogRowAuthorshipV1 } from '../src/rfc64/catalog-row-authorship.js';
import { createRfc64FinalizedVmAgentPrecommitV1 } from '../src/rfc64/finalized-vm-agent-precommit-v1.js';
import {
  computeRfc64AppliedInventoryDigestV1,
  verifyRfc64PublicCatalogInventoryCompletenessV1,
} from '../src/rfc64/public-catalog-inventory-completeness-v1.js';
import {
  RFC64_PUBLIC_CATALOG_EXACT_SET_BUNDLE_BYTES_MAX_V1,
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

function appliedHeadLifecycleV1(
  transaction: Rfc64PublicCatalogNativePrecommitTransactionV1 | null = null,
  afterAppliedHead: ((
    committedHead: Readonly<Rfc64PublicCatalogNativeCommittedHeadTokenV1>,
  ) => void | Promise<void>) | null = null,
): Rfc64PublicCatalogNativeAppliedHeadLifecycleV1 {
  return Object.freeze({
    kind: 'rfc64-public-catalog-native-applied-head-lifecycle-v1',
    transaction,
    afterAppliedHead,
  });
}

const AUTHOR_WALLET = new ethers.Wallet(`0x${'66'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/native-gate-1' as ContextGraphIdV1;
const KAV10 = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const GOVERNANCE_CONTRACT =
  '0x5555555555555555555555555555555555555555' as EvmAddressV1;
const POLICY_DIGEST = `0x${'75'.repeat(32)}` as Digest32V1;
const MISSING_DELEGATION_DIGEST = `0x${'76'.repeat(32)}` as Digest32V1;
const KA_NUMBER = 7n;
const KA_ID = ((BigInt(AUTHOR) << 96n) | KA_NUMBER).toString();
const UAL = `did:dkg:${NETWORK_ID}/${AUTHOR}/${KA_NUMBER}`;
const SECOND_KA_NUMBER = 8n;
const SECOND_KA_ID = ((BigInt(AUTHOR) << 96n) | SECOND_KA_NUMBER).toString();
const SECOND_UAL = `did:dkg:${NETWORK_ID}/${AUTHOR}/${SECOND_KA_NUMBER}`;
const THIRD_KA_NUMBER = 9n;
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
const TRANSACTION_TEST_VM_GRAPH = 'urn:rfc64:test:private-vm-generation';
const TRANSACTION_TEST_VM_SUBJECT = 'urn:rfc64:test:private-vm-asset';
const TRANSACTION_TEST_VM_PREDICATE = 'urn:rfc64:test:private-vm-head';

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
  it('keeps the pre-cache receiver dependency shape source-compatible', () => {
    expect(() => new Rfc64PublicCatalogNativeReceiverV1({
      headTransport: { fetchCatalogHead: async () => null },
      contentTransport: {
        fetchCatalogObject: async () => null,
        fetchKaBundle: async () => null,
      },
      controlObjects: {
        stageVerifiedObjects: async () => ({ durable: true, objects: [] }),
        getVerifiedObjectByDigest: async () => null,
      },
      inventory: {
        readAppliedCatalogHeadV1: () => null,
        compareAndSwapAppliedCatalogHeadV1: async () => 'applied',
      },
      kaBundles: { putKaBundle: async () => undefined },
      store: new OxigraphStore(),
    } as never)).not.toThrow();
  });

  it('refuses cold bootstrap when an omitted author projection and seal lack durable history', async () => {
    const fixture = await setupLiveReceiver();
    const decoded = decodeOpaqueKaBundleV1(fixture.secondRowBundle.bundleBytes);
    const seal = parseCanonicalGraphScopedAuthorSealV1(decoded.sealBytes);
    const placement = deriveCanonicalGraphScopedAuthorSealPlacementV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      assertionCoordinate: fixture.secondRowBundle.row.assertionCoordinate,
    });
    const staleGraph = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`
      + `/_shared_memory/${AUTHOR}/${SECOND_KA_NUMBER}`;
    await fixture.receiverStore.insert([
      {
        subject: 'https://example.org/stale',
        predicate: 'https://schema.org/name',
        object: '"omitted"',
        graph: staleGraph,
      },
      ...projectCanonicalGraphScopedAuthorSealRowsV1(seal, {
        contextGraphId: CONTEXT_GRAPH_ID,
        subGraphName: null,
        authorAddress: AUTHOR,
        assertionCoordinate: fixture.secondRowBundle.row.assertionCoordinate,
      }),
    ]);

    await expect(fixture.synchronize()).rejects.toMatchObject({
      code: 'catalog-native-receiver-history',
      message: expect.stringContaining('omitted by the fetched exact head'),
    });
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toBeNull();
    await expect(fixture.receiverStore.hasGraph(staleGraph)).resolves.toBe(true);
    const sealRead = await fixture.receiverStore.query(
      `SELECT ?p ?o WHERE { GRAPH <${placement.metaGraph}> { `
        + `<${placement.subject}> ?p ?o } } LIMIT 1`,
    );
    expect(sealRead).toMatchObject({ type: 'bindings' });
    if (sealRead.type !== 'bindings') throw new Error('stale seal query was not bindings');
    expect(sealRead.bindings).toHaveLength(1);
  }, 30_000);

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
          kaId: fixture.rowBundle.row.kaId,
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
      fixture.genesis.head.objectDigest,
      fixture.catalogIssuerDelegation.objectDigest,
      fixture.genesis.head.payload.directoryRootDigest,
      fixture.catalogIssuerDelegation.objectDigest,
      fixture.genesis.head.payload.directoryRootDigest,
      fixture.successor.head.objectDigest,
      fixture.catalogIssuerDelegation.objectDigest,
      fixture.successor.head.payload.directoryRootDigest,
      fixture.genesis.head.objectDigest,
      fixture.successor.bucket?.objectDigest,
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

  it('cold-bootstraps a zero-row successor on a fresh receiver', async () => {
    const fixture = await setupLiveReceiver();

    await expect(fixture.synchronizeAny(fixture.emptySuccessorAnnouncement)).resolves.toMatchObject({
      catalogHeadDigest: fixture.emptySuccessor.head.objectDigest,
      inventoryRowCount: 0,
      activatedTripleCount: 0,
      appliedHeadStatus: 'applied',
    });
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toMatchObject({
      currentCatalogHeadDigest: fixture.emptySuccessor.head.objectDigest,
      catalogVersion: '2',
      inventoryRowCount: '0',
    });
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
  }, 30_000);

  it('rejects malformed zero-row successor descriptors before bundle fetch or head CAS', async () => {
    const fixture = await setupLiveReceiver();
    const fetchKaBundle = vi.fn(async () => null);
    const observed = fixture.createCasObservedReceiver({
      fetchCatalogObject: async (_remotePeerId, request) => {
        const envelope = fixture.authorObjects.get(request.targetObjectDigest);
        if (envelope === undefined) return null;
        return Object.freeze({
          envelope,
          issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
        });
      },
      fetchKaBundle,
    });

    for (const malformed of fixture.malformedEmptySuccessorAnnouncements) {
      await expect(fixture.synchronizeAny(malformed, observed.receiver)).rejects.toMatchObject({
        code: 'catalog-native-receiver-catalog',
      });
    }

    expect(fetchKaBundle).not.toHaveBeenCalled();
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toBeNull();
  }, 30_000);

  it('activates every row in one exact bounded multi-asset inventory before one head CAS', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await fixture.synchronize();
    const observed = fixture.createCasObservedReceiver();

    const evidence = await fixture.synchronizeAny(
      fixture.multiAssetAnnouncement,
      observed.receiver,
    );
    if (!('rows' in evidence)) throw new Error('two-row successor returned non-multi evidence');
    const expectedRows = [fixture.rowBundle, fixture.secondRowBundle].map((bundle) => ({
      kaId: bundle.row.kaId,
      catalogRowDigest: computeAuthorCatalogRowDigestV1(
        fixture.scopeDigest,
        bundle.row,
      ),
      contentDigest: bundle.row.projectionDigest,
      sealDigest: bundle.row.sealDigest,
      bundleDigest: bundle.row.transfer.blobDigest,
      kaUal: bundle.kaUal,
      activatedTripleCount: 2,
    }));
    const expected = verifyRfc64PublicCatalogInventoryCompletenessV1({
      catalogScope: fixture.scope,
      expectedTotalRows: '2' as never,
      expectedRows,
      observedRows: expectedRows,
    });
    const independentlyRecomputedDigest = computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest: fixture.scopeDigest,
      rows: [...evidence.rows].reverse(),
    });

    expect(evidence).toMatchObject({
      inventoryDigest: independentlyRecomputedDigest,
      catalogHeadDigest: fixture.multiAssetSuccessor.head.objectDigest,
      inventoryRowCount: 2,
      activatedTripleCount: 4,
      appliedHeadStatus: 'applied',
    });
    expect(independentlyRecomputedDigest).toBe(expected.inventoryDigest);
    expect(evidence.rows.map((row) => ({
      kaId: row.kaId,
      kaUal: row.kaUal,
      bundleDigest: row.bundleDigest,
      activatedTripleCount: row.activatedTripleCount,
    }))).toEqual(expectedRows.map((row) => ({
      kaId: row.kaId,
      kaUal: row.kaUal,
      bundleDigest: row.bundleDigest,
      activatedTripleCount: row.activatedTripleCount,
    })));
    expect(evidence.rows.map((row) => row.swmGraph)).toEqual([
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${KA_NUMBER}`,
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${SECOND_KA_NUMBER}`,
    ]);
    expect(evidence.rows.every((row) => Object.isFrozen(row.authorship))).toBe(true);
    expect(observed.compareAndSwapAppliedCatalogHeadV1).toHaveBeenCalledOnce();
    expect(observed.compareAndSwapAppliedCatalogHeadV1).toHaveBeenCalledWith(
      expect.objectContaining({
        currentCatalogHeadDigest: fixture.multiAssetSuccessor.head.objectDigest,
        appliedInventoryDigest: expected.inventoryDigest,
        inventoryRowCount: '2',
      }),
    );
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toMatchObject({
      currentCatalogHeadDigest: fixture.multiAssetSuccessor.head.objectDigest,
      appliedInventoryDigest: expected.inventoryDigest,
      inventoryRowCount: '2',
    });
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(32);
  }, 30_000);

  it('proves a bounded signed lineage and converges after announcements coalesce', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await fixture.synchronize();

    const evidence = await fixture.synchronizeAny(fixture.threeAssetAnnouncement);

    expect(evidence).toMatchObject({
      catalogHeadDigest: fixture.threeAssetSuccessor.head.objectDigest,
      inventoryRowCount: 3,
      activatedTripleCount: 6,
      appliedHeadStatus: 'applied',
    });
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toMatchObject({
      currentCatalogHeadDigest: fixture.threeAssetSuccessor.head.objectDigest,
      catalogVersion: '3',
      inventoryRowCount: '3',
    });
    await expect(fixture.receiverPersistence.controlObjects.getVerifiedObjectByDigest({
      objectDigest: fixture.multiAssetSuccessor.head.objectDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    })).resolves.toMatchObject({
      envelope: { objectDigest: fixture.multiAssetSuccessor.head.objectDigest },
    });
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(48);
  }, 30_000);

  it('rejects a signed coalesced branch that does not descend from the durable head', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await fixture.synchronize();

    await expect(fixture.synchronizeAny(fixture.alternateThirdAnnouncement))
      .rejects.toMatchObject({ code: 'catalog-native-receiver-history' });

    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toMatchObject({
      currentCatalogHeadDigest: fixture.successor.head.objectDigest,
      catalogVersion: '1',
      inventoryRowCount: '1',
    });
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(16);
  }, 30_000);

  it('replays a cold-bootstrapped current exact head without staging its predecessor', async () => {
    const fixture = await setupLiveReceiver();

    await expect(fixture.synchronizeAny(
      fixture.multiAssetAnnouncement,
    )).resolves.toMatchObject({
      catalogHeadDigest: fixture.multiAssetSuccessor.head.objectDigest,
      inventoryRowCount: 2,
      appliedHeadStatus: 'applied',
    });
    await expect(fixture.receiverPersistence.controlObjects.getVerifiedObjectByDigest({
      objectDigest: fixture.multiAssetSuccessor.head.payload.previousHeadDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    })).resolves.toBeNull();

    await expect(fixture.synchronizeAny(
      fixture.multiAssetAnnouncement,
    )).resolves.toMatchObject({
      catalogHeadDigest: fixture.multiAssetSuccessor.head.objectDigest,
      inventoryRowCount: 2,
      appliedHeadStatus: 'existing',
    });
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toMatchObject({
      currentCatalogHeadDigest: fixture.multiAssetSuccessor.head.objectDigest,
      inventoryRowCount: '2',
    });
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(32);
  }, 30_000);

  it('checkpoints verified bundles and resumes the exact head after receiver restart', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await fixture.synchronize();
    const interruptedReceiver = fixture.createReceiver(
      fixture.receiverPersistence.inventory,
      fixture.receiverPersistence.controlObjects,
      undefined,
      fixture.receiverStore,
      () => {
        throw new Error('simulated process loss after exact transfer');
      },
    );

    await expect(fixture.synchronizeAny(
      fixture.multiAssetAnnouncement,
      interruptedReceiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-activation' });
    await expect(fixture.receiverPersistence.kaBundles.readKaBundleByDigest(
      fixture.secondRowBundle.row.transfer.blobDigest,
    )).resolves.not.toBeNull();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.successor.head.objectDigest);
    expect(interruptedReceiver.resourceStats()).toMatchObject({
      kaBundleCacheHits: 1,
      kaBundleNetworkFetches: 1,
      kaBundleCacheBytes: fixture.rowBundle.bundleBytes.byteLength,
      kaBundleNetworkBytes: fixture.secondRowBundle.bundleBytes.byteLength,
    });

    await fixture.receiverPersistence.close();
    const reopened = await openRfc64PersistenceV1(
      fixture.receiverDirectory,
      { yieldAfterPurgeBatch: async () => {} },
    );
    persistences.push(reopened);
    fixture.receiverBundleFetch.mockClear();
    const exactControlRead = vi.fn(
      reopened.controlObjects.getVerifiedObject.bind(
        reopened.controlObjects,
      ),
    );
    const restartedReceiver = fixture.createReceiver(
      reopened.inventory,
      {
        stageVerifiedObjects: reopened.controlObjects.stageVerifiedObjects,
        getVerifiedObjectByDigest: reopened.controlObjects.getVerifiedObjectByDigest,
        getVerifiedObject: exactControlRead,
      },
      undefined,
      undefined,
      undefined,
      reopened.kaBundles,
    );
    await expect(fixture.synchronizeAny(
      fixture.multiAssetAnnouncement,
      restartedReceiver,
    )).resolves.toMatchObject({
      appliedHeadStatus: 'applied',
      inventoryRowCount: 2,
    });
    expect(fixture.receiverBundleFetch).not.toHaveBeenCalled();
    expect(exactControlRead).toHaveBeenCalledWith(expect.objectContaining({
      objectDigest: fixture.multiAssetAnnouncement.catalogHeadObjectDigest,
      signatureVariantDigest: fixture.multiAssetAnnouncement.signatureVariantDigest,
    }));
    expect(restartedReceiver.resourceStats()).toMatchObject({
      controlObjectCacheHits: 4,
      controlObjectNetworkFetches: 0,
      kaBundleCacheHits: 2,
      kaBundleNetworkFetches: 0,
      kaBundleCacheBytes:
        fixture.rowBundle.bundleBytes.byteLength
        + fixture.secondRowBundle.bundleBytes.byteLength,
      kaBundleNetworkBytes: 0,
    });
  }, 30_000);

  it('uses the configured verifier for cached heads after restart', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await fixture.synchronize();
    const configuredVerifier = vi.fn(async () => {
      throw new Error('configured verifier rejected cached object');
    });
    fixture.receiverHeadFetch.mockClear();
    const receiver = fixture.createReceiver(
      fixture.receiverPersistence.inventory,
      fixture.receiverPersistence.controlObjects,
      undefined,
      fixture.receiverStore,
      undefined,
      fixture.receiverPersistence.kaBundles,
      configuredVerifier,
    );

    await expect(fixture.synchronizeAny(fixture.multiAssetAnnouncement, receiver))
      .rejects.toThrow(/catalog issuer delegation fetch or generic signature verification failed/u);
    expect(configuredVerifier).toHaveBeenCalled();
  }, 30_000);

  it('converges a valid two-to-one successor by removing the omitted SWM projection and seal before CAS', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await fixture.synchronize();
    await fixture.synchronizeAny(fixture.multiAssetAnnouncement);
    const observed = fixture.createCasObservedReceiver();

    const evidence = await fixture.synchronizeAny(
      fixture.removalAnnouncement,
      observed.receiver,
    );
    if (!('catalogRowDigest' in evidence)) throw new Error('one-row removal returned non-one-row evidence');
    const removedSwmGraph =
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${SECOND_KA_NUMBER}`;
    const removedSeal = deriveCanonicalGraphScopedAuthorSealPlacementV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      assertionCoordinate: 'gate-2-object' as never,
    });
    expect(evidence).toMatchObject({
      catalogHeadDigest: fixture.removalSuccessor.head.objectDigest,
      inventoryRowCount: 1,
      removedRowCount: 1,
      removedRows: [{
        kaId: SECOND_KA_ID,
        swmGraph: removedSwmGraph,
        sealMetaGraph: removedSeal.metaGraph,
        sealSubject: removedSeal.subject,
      }],
      kaUal: UAL,
      appliedHeadStatus: 'applied',
    });
    expect(Object.isFrozen(evidence.removedRows)).toBe(true);
    await expect(fixture.receiverStore.hasGraph(removedSwmGraph)).resolves.toBe(false);
    await expect(fixture.receiverStore.hasGraph(
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${KA_NUMBER}`,
    )).resolves.toBe(true);
    const removedSealRows = await fixture.receiverStore.query(
      `SELECT ?p ?o WHERE { GRAPH <${removedSeal.metaGraph}> { `
        + `<${removedSeal.subject}> ?p ?o } }`,
    );
    expect(removedSealRows).toEqual({ type: 'bindings', bindings: [] });
    expect(observed.compareAndSwapAppliedCatalogHeadV1).toHaveBeenCalledOnce();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toMatchObject({
      currentCatalogHeadDigest: fixture.removalSuccessor.head.objectDigest,
      inventoryRowCount: '1',
    });
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(16);
  }, 30_000);

  it('verifies a removal target completely before an omitted predecessor row can be mutated', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await fixture.synchronize();
    await fixture.synchronizeAny(fixture.multiAssetAnnouncement);
    const omittedSwmGraph =
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${SECOND_KA_NUMBER}`;
    const fetchKaBundle: Rfc64PublicCatalogNativeTransportV1['fetchKaBundle'] =
      async (...args) => {
        const bundle = await fixture.receiverBundleFetch(...args);
        if (bundle === null) return null;
        const forged = bundle.slice();
        forged[forged.length - 1] ^= 0x01;
        return forged;
      };
    const observed = fixture.createCasObservedReceiver({
      fetchCatalogObject: fixture.receiverObjectFetch,
      fetchKaBundle,
    });

    await expect(fixture.synchronizeAny(
      fixture.removalAnnouncement,
      observed.receiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-transfer' });
    expect(observed.stageVerifiedObjects).toHaveBeenCalled();
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    await expect(fixture.receiverStore.hasGraph(omittedSwmGraph)).resolves.toBe(true);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(32);
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.multiAssetSuccessor.head.objectDigest);
  }, 30_000);

  it('never removes projection or seal state owned by another catalog author scope', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await fixture.synchronize();
    await fixture.synchronizeAny(fixture.multiAssetAnnouncement);
    const foreignAuthor = '0x9999999999999999999999999999999999999999' as EvmAddressV1;
    const foreignGraph =
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${foreignAuthor}/${SECOND_KA_NUMBER}`;
    const foreignSeal = deriveCanonicalGraphScopedAuthorSealPlacementV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: foreignAuthor,
      assertionCoordinate: 'foreign-object' as never,
    });
    await fixture.receiverStore.insert([
      {
        subject: 'https://example.org/foreign',
        predicate: 'https://schema.org/name',
        object: '"Foreign"',
        graph: foreignGraph,
      },
      {
        subject: foreignSeal.subject,
        predicate: 'https://example.org/foreignSeal',
        object: '"owned elsewhere"',
        graph: foreignSeal.metaGraph,
      },
    ]);

    await fixture.synchronizeAny(fixture.removalAnnouncement);

    await expect(fixture.receiverStore.hasGraph(foreignGraph)).resolves.toBe(true);
    const foreignSealRows = await fixture.receiverStore.query(
      `SELECT ?p ?o WHERE { GRAPH <${foreignSeal.metaGraph}> { `
        + `<${foreignSeal.subject}> ?p ?o } }`,
    );
    expect(foreignSealRows).toMatchObject({
      type: 'bindings',
      bindings: [{
        p: 'https://example.org/foreignSeal',
        o: '"owned elsewhere"',
      }],
    });
  }, 30_000);

  it('withholds the head CAS after an indeterminate removal and converges on a new receiver instance', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await fixture.synchronize();
    await fixture.synchronizeAny(fixture.multiAssetAnnouncement);
    const omittedSwmGraph =
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${SECOND_KA_NUMBER}`;
    let injectAfterCommittedRemoval = true;
    const faultStore = new Proxy(fixture.receiverStore, {
      get(target, property) {
        if (property === 'replaceGraphAndSubject') {
          return async (...args: Parameters<NonNullable<TripleStore['replaceGraphAndSubject']>>) => {
            await target.replaceGraphAndSubject!(...args);
            if (args[1].length === 0 && injectAfterCommittedRemoval) {
              injectAfterCommittedRemoval = false;
              throw new Error('injected indeterminate post-commit removal failure');
            }
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    const failed = fixture.createCasObservedReceiver(undefined, faultStore);

    await expect(fixture.synchronizeAny(
      fixture.removalAnnouncement,
      failed.receiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-activation' });
    expect(failed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.multiAssetSuccessor.head.objectDigest);
    await expect(fixture.receiverStore.hasGraph(omittedSwmGraph)).resolves.toBe(true);

    const restartedReceiver = fixture.createReceiver(fixture.receiverPersistence.inventory);
    const repaired = await fixture.synchronizeAny(
      fixture.removalAnnouncement,
      restartedReceiver,
    );
    expect(repaired).toMatchObject({
      catalogHeadDigest: fixture.removalSuccessor.head.objectDigest,
      removedRowCount: 1,
      appliedHeadStatus: 'applied',
    });
    await expect(fixture.receiverStore.hasGraph(omittedSwmGraph)).resolves.toBe(false);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(16);
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toMatchObject({
      currentCatalogHeadDigest: fixture.removalSuccessor.head.objectDigest,
      inventoryRowCount: '1',
    });
  }, 30_000);

  it('rolls back an omitted row and earlier target activations when a later target post-read fails', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await fixture.synchronize();
    await fixture.synchronizeAny(fixture.multiAssetAnnouncement);
    await fixture.synchronizeAny(fixture.threeAssetAnnouncement);
    const firstGraph =
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${KA_NUMBER}`;
    const omittedGraph =
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${SECOND_KA_NUMBER}`;
    const laterGraph =
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${THIRD_KA_NUMBER}`;
    const firstSeal = deriveCanonicalGraphScopedAuthorSealPlacementV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      assertionCoordinate: 'gate-1-object' as never,
    });
    const omittedSeal = deriveCanonicalGraphScopedAuthorSealPlacementV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      assertionCoordinate: 'gate-2-object' as never,
    });
    const laterSeal = deriveCanonicalGraphScopedAuthorSealPlacementV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: AUTHOR,
      assertionCoordinate: 'gate-2-replacement-object' as never,
    });
    const foreignAuthor = '0x9999999999999999999999999999999999999999' as EvmAddressV1;
    const foreignGraph =
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${foreignAuthor}/77`;
    const foreignSeal = deriveCanonicalGraphScopedAuthorSealPlacementV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null,
      authorAddress: foreignAuthor,
      assertionCoordinate: 'transition-foreign-object' as never,
    });
    await fixture.receiverStore.insert([
      {
        subject: 'https://example.org/predecessor-only',
        predicate: 'https://schema.org/name',
        object: '"Exact predecessor sentinel"',
        graph: firstGraph,
      },
      {
        subject: 'https://example.org/transition-foreign',
        predicate: 'https://schema.org/name',
        object: '"Foreign transition sentinel"',
        graph: foreignGraph,
      },
      {
        subject: foreignSeal.subject,
        predicate: 'https://example.org/foreignTransitionSeal',
        object: '"owned elsewhere"',
        graph: foreignSeal.metaGraph,
      },
    ]);
    const predecessorFirst = await readExactSemanticPairForTest(
      fixture.receiverStore,
      firstGraph,
      firstSeal.metaGraph,
      firstSeal.subject,
    );
    const predecessorOmitted = await readExactSemanticPairForTest(
      fixture.receiverStore,
      omittedGraph,
      omittedSeal.metaGraph,
      omittedSeal.subject,
    );
    const predecessorLater = await readExactSemanticPairForTest(
      fixture.receiverStore,
      laterGraph,
      laterSeal.metaGraph,
      laterSeal.subject,
    );
    const foreignBefore = await readExactSemanticPairForTest(
      fixture.receiverStore,
      foreignGraph,
      foreignSeal.metaGraph,
      foreignSeal.subject,
    );
    expect(predecessorFirst.graph).toHaveLength(3);
    const activatedGraphs: string[] = [];
    let failLaterPostRead = true;
    const faultStore = new Proxy(fixture.receiverStore, {
      get(target, property) {
        if (property === 'replaceGraphAndSubject') {
          return async (...args: Parameters<NonNullable<TripleStore['replaceGraphAndSubject']>>) => {
            await target.replaceGraphAndSubject!(...args);
            if (args[1].length > 0) activatedGraphs.push(args[0]);
          };
        }
        if (property === 'query') {
          return async (...args: Parameters<TripleStore['query']>) => {
            if (
              failLaterPostRead
              && args[1]?.source === 'rfc64-public-catalog-native-post-read'
              && args[0].includes(`<${laterGraph}>`)
            ) {
              failLaterPostRead = false;
              throw new Error('injected later-row exact post-read failure');
            }
            return target.query(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    const failed = fixture.createCasObservedReceiver(undefined, faultStore);

    await expect(fixture.synchronizeAny(
      fixture.replacementAnnouncement,
      failed.receiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-activation' });

    expect(activatedGraphs.slice(0, 2)).toEqual([firstGraph, laterGraph]);
    expect(failed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.threeAssetSuccessor.head.objectDigest);
    await expect(readExactSemanticPairForTest(
      fixture.receiverStore,
      firstGraph,
      firstSeal.metaGraph,
      firstSeal.subject,
    )).resolves.toEqual(predecessorFirst);
    await expect(readExactSemanticPairForTest(
      fixture.receiverStore,
      omittedGraph,
      omittedSeal.metaGraph,
      omittedSeal.subject,
    )).resolves.toEqual(predecessorOmitted);
    await expect(readExactSemanticPairForTest(
      fixture.receiverStore,
      laterGraph,
      laterSeal.metaGraph,
      laterSeal.subject,
    )).resolves.toEqual(predecessorLater);
    await expect(readExactSemanticPairForTest(
      fixture.receiverStore,
      foreignGraph,
      foreignSeal.metaGraph,
      foreignSeal.subject,
    )).resolves.toEqual(foreignBefore);

    const retried = await fixture.synchronizeAny(fixture.replacementAnnouncement);
    expect(retried).toMatchObject({
      catalogHeadDigest: fixture.replacementSuccessor.head.objectDigest,
      inventoryRowCount: 2,
      removedRowCount: 1,
      appliedHeadStatus: 'applied',
    });
    await expect(fixture.receiverStore.hasGraph(firstGraph)).resolves.toBe(true);
    await expect(fixture.receiverStore.hasGraph(omittedGraph)).resolves.toBe(false);
    await expect(fixture.receiverStore.hasGraph(laterGraph)).resolves.toBe(true);
    await expect(readExactSemanticPairForTest(
      fixture.receiverStore,
      firstGraph,
      firstSeal.metaGraph,
      firstSeal.subject,
    )).resolves.not.toEqual(predecessorFirst);
    await expect(readExactSemanticPairForTest(
      fixture.receiverStore,
      foreignGraph,
      foreignSeal.metaGraph,
      foreignSeal.subject,
    )).resolves.toEqual(foreignBefore);
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toMatchObject({
      currentCatalogHeadDigest: fixture.replacementSuccessor.head.objectDigest,
      inventoryRowCount: '2',
    });
  }, 30_000);

  it('verifies all multi-asset bundles before staging, SWM mutation, or applied-head CAS', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await fixture.synchronize();
    fixture.receiverBundleFetch.mockClear();
    const fetchKaBundle: Rfc64PublicCatalogNativeTransportV1['fetchKaBundle'] =
      async (...args) => {
        const bundle = await fixture.receiverBundleFetch(...args);
        if (
          bundle === null
          || args[1].blobDigest !== fixture.secondRowBundle.row.transfer.blobDigest
        ) {
          return bundle;
        }
        const tampered = bundle.slice();
        tampered[tampered.length - 1] ^= 0x01;
        return tampered;
      };
    const observed = fixture.createCasObservedReceiver({
      fetchCatalogObject: fixture.receiverObjectFetch,
      fetchKaBundle,
    });

    await expect(fixture.synchronizeAny(
      fixture.multiAssetAnnouncement,
      observed.receiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-transfer' });
    expect(fixture.receiverBundleFetch).toHaveBeenCalledTimes(2);
    expect(observed.stageVerifiedObjects).toHaveBeenCalled();
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.successor.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(16);
  }, 30_000);

  it('rejects an over-budget signed exact set before fetching its first bundle', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await fixture.synchronize();
    const declaredBundleByteLength =
      BigInt(RFC64_PUBLIC_CATALOG_EXACT_SET_BUNDLE_BYTES_MAX_V1);
    const built = await buildRowBundle(AUTHOR_WALLET, {
      kaNumber: 100n,
      assertionCoordinate: 'budget-row',
    });
    const row = {
      ...built.row,
      transfer: {
        ...built.row.transfer,
        byteLength: declaredBundleByteLength.toString(),
        chunkCount: (
          ((declaredBundleByteLength - 1n) / 262_144n) + 1n
        ).toString(),
      },
    } as AuthorCatalogRowV1;
    assertAuthorCatalogRowV1(row);
    const successor = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: fixture.successor.head,
      previousDirectoryPath: fixture.successor.directoryPath,
      previousBucket: fixture.successor.bucket,
      selectedBucketId: '0' as never,
      nextRows: [fixture.rowBundle.row, row],
      issuedAt: '1773900001003' as never,
      signer: {
        issuer: AUTHOR,
        signDigest: async (digest) => AUTHOR_WALLET.signMessage(digest),
      },
    });
    for (const envelope of successor.stagedObjects) {
      fixture.authorObjects.set(envelope.objectDigest, envelope);
    }
    const headSignature = await verifyControlEnvelopeIssuerSignatureV1(successor.head);
    fixture.receiverHeadFetch.mockImplementationOnce(async () => Object.freeze({
      envelope: successor.head,
      issuerSignature: headSignature,
    }));
    const announcement = Object.freeze({
      ...fixture.announcement,
      catalogVersion: successor.head.payload.version,
      catalogHeadObjectDigest: successor.head.objectDigest,
      signatureVariantDigest: rfc64CatalogSignatureVariantDigestV1(successor.head),
    }) satisfies Rfc64PublicCatalogHeadAnnouncementV1;
    fixture.receiverBundleFetch.mockClear();
    const observed = fixture.createCasObservedReceiver();

    await expect(fixture.synchronizeAny(
      announcement,
      observed.receiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-not-found' });
    expect(fixture.receiverBundleFetch).not.toHaveBeenCalled();
    expect(observed.stageVerifiedObjects).toHaveBeenCalled();
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.successor.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(16);
  }, 30_000);

  it('keeps the one-row compatibility entrypoint fail-closed for a multi-row head', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await fixture.synchronize();
    fixture.receiverObjectFetch.mockClear();
    fixture.receiverBundleFetch.mockClear();
    const observed = fixture.createCasObservedReceiver();

    await expect(fixture.synchronize(
      fixture.multiAssetAnnouncement,
      observed.receiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-slice' });
    expect(fixture.receiverObjectFetch).not.toHaveBeenCalled();
    expect(fixture.receiverBundleFetch).not.toHaveBeenCalled();
    expect(observed.stageVerifiedObjects).not.toHaveBeenCalled();
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.successor.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(16);
  }, 30_000);

  it('rejects a signed genesis whose directory is not exactly empty', async () => {
    const fixture = await setupLiveReceiver();

    await expect(fixture.bootstrap(fixture.invalidGenesisAnnouncement)).rejects.toMatchObject({
      code: 'catalog-native-receiver-not-found',
    });
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toBeNull();
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
  }, 30_000);

  it('withholds staging, semantic mutation, and head CAS when verified bundle retention fails', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    const putKaBundle = vi.fn(async () => {
      throw new Error('simulated durable bundle-store failure');
    });
    const observed = fixture.createCasObservedReceiver(
      undefined,
      fixture.receiverStore,
      {
        putKaBundle,
        readKaBundleByDigest: vi.fn(async () => null),
      },
    );

    await expect(fixture.synchronize(
      fixture.announcement,
      observed.receiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-catalog' });
    expect(putKaBundle).toHaveBeenCalledTimes(1);
    expect(observed.stageVerifiedObjects).toHaveBeenCalled();
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.genesis.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
  }, 30_000);

  it('rejects a governed-scope genesis under the trusted null-governance policy before any mutation', async () => {
    const fixture = await setupLiveReceiver();
    const observed = fixture.createCasObservedReceiver();

    await expect(fixture.bootstrap(
      fixture.governedGenesisAnnouncement,
      observed.receiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-authorization' });

    expect(fixture.receiverObjectFetch).not.toHaveBeenCalled();
    expect(fixture.receiverBundleFetch).not.toHaveBeenCalled();
    expect(fixture.authorObjectRead).not.toHaveBeenCalled();
    expect(fixture.authorBundleRead).not.toHaveBeenCalled();
    expect(observed.stageVerifiedObjects).not.toHaveBeenCalled();
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toBeNull();
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
  }, 30_000);

  it('rejects a governed-scope successor before directory/bundle fetch, staging, CAS, or activation', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    fixture.receiverObjectFetch.mockClear();
    fixture.receiverBundleFetch.mockClear();
    fixture.authorObjectRead.mockClear();
    fixture.authorBundleRead.mockClear();
    const observed = fixture.createCasObservedReceiver();

    await expect(fixture.synchronize(
      fixture.governedSuccessorAnnouncement,
      observed.receiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-authorization' });

    expect(fixture.receiverObjectFetch).not.toHaveBeenCalled();
    expect(fixture.receiverBundleFetch).not.toHaveBeenCalled();
    expect(fixture.authorObjectRead).not.toHaveBeenCalled();
    expect(fixture.authorBundleRead).not.toHaveBeenCalled();
    expect(observed.stageVerifiedObjects).not.toHaveBeenCalled();
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.genesis.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
  }, 30_000);

  it('rejects a locally resolved deployment for another network before head fetch', async () => {
    const fixture = await setupLiveReceiver();
    await expect(fixture.receiver.bootstrapEmptyBoundedPublicRootCatalog(
      'peer-unused',
      fixture.genesisAnnouncement,
      fixture.scope,
      {
        ...DEPLOYMENT,
        networkId: 'otp:20431' as NetworkIdV1,
      },
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-authorization' });
    expect(fixture.receiverHeadFetch).not.toHaveBeenCalled();
    expect(fixture.receiverObjectFetch).not.toHaveBeenCalled();
    expect(fixture.receiverBundleFetch).not.toHaveBeenCalled();
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

    expect(fixture.receiverHeadFetch).toHaveBeenCalledTimes(2);
    expect(fixture.receiverObjectFetch).toHaveBeenCalledTimes(4);
    expect(fixture.receiverBundleFetch).toHaveBeenCalledTimes(1);
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

  it('rejects a genesis head with no delegation without staging it durably', async () => {
    const fixture = await setupLiveReceiver();
    const observed = fixture.createCasObservedReceiver();

    await expect(fixture.bootstrap(
      fixture.missingDelegationGenesisAnnouncement,
      observed.receiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-not-found' });

    expect(observed.stageVerifiedObjects).not.toHaveBeenCalled();
    await expect(fixture.receiverPersistence.controlObjects.getVerifiedObject({
      objectDigest: fixture.missingDelegationGenesisAnnouncement.catalogHeadObjectDigest,
      signatureVariantDigest:
        fixture.missingDelegationGenesisAnnouncement.signatureVariantDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    })).resolves.toBeNull();
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toBeNull();
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
  }, 30_000);

  it('retries genesis idempotently after verified staging wins but its CAS crashes', async () => {
    const fixture = await setupLiveReceiver();
    const rollback = vi.fn(async () => {});
    const commit = vi.fn();
    const crashGapReceiver = fixture.createReceiver({
      readAppliedCatalogHeadV1:
        fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1.bind(
          fixture.receiverPersistence.inventory,
        ),
      compareAndSwapAppliedCatalogHeadV1: () => {
        throw new Error('simulated crash after genesis staging and before applied-head CAS');
      },
    }, undefined, undefined, fixture.receiverStore, async () => (
      appliedHeadLifecycleV1({ commit, rollback })
    ));

    await expect(fixture.bootstrap(
      fixture.genesisAnnouncement,
      crashGapReceiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-history' });
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )).toBeNull();
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();

    const successfulCommit = vi.fn();
    const successfulRollback = vi.fn(async () => {});
    const successfulReceiver = fixture.createReceiver(
      fixture.receiverPersistence.inventory,
      undefined,
      undefined,
      fixture.receiverStore,
      async () => appliedHeadLifecycleV1({
        commit: successfulCommit,
        rollback: successfulRollback,
      }),
    );
    await expect(fixture.bootstrap(
      fixture.genesisAnnouncement,
      successfulReceiver,
    )).resolves.toMatchObject({
      appliedHeadStatus: 'applied',
      inventoryRowCount: 0,
    });
    expect(successfulCommit).toHaveBeenCalledOnce();
    expect(successfulRollback).not.toHaveBeenCalled();
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
      undefined,
      undefined,
      undefined,
      reopened.kaBundles,
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
    const observed = fixture.createCasObservedReceiver(
      undefined,
      fixture.receiverStore,
      undefined,
      vi.fn(async () => null),
    );

    await expect(fixture.synchronize(fixture.announcement, observed.receiver)).rejects.toMatchObject({
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

  it('rejects a delegation proof for another exact signature variant before bundle fetch or mutation', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    const staleProof = await verifyControlEnvelopeIssuerSignatureV1(
      fixture.catalogIssuerDelegation,
    );
    const alternateDelegation = Object.freeze({
      ...fixture.catalogIssuerDelegation,
      signature: alternateRecoveryEncoding(fixture.catalogIssuerDelegation.signature),
    }) as SignedAuthorCatalogIssuerDelegationEnvelopeV1;
    expect(ethers.verifyMessage(
      ethers.getBytes(alternateDelegation.objectDigest),
      alternateDelegation.signature,
    ).toLowerCase()).toBe(AUTHOR);
    const fetchCatalogObject: Rfc64PublicCatalogNativeTransportV1['fetchCatalogObject'] =
      async (peerId, request, sendOptions) => {
        if (request.targetObjectDigest === fixture.catalogIssuerDelegation.objectDigest) {
          return Object.freeze({
            envelope: alternateDelegation,
            issuerSignature: staleProof,
          });
        }
        return fixture.receiverObjectFetch(peerId, request, sendOptions);
      };
    fixture.receiverBundleFetch.mockClear();
    const observed = fixture.createCasObservedReceiver({
      fetchCatalogObject,
      fetchKaBundle: fixture.receiverBundleFetch,
    }, fixture.receiverStore, undefined, vi.fn(async () => null));

    await expect(fixture.synchronize(
      fixture.announcement,
      observed.receiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-authorization' });
    expect(fixture.receiverBundleFetch).not.toHaveBeenCalled();
    expect(observed.stageVerifiedObjects).not.toHaveBeenCalled();
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.genesis.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
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

  it('rejects an expired catalog-issuer delegation before activation or applied-head CAS', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    fixture.authorBundleRead.mockClear();
    const observed = fixture.createCasObservedReceiver();

    await expect(fixture.synchronize(
      fixture.expiredAnnouncement,
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

  it('rejects a missing catalog-issuer delegation before activation or applied-head CAS', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    fixture.authorBundleRead.mockClear();
    const observed = fixture.createCasObservedReceiver();

    for (let attempt = 0; attempt < 16; attempt += 1) {
      await expect(fixture.synchronize(
        fixture.missingDelegationAnnouncement,
        observed.receiver,
      )).rejects.toMatchObject({
        code: 'catalog-native-receiver-not-found',
      });
    }
    expect(observed.stageVerifiedObjects).not.toHaveBeenCalled();
    await expect(fixture.receiverPersistence.controlObjects.getVerifiedObject({
      objectDigest: fixture.missingDelegationAnnouncement.catalogHeadObjectDigest,
      signatureVariantDigest: fixture.missingDelegationAnnouncement.signatureVariantDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    })).resolves.toBeNull();
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.genesis.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
    expect(fixture.authorBundleRead).not.toHaveBeenCalled();
  }, 30_000);

  it('reports a signed catalog row whose KA bundle is unavailable as incomplete', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    const observed = fixture.createCasObservedReceiver({
      fetchCatalogObject: fixture.receiverObjectFetch,
      fetchKaBundle: async () => null,
    });

    await expect(fixture.synchronize(
      fixture.announcement,
      observed.receiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-incomplete' });
    // The signed catalog control objects can be retained safely before the receiver
    // discovers that the row's content-addressed bundle bytes are unavailable.
    expect(observed.compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.genesis.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
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

  it('rolls back a semantic-before-CAS failure and accepts an idempotent retry', async () => {
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
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);

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

  it('normalizes legacy void and transaction precommits alongside the lifecycle result', async () => {
    for (const resultShape of ['void', 'transaction', 'lifecycle'] as const) {
      const fixture = await setupLiveReceiver();
      await fixture.bootstrap();
      const commit = vi.fn();
      const rollback = vi.fn();
      const afterAppliedHead = vi.fn();
      const beforeAppliedHeadCommit: Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1 =
        async () => {
          if (resultShape === 'void') return;
          const transaction: Rfc64PublicCatalogNativePrecommitTransactionV1 = {
            commit,
            rollback: async (cause) => { rollback(cause); },
          };
          return resultShape === 'transaction'
            ? transaction
            : appliedHeadLifecycleV1(transaction, afterAppliedHead);
        };
      const receiver = fixture.createReceiver(
        fixture.receiverPersistence.inventory,
        undefined,
        undefined,
        fixture.receiverStore,
        beforeAppliedHeadCommit,
      );

      await expect(fixture.synchronize(fixture.announcement, receiver)).resolves.toMatchObject({
        appliedHeadStatus: 'applied',
      });
      expect(commit).toHaveBeenCalledTimes(resultShape === 'void' ? 0 : 1);
      expect(rollback).not.toHaveBeenCalled();
      expect(afterAppliedHead).toHaveBeenCalledTimes(resultShape === 'lifecycle' ? 1 : 0);
    }
  }, 60_000);

  it('restores SWM and VM together when the applied-head CAS rejects the target', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await setTransactionTestVmGeneration(fixture.receiverStore, 'predecessor');
    const commit = vi.fn();
    const rollback = vi.fn();
    const afterAppliedHead = vi.fn();
    const receiver = fixture.createReceiver({
      readAppliedCatalogHeadV1:
        fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1.bind(
          fixture.receiverPersistence.inventory,
        ),
      compareAndSwapAppliedCatalogHeadV1: () => {
        throw new Error('injected CAS rejection before durable commit');
      },
    }, undefined, undefined, fixture.receiverStore, async () => {
      await setTransactionTestVmGeneration(fixture.receiverStore, 'target');
      return appliedHeadLifecycleV1(
        {
          commit,
          rollback: async (cause) => {
            rollback(cause);
            await setTransactionTestVmGeneration(fixture.receiverStore, 'predecessor');
          },
        },
        afterAppliedHead,
      );
    });

    await expect(fixture.synchronize(fixture.announcement, receiver)).rejects.toMatchObject({
      code: 'catalog-native-receiver-history',
    });

    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.genesis.head.objectDigest);
    await expect(fixture.receiverStore.hasGraph(
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${KA_NUMBER}`,
    )).resolves.toBe(false);
    await expect(readTransactionTestVmGeneration(fixture.receiverStore))
      .resolves.toBe('predecessor');
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(afterAppliedHead).not.toHaveBeenCalled();
  }, 30_000);

  it('keeps target SWM and VM when the committed head post-read fails', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await setTransactionTestVmGeneration(fixture.receiverStore, 'predecessor');
    const readAppliedCatalogHeadV1 = vi.fn(
      fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1.bind(
        fixture.receiverPersistence.inventory,
      ),
    );
    readAppliedCatalogHeadV1.mockImplementationOnce(
      fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1.bind(
        fixture.receiverPersistence.inventory,
      ),
    ).mockImplementationOnce(() => {
      throw new Error('injected durable post-CAS read failure');
    });
    const commit = vi.fn();
    const rollback = vi.fn();
    const afterAppliedHead = vi.fn();
    const receiver = fixture.createReceiver({
      readAppliedCatalogHeadV1,
      compareAndSwapAppliedCatalogHeadV1:
        fixture.receiverPersistence.inventory.compareAndSwapAppliedCatalogHeadV1.bind(
          fixture.receiverPersistence.inventory,
        ),
    }, undefined, undefined, fixture.receiverStore, async () => {
      await setTransactionTestVmGeneration(fixture.receiverStore, 'target');
      return appliedHeadLifecycleV1(
        {
          commit,
          rollback: async (cause) => {
            rollback(cause);
            await setTransactionTestVmGeneration(fixture.receiverStore, 'predecessor');
          },
        },
        afterAppliedHead,
      );
    });

    await expect(fixture.synchronize(fixture.announcement, receiver)).rejects.toThrow(
      'injected durable post-CAS read failure',
    );

    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.successor.head.objectDigest);
    await expect(fixture.receiverStore.hasGraph(
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${KA_NUMBER}`,
    )).resolves.toBe(true);
    await expect(readTransactionTestVmGeneration(fixture.receiverStore))
      .resolves.toBe('target');
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(afterAppliedHead).not.toHaveBeenCalled();
  }, 30_000);

  it('keeps target SWM and VM when the durable head CAS succeeds but precommit commit throws', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await setTransactionTestVmGeneration(fixture.receiverStore, 'predecessor');
    const commit = vi.fn(() => {
      throw new Error('injected precommit commit failure after durable head CAS');
    });
    const rollback = vi.fn();
    const afterAppliedHead = vi.fn();
    const receiver = fixture.createReceiver(
      fixture.receiverPersistence.inventory,
      undefined,
      undefined,
      fixture.receiverStore,
      async () => {
        await setTransactionTestVmGeneration(fixture.receiverStore, 'target');
        return appliedHeadLifecycleV1(
          {
            commit,
            rollback: async (cause) => {
              rollback(cause);
              await setTransactionTestVmGeneration(fixture.receiverStore, 'predecessor');
            },
          },
          afterAppliedHead,
        );
      },
    );

    await expect(fixture.synchronize(fixture.announcement, receiver)).rejects.toThrow(
      'injected precommit commit failure after durable head CAS',
    );

    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.successor.head.objectDigest);
    await expect(fixture.receiverStore.hasGraph(
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${KA_NUMBER}`,
    )).resolves.toBe(true);
    await expect(readTransactionTestVmGeneration(fixture.receiverStore))
      .resolves.toBe('target');
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(afterAppliedHead).not.toHaveBeenCalled();
  }, 30_000);

  it('finalizes the transaction before post-head cleanup and retries cleanup on exact replay', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    const events: string[] = [];
    const rollback = vi.fn();
    let cleanupAttempts = 0;
    let signalCommitStarted!: () => void;
    let releaseCommit!: () => void;
    const commitStarted = new Promise<void>((resolve) => { signalCommitStarted = resolve; });
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const receiver = fixture.createReceiver(
      fixture.receiverPersistence.inventory,
      undefined,
      undefined,
      fixture.receiverStore,
      async () => appliedHeadLifecycleV1(
        {
          commit: async () => {
            events.push('primary-commit-start');
            signalCommitStarted();
            await commitGate;
            events.push('primary-commit-finished');
          },
          rollback: async (cause) => { rollback(cause); },
        },
        async () => {
          cleanupAttempts += 1;
          events.push(`after-head-${cleanupAttempts}`);
          expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
            fixture.scopeDigest,
            AUTHOR,
          )?.currentCatalogHeadDigest).toBe(fixture.successor.head.objectDigest);
          if (cleanupAttempts === 1) throw new Error('injected post-head cleanup failure');
        },
      ),
    );

    const firstSynchronization = fixture.synchronize(fixture.announcement, receiver);
    let synchronizationSettled = false;
    void firstSynchronization.then(
      () => { synchronizationSettled = true; },
      () => { synchronizationSettled = true; },
    );

    await commitStarted;
    expect(synchronizationSettled).toBe(false);
    expect(cleanupAttempts).toBe(0);
    expect(events).toEqual(['primary-commit-start']);

    releaseCommit();
    await expect(firstSynchronization).rejects.toThrow(
      'injected post-head cleanup failure',
    );
    expect(events).toEqual([
      'primary-commit-start',
      'primary-commit-finished',
      'after-head-1',
    ]);
    expect(rollback).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.successor.head.objectDigest);

    await expect(fixture.synchronize(fixture.announcement, receiver)).resolves.toMatchObject({
      appliedHeadStatus: 'existing',
    });
    expect(events).toEqual([
      'primary-commit-start',
      'primary-commit-finished',
      'after-head-1',
      'primary-commit-start',
      'primary-commit-finished',
      'after-head-2',
    ]);
    expect(rollback).not.toHaveBeenCalled();
  }, 30_000);

  it('fences predecessor rollback when the head CAS and its reconciliation read both fail', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await setTransactionTestVmGeneration(fixture.receiverStore, 'predecessor');
    const durableRead =
      fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1.bind(
        fixture.receiverPersistence.inventory,
      );
    const readAppliedCatalogHeadV1 = vi.fn(durableRead);
    readAppliedCatalogHeadV1.mockImplementationOnce(durableRead).mockImplementationOnce(() => {
      throw new Error('injected applied-head reconciliation read failure');
    });
    const commit = vi.fn();
    const rollback = vi.fn();
    const receiver = fixture.createReceiver({
      readAppliedCatalogHeadV1,
      compareAndSwapAppliedCatalogHeadV1: () => {
        throw new Error('injected indeterminate applied-head CAS failure');
      },
    }, undefined, undefined, fixture.receiverStore, async () => {
      await setTransactionTestVmGeneration(fixture.receiverStore, 'target');
      return appliedHeadLifecycleV1({
        commit,
        rollback: async (cause) => {
          rollback(cause);
          await setTransactionTestVmGeneration(fixture.receiverStore, 'predecessor');
        },
      });
    });

    await expect(fixture.synchronize(fixture.announcement, receiver)).rejects.toMatchObject({
      code: 'catalog-native-receiver-history',
    });

    expect(durableRead(fixture.scopeDigest, AUTHOR)?.currentCatalogHeadDigest)
      .toBe(fixture.genesis.head.objectDigest);
    await expect(fixture.receiverStore.hasGraph(
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${KA_NUMBER}`,
    )).resolves.toBe(true);
    await expect(readTransactionTestVmGeneration(fixture.receiverStore))
      .resolves.toBe('target');
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  }, 30_000);

  it('reconciles a write-then-throw head CAS and keeps target SWM and VM aligned', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await setTransactionTestVmGeneration(fixture.receiverStore, 'predecessor');
    const durableCas =
      fixture.receiverPersistence.inventory.compareAndSwapAppliedCatalogHeadV1.bind(
        fixture.receiverPersistence.inventory,
      );
    const compareAndSwapAppliedCatalogHeadV1 = vi.fn((...args: Parameters<typeof durableCas>) => {
      durableCas(...args);
      throw new Error('injected failure after durable applied-head CAS');
    });
    const commit = vi.fn();
    const rollback = vi.fn();
    const receiver = fixture.createReceiver({
      readAppliedCatalogHeadV1:
        fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1.bind(
          fixture.receiverPersistence.inventory,
        ),
      compareAndSwapAppliedCatalogHeadV1,
    }, undefined, undefined, fixture.receiverStore, async () => {
      await setTransactionTestVmGeneration(fixture.receiverStore, 'target');
      return appliedHeadLifecycleV1({
        commit,
        rollback: async (cause) => {
          rollback(cause);
          await setTransactionTestVmGeneration(fixture.receiverStore, 'predecessor');
        },
      });
    });

    const result = await fixture.synchronize(fixture.announcement, receiver);

    expect(result.appliedHeadStatus).toBe('existing');
    expect(compareAndSwapAppliedCatalogHeadV1).toHaveBeenCalledOnce();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.successor.head.objectDigest);
    await expect(fixture.receiverStore.hasGraph(
      `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${KA_NUMBER}`,
    )).resolves.toBe(true);
    await expect(readTransactionTestVmGeneration(fixture.receiverStore))
      .resolves.toBe('target');
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  }, 30_000);

  it('retries a partially materialized two-row precommit before committing the head', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await fixture.synchronize();
    const compareAndSwapAppliedCatalogHeadV1 = vi.fn(
      fixture.receiverPersistence.inventory.compareAndSwapAppliedCatalogHeadV1.bind(
        fixture.receiverPersistence.inventory,
      ),
    );
    const materializedKaIds = new Set<string>();
    const materializationAttempts: string[] = [];
    let failSecondRow = true;
    const partialPrecommit = vi.fn<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1>(
      async (plan) => {
        for (const row of plan.rows) {
          const kaId = readVerifiedAuthorCatalogRowAuthorshipV1(row.authorship).row.kaId;
          if (materializedKaIds.has(kaId)) {
            materializationAttempts.push(`${kaId}:existing`);
            continue;
          }
          if (kaId === fixture.secondRowBundle.row.kaId && failSecondRow) {
            failSecondRow = false;
            materializationAttempts.push(`${kaId}:failed`);
            throw new Error('simulated second-row finalized VM materialization failure');
          }
          materializedKaIds.add(kaId);
          materializationAttempts.push(`${kaId}:materialized`);
        }
        return appliedHeadLifecycleV1();
      },
    );
    const rejectingReceiver = fixture.createReceiver({
      readAppliedCatalogHeadV1:
        fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1.bind(
          fixture.receiverPersistence.inventory,
        ),
      compareAndSwapAppliedCatalogHeadV1,
    }, undefined, undefined, fixture.receiverStore, partialPrecommit);

    await expect(fixture.synchronizeAny(
      fixture.multiAssetAnnouncement,
      rejectingReceiver,
    )).rejects.toMatchObject({
      code: 'catalog-native-receiver-activation',
      message: expect.stringContaining('catalog applied-head precommit rejected'),
    });
    expect(partialPrecommit).toHaveBeenCalledOnce();
    const [rejectedPlan, rejectedSignal] = partialPrecommit.mock.calls[0]!;
    expect(rejectedPlan).toMatchObject({
      catalogScope: fixture.scope,
      catalogHeadDigest: fixture.multiAssetSuccessor.head.objectDigest,
    });
    expect(rejectedPlan.rows.map((row) =>
      readVerifiedAuthorCatalogRowAuthorshipV1(row.authorship).row.kaId)).toEqual([
      fixture.rowBundle.row.kaId,
      fixture.secondRowBundle.row.kaId,
    ]);
    expect(rejectedPlan.rows.every((row) => !('placement' in row))).toBe(true);
    expect(Object.isFrozen(rejectedPlan)).toBe(true);
    expect(Object.isFrozen(rejectedPlan.rows)).toBe(true);
    expect(rejectedPlan.rows.every(Object.isFrozen)).toBe(true);
    expect(rejectedSignal).toBeInstanceOf(AbortSignal);
    expect(materializationAttempts).toEqual([
      `${fixture.rowBundle.row.kaId}:materialized`,
      `${fixture.secondRowBundle.row.kaId}:failed`,
    ]);
    expect(materializedKaIds).toEqual(new Set([fixture.rowBundle.row.kaId]));
    expect(compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.successor.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(16);

    const repaired = await fixture.synchronizeAny(
      fixture.multiAssetAnnouncement,
      fixture.createReceiver(
        fixture.receiverPersistence.inventory,
        undefined,
        undefined,
        fixture.receiverStore,
        partialPrecommit,
      ),
    );
    expect(partialPrecommit).toHaveBeenCalledTimes(2);
    expect(materializationAttempts).toEqual([
      `${fixture.rowBundle.row.kaId}:materialized`,
      `${fixture.secondRowBundle.row.kaId}:failed`,
      `${fixture.rowBundle.row.kaId}:existing`,
      `${fixture.secondRowBundle.row.kaId}:materialized`,
    ]);
    expect(materializedKaIds).toEqual(new Set([
      fixture.rowBundle.row.kaId,
      fixture.secondRowBundle.row.kaId,
    ]));
    expect(repaired.appliedHeadStatus).toBe('applied');
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      fixture.scopeDigest,
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.multiAssetSuccessor.head.objectDigest);
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(32);
  }, 30_000);

  it('keeps the governed genesis head unapplied when an explicit VM precommit lacks RPC', async () => {
    const fixture = await setupLiveReceiver();
    const compareAndSwapAppliedCatalogHeadV1 = vi.fn(
      fixture.receiverPersistence.inventory.compareAndSwapAppliedCatalogHeadV1.bind(
        fixture.receiverPersistence.inventory,
      ),
    );
    const getOnChainContextGraphId = vi.fn(async () => '14');
    const getEvmChainId = vi.fn(async () => 20_430n);
    const getKnowledgeAssetStorageAddress = vi.fn(async () => KAV10);
    const policy = Object.freeze({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: '20430',
      governanceContractAddress: GOVERNANCE_CONTRACT,
      ownershipTransitionDigest: fixture.governedScope.ownershipTransitionDigest,
      era: '0',
      version: '0',
      previousPolicyDigest: null,
      accessPolicy: 0,
      publishPolicy: 1,
      publishAuthority: null,
      publishAuthorityAccountId: '0',
      projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
      administrativeDelegationDigest: null,
      source: {
        kind: 'finalized-chain',
        chainId: '20430',
        contractAddress: GOVERNANCE_CONTRACT,
        blockNumber: '123',
        blockHash: `0x${'77'.repeat(32)}`,
      },
      effectiveAt: '1773900000000',
      issuedAt: '1773900000000',
    } satisfies ContextGraphPolicyV1);
    const precommit = createRfc64FinalizedVmAgentPrecommitV1({
      acceptedPolicySnapshotForCatalogScope: () => Object.freeze({
        policy,
        policyDigest: POLICY_DIGEST,
        roster: null,
      }),
      rpcEndpoints: [],
      getOnChainContextGraphId,
      getEvmChainId,
      getKnowledgeAssetStorageAddress,
      getKnowledgeAssetsLifecycleAddress: async () => KAV10,
      store: fixture.receiverStore,
    });
    const receiver = fixture.createReceiver({
      readAppliedCatalogHeadV1:
        fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1.bind(
          fixture.receiverPersistence.inventory,
        ),
      compareAndSwapAppliedCatalogHeadV1,
    }, undefined, undefined, fixture.receiverStore, precommit);

    await expect(fixture.bootstrapGoverned(receiver)).rejects.toMatchObject({
      code: 'catalog-native-receiver-activation',
      message: expect.stringContaining('catalog applied-head precommit rejected'),
    });

    expect(getOnChainContextGraphId).not.toHaveBeenCalled();
    expect(getEvmChainId).not.toHaveBeenCalled();
    expect(getKnowledgeAssetStorageAddress).not.toHaveBeenCalled();
    expect(compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      computeAuthorCatalogScopeDigestV1(fixture.governedScope),
      AUTHOR,
    )).toBeNull();
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
  ) => new Rfc64PublicCatalogNativeReceiverV1({
    headTransport: { fetchCatalogHead: receiverHeadFetch },
    contentTransport,
    controlObjects,
    inventory,
    kaBundles,
    store,
    verifyIssuerSignature,
    beforeAppliedHeadCommit,
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

async function readExactSemanticPairForTest(
  store: TripleStore,
  graph: string,
  sealMetaGraph: string,
  sealSubject: string,
): Promise<{
  readonly graph: readonly Readonly<Record<string, string>>[];
  readonly seal: readonly Readonly<Record<string, string>>[];
}> {
  const [graphResult, sealResult] = await Promise.all([
    store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`,
    ),
    store.query(
      `SELECT ?p ?o WHERE { GRAPH <${sealMetaGraph}> { `
        + `<${sealSubject}> ?p ?o } } ORDER BY ?p ?o`,
    ),
  ]);
  if (graphResult.type !== 'bindings' || sealResult.type !== 'bindings') {
    throw new Error('exact semantic pair test read did not return bindings');
  }
  return Object.freeze({
    graph: Object.freeze(graphResult.bindings.map((row) => Object.freeze({ ...row }))),
    seal: Object.freeze(sealResult.bindings.map((row) => Object.freeze({ ...row }))),
  });
}

async function setTransactionTestVmGeneration(
  store: TripleStore,
  generation: 'predecessor' | 'target',
): Promise<void> {
  if (store.replaceGraph === undefined) {
    throw new Error('transaction test requires atomic graph replacement');
  }
  await store.replaceGraph(TRANSACTION_TEST_VM_GRAPH, [{
    subject: TRANSACTION_TEST_VM_SUBJECT,
    predicate: TRANSACTION_TEST_VM_PREDICATE,
    object: `"${generation}"`,
    graph: TRANSACTION_TEST_VM_GRAPH,
  }]);
}

async function readTransactionTestVmGeneration(
  store: TripleStore,
): Promise<'predecessor' | 'target'> {
  const result = await store.query(
    `SELECT ?generation WHERE { GRAPH <${TRANSACTION_TEST_VM_GRAPH}> { `
      + `<${TRANSACTION_TEST_VM_SUBJECT}> <${TRANSACTION_TEST_VM_PREDICATE}> ?generation } }`,
  );
  if (result.type !== 'bindings' || result.bindings.length !== 1) {
    throw new Error('transaction test VM generation is not exact');
  }
  const generation = result.bindings[0]?.generation;
  if (generation === '"predecessor"') return 'predecessor';
  if (generation === '"target"') return 'target';
  throw new Error('transaction test VM generation is invalid');
}

async function buildDirectCatalogIssuerDelegation(options: {
  readonly scope?: AuthorCatalogScopeV1;
  readonly contextGraphId?: ContextGraphIdV1;
  readonly effectiveAt?: string;
  readonly expiresAt?: string;
} = {}): Promise<SignedAuthorCatalogIssuerDelegationEnvelopeV1> {
  const scope = options.scope ?? {
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
  const unsigned = testUnsignedEnvelope(
    AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
    {
      authorAddress: scope.authorAddress,
      authorAuthorityEvidenceDigest: null,
      catalogEra: scope.era,
      catalogIssuerKey: AUTHOR,
      contextGraphId: options.contextGraphId ?? scope.contextGraphId,
      effectiveAt: options.effectiveAt ?? '1773899999000',
      expiresAt: options.expiresAt ?? '1774000000000',
      governanceChainId: scope.governanceChainId,
      governanceContractAddress: scope.governanceContractAddress,
      networkId: scope.networkId,
      ownershipTransitionDigest: scope.ownershipTransitionDigest,
      previousDelegationDigest: null,
      subGraphName: scope.subGraphName,
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

async function buildMalformedEmptySuccessor(
  sourceHead: SignedAuthorCatalogHeadEnvelopeV1,
  sourceDirectory: SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  descriptorOverrides: Readonly<Record<string, string>>,
): Promise<{
  head: SignedAuthorCatalogHeadEnvelopeV1;
  stagedObjects: readonly SignedControlEnvelopeV1[];
}> {
  const sourceDescriptor = sourceDirectory.payload.entries[0];
  if (sourceDescriptor === undefined) throw new Error('empty successor descriptor is missing');
  const directoryUnsigned = testUnsignedEnvelope(
    AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
    {
      ...sourceDirectory.payload,
      entries: [{ ...sourceDescriptor, ...descriptorOverrides }],
    },
  );
  // Deliberately bypass the directory-specific encoder: these fixtures prove
  // the receiver rejects signed but structurally malformed empty descriptors.
  const directory = await signTestEnvelope(
    directoryUnsigned,
    computeControlObjectDigestHex(directoryUnsigned) as Digest32V1,
  ) as SignedAuthorCatalogDirectoryNodeEnvelopeV1;
  const headUnsigned = testUnsignedEnvelope(AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1, {
    ...sourceHead.payload,
    directoryRootDigest: directory.objectDigest,
  });
  const head = await signTestEnvelope(
    headUnsigned,
    computeAuthorCatalogHeadObjectDigestV1(headUnsigned),
  ) as SignedAuthorCatalogHeadEnvelopeV1;
  return Object.freeze({ head, stagedObjects: Object.freeze([directory, head]) });
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

function alternateRecoveryEncoding(signature: string): string {
  const recovery = signature.slice(-2);
  if (recovery === '1b') return `${signature.slice(0, -2)}00`;
  if (recovery === '1c') return `${signature.slice(0, -2)}01`;
  throw new Error('test fixture signature did not use canonical v=27/28 encoding');
}

async function buildRowBundle(
  signingWallet: ethers.Wallet = AUTHOR_WALLET,
  options: {
    readonly kaNumber?: bigint;
    readonly assertionCoordinate?: string;
  } = {},
): Promise<{ row: AuthorCatalogRowV1; bundleBytes: Uint8Array; kaUal: string }> {
  const kaNumber = options.kaNumber ?? KA_NUMBER;
  const kaId = ((BigInt(AUTHOR) << 96n) | kaNumber).toString();
  const kaUal = `did:dkg:${NETWORK_ID}/${AUTHOR}/${kaNumber}`;
  const typedData = buildAuthorAttestationTypedData({
    chainId: BigInt(DEPLOYMENT.assertedAtChainId),
    kav10Address: DEPLOYMENT.assertedAtKav10Address,
    merkleRoot: ethers.getBytes(ASSERTION_ROOT),
    authorAddress: AUTHOR,
    reservedKaId: BigInt(kaId),
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
    reservedKaId: kaId,
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z',
    contentScopeVersion: '2',
    kaUal,
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
    kaId,
    assertionCoordinate: options.assertionCoordinate ?? 'gate-1-object',
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
  return { row, bundleBytes: encoded.bundleBytes, kaUal };
}

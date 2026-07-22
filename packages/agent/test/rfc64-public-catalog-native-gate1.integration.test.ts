import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
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
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  deriveAuthorCatalogScopeFromHeadV1,
  encodeOpaqueKaBundleV1,
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
import {
  Rfc64PublicCatalogNativeReceiverV1,
  rfc64CatalogSignatureVariantDigestV1,
  type Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1,
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
    expect(observed.stageVerifiedObjects).not.toHaveBeenCalled();
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
    expect(observed.stageVerifiedObjects).not.toHaveBeenCalled();
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
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-slice' });
    expect(fixture.receiverBundleFetch).not.toHaveBeenCalled();
    expect(observed.stageVerifiedObjects).not.toHaveBeenCalled();
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
      code: 'catalog-native-receiver-catalog',
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
      { putKaBundle },
    );

    await expect(fixture.synchronize(
      fixture.announcement,
      observed.receiver,
    )).rejects.toMatchObject({ code: 'catalog-native-receiver-catalog' });
    expect(putKaBundle).toHaveBeenCalledTimes(1);
    expect(observed.stageVerifiedObjects).not.toHaveBeenCalled();
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
    });

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
      message: expect.stringContaining('finalized VM precommit rejected'),
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
    await expect(fixture.receiverStore.countQuads()).resolves.toBe(32);

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

  it('keeps the governed successor head unapplied when the production VM precommit lacks RPC', async () => {
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

    await fixture.bootstrapGoverned(receiver);
    compareAndSwapAppliedCatalogHeadV1.mockClear();
    await expect(fixture.synchronizeGoverned(receiver)).rejects.toMatchObject({
      code: 'catalog-native-receiver-activation',
      message: expect.stringContaining('finalized VM precommit rejected'),
    });

    expect(getOnChainContextGraphId).not.toHaveBeenCalled();
    expect(getEvmChainId).not.toHaveBeenCalled();
    expect(getKnowledgeAssetStorageAddress).not.toHaveBeenCalled();
    expect(compareAndSwapAppliedCatalogHeadV1).not.toHaveBeenCalled();
    expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
      computeAuthorCatalogScopeDigestV1(fixture.governedScope),
      AUTHOR,
    )?.currentCatalogHeadDigest).toBe(fixture.governedGenesis.head.objectDigest);
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
      governedCatalogIssuerDelegation,
      crossLaneDelegation,
      expiredDelegation,
      ...genesis.stagedObjects,
      ...governedGenesis.stagedObjects,
      ...invalidGenesis.stagedObjects,
      ...successor.stagedObjects,
      ...multiAssetSuccessor.stagedObjects,
      ...removalSuccessor.stagedObjects,
      ...threeAssetSuccessor.stagedObjects,
      ...replacementSuccessor.stagedObjects,
      ...governedSuccessor.stagedObjects,
      ...competingSuccessor.stagedObjects,
      crossLaneHead,
      expiredHead,
      missingDelegationHead,
    ]
      .map((envelope) => [envelope.objectDigest, envelope]),
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
    [
      catalogIssuerDelegation,
      governedCatalogIssuerDelegation,
      crossLaneDelegation,
      expiredDelegation,
      ...genesis.stagedObjects,
      ...governedGenesis.stagedObjects,
      ...invalidGenesis.stagedObjects,
      ...successor.stagedObjects,
      ...multiAssetSuccessor.stagedObjects,
      ...removalSuccessor.stagedObjects,
      ...threeAssetSuccessor.stagedObjects,
      ...replacementSuccessor.stagedObjects,
      ...governedSuccessor.stagedObjects,
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
  const stagedObjects: Array<{
    readonly objectDigest: Digest32V1;
    readonly signatureVariantDigest: Digest32V1;
  }> = [];
  for (let offset = 0; offset < verifiedObjects.length; offset += 16) {
    const stagedBatch = await authorPersistence.controlObjects.stageVerifiedObjects(
      verifiedObjects.slice(offset, offset + 16),
    );
    stagedObjects.push(...stagedBatch.objects);
  }
  const staged = { objects: stagedObjects };
  const headKeys = staged.objects.find(
    (keys) => keys.objectDigest === successor.head.objectDigest,
  );
  const genesisHeadKeys = staged.objects.find(
    (keys) => keys.objectDigest === genesis.head.objectDigest,
  );
  const multiAssetHeadKeys = staged.objects.find(
    (keys) => keys.objectDigest === multiAssetSuccessor.head.objectDigest,
  );
  const removalHeadKeys = staged.objects.find(
    (keys) => keys.objectDigest === removalSuccessor.head.objectDigest,
  );
  const replacementHeadKeys = staged.objects.find(
    (keys) => keys.objectDigest === replacementSuccessor.head.objectDigest,
  );
  const threeAssetHeadKeys = staged.objects.find(
    (keys) => keys.objectDigest === threeAssetSuccessor.head.objectDigest,
  );
  const governedGenesisHeadKeys = staged.objects.find(
    (keys) => keys.objectDigest === governedGenesis.head.objectDigest,
  );
  const governedSuccessorHeadKeys = staged.objects.find(
    (keys) => keys.objectDigest === governedSuccessor.head.objectDigest,
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
  if (multiAssetHeadKeys === undefined) throw new Error('multi-asset successor head was not staged');
  if (removalHeadKeys === undefined) throw new Error('removal successor head was not staged');
  if (replacementHeadKeys === undefined) throw new Error('replacement successor head was not staged');
  if (threeAssetHeadKeys === undefined) throw new Error('three-asset successor head was not staged');
  if (governedGenesisHeadKeys === undefined) throw new Error('governed genesis head was not staged');
  if (governedSuccessorHeadKeys === undefined) throw new Error('governed successor head was not staged');
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
  const multiAssetAnnouncement = Object.freeze({
    ...announcement,
    catalogVersion: multiAssetSuccessor.head.payload.version,
    catalogHeadObjectDigest: multiAssetHeadKeys.objectDigest,
    signatureVariantDigest: multiAssetHeadKeys.signatureVariantDigest,
  }) satisfies Rfc64PublicCatalogHeadAnnouncementV1;
  const removalAnnouncement = Object.freeze({
    ...announcement,
    catalogVersion: removalSuccessor.head.payload.version,
    catalogHeadObjectDigest: removalHeadKeys.objectDigest,
    signatureVariantDigest: removalHeadKeys.signatureVariantDigest,
  }) satisfies Rfc64PublicCatalogHeadAnnouncementV1;
  const replacementAnnouncement = Object.freeze({
    ...announcement,
    catalogVersion: replacementSuccessor.head.payload.version,
    catalogHeadObjectDigest: replacementHeadKeys.objectDigest,
    signatureVariantDigest: replacementHeadKeys.signatureVariantDigest,
  }) satisfies Rfc64PublicCatalogHeadAnnouncementV1;
  const threeAssetAnnouncement = Object.freeze({
    ...announcement,
    catalogVersion: threeAssetSuccessor.head.payload.version,
    catalogHeadObjectDigest: threeAssetHeadKeys.objectDigest,
    signatureVariantDigest: threeAssetHeadKeys.signatureVariantDigest,
  }) satisfies Rfc64PublicCatalogHeadAnnouncementV1;
  const competingAnnouncement = Object.freeze({
    ...announcement,
    catalogHeadObjectDigest: competingHeadKeys.objectDigest,
    signatureVariantDigest: competingHeadKeys.signatureVariantDigest,
  }) satisfies Rfc64PublicCatalogHeadAnnouncementV1;
  const governedGenesisAnnouncement = Object.freeze({
    ...genesisAnnouncement,
    catalogHeadObjectDigest: governedGenesisHeadKeys.objectDigest,
    signatureVariantDigest: governedGenesisHeadKeys.signatureVariantDigest,
  }) satisfies Rfc64PublicCatalogHeadAnnouncementV1;
  const governedSuccessorAnnouncement = Object.freeze({
    ...announcement,
    catalogHeadObjectDigest: governedSuccessorHeadKeys.objectDigest,
    signatureVariantDigest: governedSuccessorHeadKeys.signatureVariantDigest,
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
    controlObjects: Pick<
      Rfc64PersistenceV1['controlObjects'],
      'stageVerifiedObjects' | 'getVerifiedObjectByDigest'
    > = receiverPersistence.controlObjects,
    contentTransport: Pick<
      Rfc64PublicCatalogNativeTransportV1,
      'fetchCatalogObject' | 'fetchKaBundle'
    > = {
      fetchCatalogObject: receiverObjectFetch,
      fetchKaBundle: receiverBundleFetch,
    },
    store: TripleStore = receiverStore,
    beforeAppliedHeadCommit?: Rfc64PublicCatalogNativeBeforeAppliedHeadCommitHandlerV1,
    kaBundles: Pick<Rfc64PersistenceV1['kaBundles'], 'putKaBundle'> =
      receiverPersistence.kaBundles,
  ) => new Rfc64PublicCatalogNativeReceiverV1({
    headTransport: { fetchCatalogHead: receiverHeadFetch },
    contentTransport,
    controlObjects,
    inventory,
    kaBundles,
    store,
    beforeAppliedHeadCommit,
  });
  const createCasObservedReceiver = (contentTransport?: Pick<
    Rfc64PublicCatalogNativeTransportV1,
    'fetchCatalogObject' | 'fetchKaBundle'
  >, store: TripleStore = receiverStore, kaBundles: Pick<
    Rfc64PersistenceV1['kaBundles'],
    'putKaBundle'
  > = receiverPersistence.kaBundles) => {
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
    const getVerifiedObjectByDigest =
      receiverPersistence.controlObjects.getVerifiedObjectByDigest.bind(
        receiverPersistence.controlObjects,
      );
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
      }, contentTransport, store, undefined, kaBundles),
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
    governedGenesis,
    governedGenesisAnnouncement,
    governedScope,
    governedSuccessor,
    governedSuccessorAnnouncement,
    invalidGenesisAnnouncement,
    receiver,
    receiverBundleFetch,
    missingDelegationAnnouncement,
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

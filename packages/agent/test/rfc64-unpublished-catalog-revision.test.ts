/**
 * A shared draft may be revised before its first VM publication. Both seals use assertionVersion1,
 * because that is the number the chain will accept. The catalog must advance to the current
 * authenticated share, then retain exactly that content when it is confirmed. The failure was
 * reproduced on a freshly initialized node.
 *
 * Real: author signatures, durable workspace/inventory, catalog producer and applied-head CAS,
 * immutable catalog readback, confirmation observer and repair retirement. Chain/registration
 * authority is supplied by the existing hermetic repair fixture; no real wallets or RPC.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertSignedAuthorCatalogHeadEnvelopeV1,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createOperationContext,
  createGraphKnowledgeAssetScope, encodeCanonicalCgSharedPublicRootProjectionV1,
  knowledgeAssetLayerGraphUri, MemoryLayer,
  type AuthorCatalogScopeV1,
  type AssertionCoordinateV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../src/index.js';
import type { Rfc64PublicCatalogSuccessorAssetInputV1 } from '../src/rfc64/public-catalog-successor-asset-v1.js';
import { readVerifiedRfc64CatalogMutationStateV1 } from '../src/internal/catalog-mutation-memory.js';
import type { Rfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { Rfc64PublicCatalogNativeReceiverV1 } from '../src/rfc64/public-catalog-native-receiver-v1.js';
import { generateGraphKnowledgeAssetMetadata, withMaterializationLock } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1 } from '../src/rfc64/public-catalog-native-transport-v1.js';
import { ethers } from 'ethers';
import {
  AUTHOR, AUTHOR_WALLET, CONTEXT_GRAPH_ID, PROJECTION_QUADS, NETWORK_ID, NATIVE_DEPLOYMENT,
  authorSealV1, bootstrapConfigV1, catalogScopeDigestV1,
  agents, tempDirs, seedDurableWorkspaceAssetV1, startRepairAgentV1,
} from './support/rfc64-local-catalog-repair-fixture.js';

const SCOPE = Object.freeze({ networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID,
  governanceChainId: null, governanceContractAddress: null, ownershipTransitionDigest: null,
  subGraphName: null, authorAddress: AUTHOR, era: '0', bucketCount: '1',
}) as AuthorCatalogScopeV1;

async function storeVmMetadata(agent: DKGAgent, asset: Rfc64PublicCatalogSuccessorAssetInputV1,
  quads: readonly Quad[], status: 'confirmed' | 'tentative' = 'confirmed') {
  const { seal } = asset;
  const graph = knowledgeAssetLayerGraphUri(CONTEXT_GRAPH_ID, MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion));
  await agent.store.insert([
    ...quads.map(quad => ({ ...quad, graph })),
    ...generateGraphKnowledgeAssetMetadata({ contextGraphId: CONTEXT_GRAPH_ID,
      ual: seal.kaUal, merkleRoot: ethers.getBytes(seal.assertionMerkleRoot),
      publisherPeerId: 'confirmed-fixture', accessPolicy: 'public', allowedPeers: [],
      timestamp: new Date(seal.assertionFinalizedAt), assertionVersion: seal.assertionVersion, authorAddress: AUTHOR,
      publicTripleCount: quads.length, privateTripleCount: 0, assertionGraph: graph,
    }, status === 'confirmed' ? { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
      batchId: BigInt(seal.reservedKaId), materializedVersion: { blockNumber: 124, txIndex: 0 },
    } } } : { status: 'tentative' }),
  ]);
}

async function confirmedRevision(agent: DKGAgent, metadataState: 'confirmed' | 'tentative' | 'absent' = 'confirmed'): Promise<Rfc64PublicCatalogSuccessorAssetInputV1> {
  const quads = [...PROJECTION_QUADS, { subject: 'https://example.org/alice',
    predicate: 'https://schema.org/description', object: '"Confirmed revised content"', graph: '' }];
  const asset = { assertionCoordinate: 'repair-revision' as AssertionCoordinateV1,
    seal: await authorSealV1(1n, '1', quads), projectionBytes: encodeCanonicalCgSharedPublicRootProjectionV1(quads) };
  if (metadataState !== 'absent') await storeVmMetadata(agent, asset, quads, metadataState);
  return asset;
}

function mutationParams() {
  return { scope: SCOPE,
    author: { address: AUTHOR, signMessage: (bytes: Uint8Array) => AUTHOR_WALLET.signMessage(bytes) },
    deployment: NATIVE_DEPLOYMENT, peers: [], catalogIssuerDelegationEffectiveAt: '0' as TimestampMsV1,
    catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
  };
}

function upsert(agent: DKGAgent, asset: Rfc64PublicCatalogSuccessorAssetInputV1) {
  return agent.upsertConfirmedRfc64PublicRootCatalogAssetV1({ ...mutationParams(), asset });
}

async function author(persisted: { dataDir?: string; storePath?: string } = {}) {
  let project!: OmitThisParameter<DKGAgent['reconcileRfc64PublicCatalogFromSwmInventoryV1']>;
  const agent = await startRepairAgentV1({
    name: 'unpublished-catalog-revision',
    ...persisted,
    bootstrap: bootstrapConfigV1(undefined, false),
    autoPublish: { peers: [], catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1 },
    beforeStart(starting) {
      vi.spyOn(starting, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
      project = starting.reconcileRfc64PublicCatalogFromSwmInventoryV1.bind(starting);
      vi.spyOn(starting, 'reconcileRfc64PublicCatalogFromSwmInventoryV1').mockResolvedValue(null);
      const internal = starting as unknown as Record<string, (...args: any[]) => any>;
      const lane = internal.resolveRfc64CatalogAuthoringLaneDecisionV1!.bind(starting);
      vi.spyOn(internal, 'resolveRfc64CatalogAuthoringLaneDecisionV1').mockImplementation((...args) => {
        const decision = lane(...args);
        return decision.status === 'active' ? {
          ...decision,
          lane: { ...decision.lane, acceptsFinalizedVmRepair: true, projectionTargetPolicy: 'monotonic-union' },
        } : decision;
      });
    },
  });
  await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
  return {
    agent,
    project: () => project({ contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR }),
  };
}

const persistenceOf = (agent: DKGAgent) => (
  agent as unknown as { rfc64PersistenceV1: Rfc64PersistenceV1 }
).rfc64PersistenceV1;

/** Transport reads are in-process; signatures, bundle validation and SWM/CAS are production. */
async function receivingCatalog(author: DKGAgent) {
  const peer = await startRepairAgentV1({ name: 'revision-receiver' });
  const source = persistenceOf(author), target = persistenceOf(peer);
  const readObject = (objectDigest: Parameters<typeof source.controlObjects.getVerifiedObjectByDigest>[0]['objectDigest']) =>
    source.controlObjects.getVerifiedObjectByDigest({ objectDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1 });
  const receiver = new Rfc64PublicCatalogNativeReceiverV1({
    headTransport: { fetchCatalogHead: async (_peer, announcement) => {
      const found = await readObject(announcement.catalogHeadObjectDigest);
      if (found === null) return null;
      assertSignedAuthorCatalogHeadEnvelopeV1(found.envelope);
      return { envelope: found.envelope, issuerSignature: found.issuerSignature };
    } },
    contentTransport: {
      fetchCatalogObject: async (_peer, request) => readObject(request.targetObjectDigest),
      fetchKaBundle: async (_peer, request) => source.kaBundles.readKaBundleByDigest(request.blobDigest),
    },
    controlObjects: target.controlObjects, inventory: target.inventory, kaBundles: target.kaBundles,
    store: peer.store,
  });
  return { peer, receive: (announcement: Parameters<typeof receiver.synchronizeBoundedPublicRootCatalog>[1]) =>
    receiver.synchronizeBoundedPublicRootCatalog('in-process-author', announcement, SCOPE, NATIVE_DEPLOYMENT) };
}

type Asset = Awaited<ReturnType<typeof seedDurableWorkspaceAssetV1>>;
async function record(agent: DKGAgent, asset: Asset) {
  expect(await agent.recordRfc64SwmAuthorInventoryShadowV1({
    contextGraphId: CONTEXT_GRAPH_ID, assertionCoordinate: asset.assertionCoordinate,
    lifecycleAgentAddress: AUTHOR, shareOperationId: asset.shareOperationId,
  })).toMatchObject({ status: 'applied' });
}

async function catalog(agent: DKGAgent) {
  const head = agent.readRfc64AppliedCatalogHeadV1({
    catalogScopeDigest: catalogScopeDigestV1(), authorAddress: AUTHOR,
  });
  expect(head).not.toBeNull();
  const persistence = (agent as unknown as { rfc64PersistenceV1: Rfc64PersistenceV1 }).rfc64PersistenceV1;
  return readVerifiedRfc64CatalogMutationStateV1(persistence, head!);
}

describe('catalog revisions of an unpublished assertion number', () => {
  it('preserves both rows when upserts arrive out of KA order', async () => {
    const { agent } = await author();
    for (const kaNumber of [2n, 1n]) {
      await upsert(agent, { assertionCoordinate: `repair-${kaNumber}` as AssertionCoordinateV1,
        seal: await authorSealV1(kaNumber),
        projectionBytes: encodeCanonicalCgSharedPublicRootProjectionV1(PROJECTION_QUADS) });
    }
    expect((await catalog(agent)).assets.map(asset => asset.assertionCoordinate))
      .toEqual(['repair-1', 'repair-2']);
  });

  it('projects the revised share through valid successors and retires its exact confirmation repair', async () => {
    const { agent, project } = await author();
    const deliveries = vi.spyOn(agent, 'deliverRfc64CatalogHeadV1');
    const remote = await receivingCatalog(agent);
    const first = await seedDurableWorkspaceAssetV1(agent, 'revision', 1n);
    await record(agent, first);
    await project();
    const initial = await catalog(agent);
    expect(initial.assets).toHaveLength(1);
    expect(initial.assets[0]!.seal.assertionVersion).toBe('1');
    await remote.receive(deliveries.mock.calls.at(-1)![0].announcement);

    const quads = [...PROJECTION_QUADS, {
      subject: 'https://example.org/alice', predicate: 'https://schema.org/description',
      object: '"Revised before first publication"', graph: '',
    }];
    const seal = await authorSealV1(1n, '1', quads);
    // Reopening removes the active seal; the original catalog/bundle remains immutable.
    await agent.store.deleteByPattern({
      graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      subject: contextGraphAssertionUri(CONTEXT_GRAPH_ID, AUTHOR, first.assertionCoordinate),
    });
    const revised = await seedDurableWorkspaceAssetV1(agent, 'revision', 1n, 'public', {
      quads, seal, shareOperationId: 'repair-operation-revision-second',
    });
    expect(revised.seal.kaUal).toBe(first.seal.kaUal);
    expect(revised.seal.assertionVersion).toBe(first.seal.assertionVersion);
    expect(revised.seal.merkleRoot).not.toEqual(first.seal.merkleRoot);
    await record(agent, revised);
    const result = await project();
    expect(result).toMatchObject({ status: 'advanced', successorsApplied: 2, targetAssetCount: 1 });
    const advanced = await catalog(agent);
    expect(advanced.assets).toHaveLength(1);
    expect(advanced.assets[0]!.seal).toEqual(seal);
    // Only the final head is delivered: the receiver must verify the intervening withdrawal.
    const revisedHead = deliveries.mock.calls.at(-1)![0].announcement;
    await expect(remote.receive(revisedHead)).resolves.toMatchObject({ inventoryRowCount: 1 });
    expect((await catalog(remote.peer)).assets[0]!.seal).toEqual(seal);
    const graph = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/1`;
    expect(await remote.peer.store.countQuads(graph)).toBe(quads.length);

    await agent.observeRfc64ConfirmedVmV1({
      contextGraphId: CONTEXT_GRAPH_ID, assertionCoordinate: revised.assertionCoordinate,
      shareOperationId: revised.shareOperationId, seal: revised.seal,
      assertionUri: contextGraphAssertionUri(CONTEXT_GRAPH_ID, AUTHOR, revised.assertionCoordinate),
      ctx: createOperationContext('publish'), publicationLabel: 'queued publish',
    });
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    const persistence = (agent as unknown as { rfc64PersistenceV1: Rfc64PersistenceV1 }).rfc64PersistenceV1;
    expect(persistence.finalizedPrivatePlacementRepairs.list()).toEqual([]);
    expect((await catalog(agent)).assets[0]!.seal).toEqual(seal);
  });

  it('repairs a confirmed revision, but refuses a competing seal without VM proof and late old inventory', async () => {
    const { agent, project } = await author();
    const first = await seedDurableWorkspaceAssetV1(agent, 'revision', 1n);
    await record(agent, first);
    await project();
    const initial = (await catalog(agent)).assets[0]!;
    const competing = { ...initial, seal: { ...initial.seal,
      assertionFinalizedAt: '2026-07-20T12:34:56.789Z' as typeof initial.seal.assertionFinalizedAt } };
    await expect(upsert(agent, competing)).rejects.toMatchObject({ kind: 'version_conflict' });
    expect((await catalog(agent)).assets[0]!.seal).toEqual(initial.seal);

    const revised = await confirmedRevision(agent);
    const input = { ...revised, seal: { ...revised.seal }, projectionBytes: new Uint8Array(revised.projectionBytes) };
    const internal = agent as unknown as Record<string, (...args: any[]) => any>;
    const apply = internal.applyRfc64CatalogSuccessorV1!.bind(agent);
    const mutation = vi.spyOn(internal, 'applyRfc64CatalogSuccessorV1').mockImplementationOnce(async (...args) => {
      // The caller changes its bytes after the proof but before withdrawal commits.
      input.seal.assertionMerkleRoot = initial.seal.assertionMerkleRoot;
      input.projectionBytes.fill(0);
      return apply(...args);
    });
    await upsert(agent, input);
    mutation.mockRestore();
    expect((await catalog(agent)).assets[0]!.seal).toEqual(revised.seal);
    // The old inventory is still current. It cannot overwrite the confirmed content.
    await expect(project()).rejects.toMatchObject({ kind: 'version_conflict' });
    await expect(upsert(agent, initial)).rejects.toMatchObject({ kind: 'version_conflict' });
    await expect(upsert(agent, { ...revised, assertionCoordinate: 'another-coordinate' as AssertionCoordinateV1 }))
      .rejects.toMatchObject({ kind: 'version_conflict' });
    await expect(upsert(agent, { ...revised, seal: { ...revised.seal,
      assertionVersion: '3' as typeof revised.seal.assertionVersion } }))
      .rejects.toMatchObject({ kind: 'version_conflict' });
    expect((await catalog(agent)).assets[0]!.seal).toEqual(revised.seal);
  });

  it.each(['malformed', 'wrong-root', 'bad-attestation', 'oversize'] as const)(
    'refuses a %s replacement before withdrawing the valid row', async fault => {
      const { agent, project } = await author();
      const first = await seedDurableWorkspaceAssetV1(agent, 'revision', 1n);
      await record(agent, first); await project();
      const revised = await confirmedRevision(agent); await upsert(agent, revised);
      const before = (await catalog(agent)).current;
      const asset = { ...revised };
      if (fault === 'malformed') asset.projectionBytes = new Uint8Array([0]);
      if (fault === 'wrong-root') asset.projectionBytes = encodeCanonicalCgSharedPublicRootProjectionV1([
        ...PROJECTION_QUADS, { subject: 'https://example.org/alice', predicate: 'https://schema.org/description',
          object: '"Different root"', graph: '' },
      ]);
      if (fault === 'bad-attestation') asset.seal = { ...asset.seal,
        authorAttestationR: `0x${'00'.repeat(32)}` as typeof asset.seal.authorAttestationR };
      if (fault === 'oversize') asset.projectionBytes = new Uint8Array(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1 + 1);
      await expect(upsert(agent, asset)).rejects.toThrow();
      expect((await catalog(agent)).current).toEqual(before);
      expect((await catalog(agent)).assets[0]!.seal).toEqual(revised.seal);
    });

  it('rejects a draft when VM materialization wins before the guarded withdrawal', async () => {
    const { agent, project } = await author();
    const first = await seedDurableWorkspaceAssetV1(agent, 'revision', 1n);
    await record(agent, first); await project();
    const before = await catalog(agent), original = before.assets[0]!;
    await agent.store.deleteByPattern({ graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      subject: contextGraphAssertionUri(CONTEXT_GRAPH_ID, AUTHOR, first.assertionCoordinate) });
    const quads = [...PROJECTION_QUADS, { subject: 'https://example.org/alice',
      predicate: 'https://schema.org/description', object: '"Draft revision"', graph: '' }];
    const draft = await seedDurableWorkspaceAssetV1(agent, 'revision', 1n, 'public', {
      seal: await authorSealV1(1n, '1', quads), quads, shareOperationId: 'draft-after-first',
    });
    await record(agent, draft);
    const query = agent.store.query.bind(agent.store);
    let writer: Promise<void> | undefined, started = false;
    vi.spyOn(agent.store, 'query').mockImplementation(async (...args) => {
      const result = await query(...args);
      if (!started && args[0].includes('SELECT ?predicate ?object') && args[0].includes(original.seal.kaUal)) {
        started = true;
        writer = withMaterializationLock(contextGraphMetaUri(CONTEXT_GRAPH_ID), original.seal.kaUal,
          () => storeVmMetadata(agent, original, PROJECTION_QUADS));
        await writer;
      }
      return result;
    });
    await expect(project()).rejects.toMatchObject({ kind: 'version_conflict' });
    expect(writer).toBeDefined();
    expect((await catalog(agent)).current).toEqual(before.current);
  });

  it('holds the VM lock from the insertion check through signing and applied-head commit', async () => {
    const { agent, project } = await author();
    const first = await seedDurableWorkspaceAssetV1(agent, 'revision', 1n);
    await record(agent, first); await project();
    const original = (await catalog(agent)).assets[0]!;
    await agent.store.deleteByPattern({ graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      subject: contextGraphAssertionUri(CONTEXT_GRAPH_ID, AUTHOR, first.assertionCoordinate) });
    const quads = [...PROJECTION_QUADS, { subject: 'https://example.org/alice',
      predicate: 'https://schema.org/description', object: '"Draft revision"', graph: '' }];
    const draft = await seedDurableWorkspaceAssetV1(agent, 'revision', 1n, 'public', {
      seal: await authorSealV1(1n, '1', quads), quads, shareOperationId: 'draft-during-sign',
    });
    await record(agent, draft);
    const produce = agent.publishAuthorCatalogExactSetSuccessorV1.bind(agent);
    let writer: Promise<void> | undefined, writerEntered = false, calls = 0;
    vi.spyOn(agent, 'publishAuthorCatalogExactSetSuccessorV1').mockImplementation(async input => {
      const produced = await produce(input);
      if (++calls === 2) {
        writer = withMaterializationLock(contextGraphMetaUri(CONTEXT_GRAPH_ID), original.seal.kaUal, async () => {
          writerEntered = true; await storeVmMetadata(agent, original, PROJECTION_QUADS);
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(writerEntered).toBe(false);
      }
      return produced;
    });
    const internal = agent as unknown as Record<string, (...args: any[]) => any>;
    const apply = internal.applyRfc64CatalogSuccessorV1!.bind(agent);
    vi.spyOn(internal, 'applyRfc64CatalogSuccessorV1').mockImplementation(async (...args) => {
      const result = await apply(...args);
      if (calls === 2) expect(writerEntered).toBe(false);
      return result;
    });
    await project();
    expect(writer).toBeDefined(); await writer;
    expect(writerEntered).toBe(true);
    // The VM writer linearizes after the catalog. Its ordinary confirmation repair restores A.
    await agent.observeRfc64ConfirmedVmV1({ contextGraphId: CONTEXT_GRAPH_ID,
      assertionCoordinate: first.assertionCoordinate, shareOperationId: first.shareOperationId, seal: first.seal,
      assertionUri: contextGraphAssertionUri(CONTEXT_GRAPH_ID, AUTHOR, first.assertionCoordinate),
      ctx: createOperationContext('publish'), publicationLabel: 'queued publish' });
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect((await catalog(agent)).assets[0]!.seal).toEqual(original.seal);
  });

  it('allows authenticated draft projection with valid tentative metadata', async () => {
    const { agent, project } = await author();
    const first = await seedDurableWorkspaceAssetV1(agent, 'revision', 1n);
    await record(agent, first);
    await confirmedRevision(agent, 'tentative');
    await expect(project()).resolves.toMatchObject({ status: 'advanced', targetAssetCount: 1 });
    expect((await catalog(agent)).assets[0]!.seal.assertionMerkleRoot)
      .toBe(ethers.hexlify(first.seal.merkleRoot));
  });

  it('requires matching VM proof for confirmed exact-set replacement before withdrawing the old draft', async () => {
    const { agent, project } = await author();
    const first = await seedDurableWorkspaceAssetV1(agent, 'revision', 1n);
    await record(agent, first);
    await project();
    const before = await catalog(agent);
    const revised = await confirmedRevision(agent, 'absent');
    const replace = () => agent.reconcileRfc64PublicRootCatalogExactSetV1({
      ...mutationParams(), assets: [revised],
    });
    await expect(replace()).rejects.toMatchObject({ kind: 'version_conflict' });
    expect((await catalog(agent)).current).toEqual(before.current);
    await confirmedRevision(agent);
    await expect(replace()).resolves.toMatchObject({ status: 'advanced', successorsApplied: 2 });
    expect((await catalog(agent)).assets[0]!.seal).toEqual(revised.seal);
  });

  it('rechecks VM content when confirmation races the withdrawal of an unpublished draft', async () => {
    const { agent, project } = await author();
    const first = await seedDurableWorkspaceAssetV1(agent, 'revision', 1n);
    await record(agent, first);
    await project();
    const quads = [...PROJECTION_QUADS, { subject: 'https://example.org/alice',
      predicate: 'https://schema.org/description', object: '"Unconfirmed draft"', graph: '' }];
    await agent.store.deleteByPattern({ graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      subject: contextGraphAssertionUri(CONTEXT_GRAPH_ID, AUTHOR, first.assertionCoordinate) });
    const draft = await seedDurableWorkspaceAssetV1(agent, 'revision', 1n, 'public', {
      quads, seal: await authorSealV1(1n, '1', quads), shareOperationId: 'later-draft',
    });
    await record(agent, draft);
    const internal = agent as unknown as Record<string, (...args: any[]) => any>;
    const apply = internal.applyRfc64CatalogSuccessorV1!.bind(agent);
    let confirmed!: Awaited<ReturnType<typeof confirmedRevision>>;
    const mutation = vi.spyOn(internal, 'applyRfc64CatalogSuccessorV1').mockImplementationOnce(async (...args) => {
      const removed = await apply(...args);
      confirmed = await confirmedRevision(agent);
      return removed;
    });
    await expect(project()).rejects.toMatchObject({ kind: 'version_conflict' });
    mutation.mockRestore();
    expect((await catalog(agent)).assets).toEqual([]);
    await upsert(agent, confirmed);
    expect((await catalog(agent)).assets[0]!.seal).toEqual(confirmed.seal);
  });

  it('retains owed work across a restart after withdrawal and prevents old inventory winning the empty-row window', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-catalog-revision-restart-'));
    tempDirs.push(dataDir);
    const persisted = { dataDir, storePath: join(dataDir, 'oxigraph') };
    const { agent, project } = await author(persisted);
    const first = await seedDurableWorkspaceAssetV1(agent, 'revision', 1n);
    await record(agent, first);
    await project();
    const revised = await confirmedRevision(agent);
    const internal = agent as unknown as Record<string, (...args: any[]) => any>;
    const apply = internal.applyRfc64CatalogSuccessorV1!.bind(agent);
    let calls = 0;
    vi.spyOn(internal, 'applyRfc64CatalogSuccessorV1').mockImplementation(async (...args) => {
      if (++calls > 1) throw new Error('injected interruption before insertion');
      return apply(...args);
    });
    const confirmation = {
      contextGraphId: CONTEXT_GRAPH_ID, assertionCoordinate: revised.assertionCoordinate,
      shareOperationId: 'confirmed-revised-operation',
      seal: { ...first.seal, merkleRoot: ethers.getBytes(revised.seal.assertionMerkleRoot),
        authorAttestationR: ethers.getBytes(revised.seal.authorAttestationR),
        authorAttestationVS: ethers.getBytes(revised.seal.authorAttestationVS),
        publicTripleCount: Number(revised.seal.publicTripleCount) },
      assertionUri: contextGraphAssertionUri(CONTEXT_GRAPH_ID, AUTHOR, revised.assertionCoordinate),
      ctx: createOperationContext('publish'), publicationLabel: 'queued publish' as const,
    };
    await agent.observeRfc64ConfirmedVmV1(confirmation);
    await agent.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    const persistence = (agent as unknown as { rfc64PersistenceV1: Rfc64PersistenceV1 }).rfc64PersistenceV1;
    expect((await catalog(agent)).assets).toEqual([]);
    expect(persistence.finalizedPrivatePlacementRepairs.list()).toHaveLength(1);
    await expect(project()).rejects.toMatchObject({ kind: 'version_conflict' });
    expect((await catalog(agent)).assets).toEqual([]);

    await agent.stop();
    agents.splice(agents.indexOf(agent), 1);
    const { agent: restarted } = await author(persisted);
    restarted.retryRfc64FailedPrivatePlacementsV1();
    await restarted.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
    expect((await catalog(restarted)).assets[0]!.seal).toEqual(revised.seal);
    expect(persistenceOf(restarted).finalizedPrivatePlacementRepairs.list()).toEqual([]);
  });
});

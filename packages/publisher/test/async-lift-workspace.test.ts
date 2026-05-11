import { beforeEach, describe, expect, it } from 'vitest';
import { GraphManager, OxigraphStore, PrivateContentStore } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { DKGPublisher, generateSubGraphRegistration } from '../src/index.js';
import { resolveLiftWorkspaceSlice, resolveWorkspaceSelection } from '../src/workspace-resolution.js';
import { createEVMAdapter, getSharedContext, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';

const CONTEXT_GRAPH = 'test-workspace';
const ENTITY = 'urn:test:entity:1';
const ENTITY_2 = 'urn:test:entity:2';

describe('async lift workspace resolution', () => {
  let store: OxigraphStore;
  let graphManager: GraphManager;
  let publisher: DKGPublisher;
  beforeEach(async () => {
    store = new OxigraphStore();
    graphManager = new GraphManager(store);
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
  });

  it('resolves workspace selection by roots with graphless quads', async () => {
    await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const quads = await resolveWorkspaceSelection({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      selection: { rootEntities: [ENTITY] },
    });

    expect(quads).toHaveLength(1);
    expect(quads[0]?.subject).toBe(ENTITY);
    expect(quads[0]?.graph).toBe('');
  });

  it('includes skolemized descendants when resolving by root selection', async () => {
    const skolem = `${ENTITY}/.well-known/genid/child-1`;
    await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: skolem, predicate: 'http://schema.org/value', object: '"Nested"', graph: '' },
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const quads = await resolveWorkspaceSelection({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      selection: { rootEntities: [ENTITY] },
    });

    expect(quads).toHaveLength(2);
    expect(quads.map((quad) => quad.subject).sort()).toEqual([ENTITY, skolem].sort());
  });

  it('resolves a LiftRequest slice using shareOperationId and roots', async () => {
    const skolem = `${ENTITY}/.well-known/genid/child-1`;
    const write = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: skolem, predicate: 'http://schema.org/value', object: '"Nested"', graph: '' },
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        swmId: 'swm-main',
        shareOperationId: write.shareOperationId,
        roots: [ENTITY],
        contextGraphId: CONTEXT_GRAPH,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      },
    });

    expect(resolved.quads).toHaveLength(2);
    expect(resolved.quads.map((quad) => quad.subject).sort()).toEqual([ENTITY, skolem].sort());
    expect(resolved.publisherPeerId).toBe('peer1');
  });

  it('resolves async lift payloads from the requested sub-graph partition', async () => {
    const subGraphName = 'research';
    const privateStore = new PrivateContentStore(store, graphManager);
    await graphManager.ensureSubGraph(CONTEXT_GRAPH, subGraphName);
    await store.insert(generateSubGraphRegistration({
      contextGraphId: CONTEXT_GRAPH,
      subGraphName,
      createdBy: 'peer1',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    }));

    await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Default"', graph: '' },
    ], { publisherPeerId: 'peer1' });
    const write = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Research"', graph: '' },
    ], { publisherPeerId: 'peer1', subGraphName });
    await privateStore.storePrivateTriplesForOperation(CONTEXT_GRAPH, write.shareOperationId, ENTITY, [
      { subject: ENTITY, predicate: 'http://schema.org/secret', object: '"subgraph-secret"', graph: '' },
    ], subGraphName);
    expect(await privateStore.getPrivateTriples(CONTEXT_GRAPH, ENTITY, subGraphName)).toEqual([]);

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        swmId: 'swm-main',
        shareOperationId: write.shareOperationId,
        roots: [ENTITY],
        contextGraphId: CONTEXT_GRAPH,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
        subGraphName,
      },
    });

    expect(resolved.quads).toEqual([
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Research"', graph: '' },
    ]);
    expect(resolved.privateQuads).toEqual([
      { subject: ENTITY, predicate: 'http://schema.org/secret', object: '"subgraph-secret"', graph: '' },
    ]);

    const defaultQuads = await resolveWorkspaceSelection({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      selection: { rootEntities: [ENTITY] },
    });
    expect(defaultQuads).toEqual([
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Default"', graph: '' },
    ]);
  });

  it('resolves public and private async lift payloads by shareOperationId instead of combining root history', async () => {
    const privateStore = new PrivateContentStore(store, graphManager);
    const secretPredicate = 'http://schema.org/secret';
    const write1 = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ], { publisherPeerId: 'peer1' });
    await privateStore.storePrivateTriplesForOperation(CONTEXT_GRAPH, write1.shareOperationId, ENTITY, [
      { subject: ENTITY, predicate: secretPredicate, object: '"first"', graph: '' },
    ]);

    const write2 = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ], { publisherPeerId: 'peer1' });
    await privateStore.storePrivateTriplesForOperation(CONTEXT_GRAPH, write2.shareOperationId, ENTITY, [
      { subject: ENTITY, predicate: secretPredicate, object: '"second"', graph: '' },
    ]);
    expect(await privateStore.getPrivateTriples(CONTEXT_GRAPH, ENTITY)).toEqual([]);

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        swmId: 'swm-main',
        shareOperationId: write1.shareOperationId,
        roots: [ENTITY],
        contextGraphId: CONTEXT_GRAPH,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      },
    });

    expect(resolved.quads).toEqual([
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ]);
    expect(resolved.privateQuads).toEqual([
      { subject: ENTITY, predicate: secretPredicate, object: '"first"', graph: '' },
    ]);
    expect(resolved.publisherPeerId).toBe('peer1');

    const liveQuads = await resolveWorkspaceSelection({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      selection: { rootEntities: [ENTITY] },
    });
    expect(liveQuads).toEqual([
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ]);
  });

  it('carries Lift request access policy into resolved publish options', async () => {
    const write = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        swmId: 'swm-main',
        shareOperationId: write.shareOperationId,
        roots: [ENTITY],
        contextGraphId: CONTEXT_GRAPH,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
        accessPolicy: 'allowList',
        allowedPeers: ['peer-a', 'peer-b'],
      },
    });

    expect(resolved.accessPolicy).toBe('allowList');
    expect(resolved.allowedPeers).toEqual(['peer-a', 'peer-b']);
  });

  it('resolves a LiftRequest slice with the renamed fields', async () => {
    const write = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    const resolved = await resolveLiftWorkspaceSlice({
      store,
      graphManager,
      request: {
        swmId: 'swm-main',
        shareOperationId: write.shareOperationId,
        roots: [ENTITY],
        contextGraphId: CONTEXT_GRAPH,
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      },
    });

    expect(resolved.quads).toHaveLength(1);
    expect(resolved.quads[0]?.subject).toBe(ENTITY);
  });

  it('rejects roots not linked to the requested workspace operation', async () => {
    const write = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"One"', graph: '' },
    ], { publisherPeerId: 'peer1' });

    await expect(
      resolveLiftWorkspaceSlice({
        store,
        graphManager,
        request: {
          swmId: 'swm-main',
          shareOperationId: write.shareOperationId,
          roots: [ENTITY_2],
          contextGraphId: CONTEXT_GRAPH,
          namespace: 'aloha',
          scope: 'person-profile',
          transitionType: 'CREATE',
          authority: { type: 'owner', proofRef: 'proof:owner:1' },
        },
      }),
    ).rejects.toThrow(`Lift shared-memory resolution roots are not part of share operation ${write.shareOperationId}`);
  });

  it('rejects unsafe shareOperationId values before querying workspace metadata', async () => {
    await expect(
      resolveLiftWorkspaceSlice({
        store,
        graphManager,
        request: {
          swmId: 'swm-main',
          shareOperationId: 'bad>op',
          roots: [ENTITY],
          contextGraphId: CONTEXT_GRAPH,
          namespace: 'aloha',
          scope: 'person-profile',
          transitionType: 'CREATE',
          authority: { type: 'owner', proofRef: 'proof:owner:1' },
        },
      }),
    ).rejects.toThrow('Shared-memory resolution rejected unsafe shareOperationId: bad>op');
  });
});

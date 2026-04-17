import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import { generateEd25519Keypair } from '@origintrail-official/dkg-core';
import {
  DKGPublisher,
  SharedMemoryHandler,
  StaleWriteError,
  type ShareOptions,
  type ConditionalShareOptions,
} from '../src/index.js';
import { ethers } from 'ethers';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, createTestContextGraph, seedContextGraphRegistration, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

let PARANET = 'test-workspace';
let DATA_GRAPH = `did:dkg:context-graph:${PARANET}`;
let WORKSPACE_GRAPH = `did:dkg:context-graph:${PARANET}/_shared_memory`;
let WORKSPACE_META_GRAPH = `did:dkg:context-graph:${PARANET}/_shared_memory_meta`;
const ENTITY = 'urn:test:entity:1';

function q(s: string, p: string, o: string, g = ''): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

beforeAll(async () => {
  const cgId = await createTestContextGraph();
  PARANET = String(cgId);
  DATA_GRAPH = `did:dkg:context-graph:${PARANET}`;
  WORKSPACE_GRAPH = `did:dkg:context-graph:${PARANET}/_shared_memory`;
  WORKSPACE_META_GRAPH = `did:dkg:context-graph:${PARANET}/_shared_memory_meta`;
});

describe('Workspace: share', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  let _fileSnapshot: string;
  beforeAll(async () => {
    _fileSnapshot = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
  });
  afterAll(async () => {
    await revertSnapshot(_fileSnapshot);
  });

  let _testSnapshot: string;
  beforeEach(async () => {
    _testSnapshot = await takeSnapshot();
    store = new OxigraphStore();
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
  afterEach(async () => {
    await revertSnapshot(_testSnapshot);
  });

  it('stores quads in workspace and workspace_meta, returns encoded message', async () => {
    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"Test"'),
      q(ENTITY, 'http://schema.org/description', '"Workspace draft"'),
    ];
    const opts: ShareOptions = {
      publisherPeerId: '12D3KooWTest',
    };

    const result = await publisher.share(PARANET, quads, opts);

    expect(result.shareOperationId).toMatch(/^swm-\d+-[a-z0-9]+$/);
    expect(result.message).toBeInstanceOf(Uint8Array);
    expect(result.message.length).toBeGreaterThan(0);

    const workspaceResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(workspaceResult.type).toBe('bindings');
    if (workspaceResult.type === 'bindings') {
      expect(workspaceResult.bindings.length).toBe(1);
      expect(workspaceResult.bindings[0]['o']).toBe('"Test"');
    }

    const metaResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> } }`,
    );
    expect(metaResult.type).toBe('bindings');
    if (metaResult.type === 'bindings') {
      expect(metaResult.bindings.length).toBe(1);
    }
  });

  it('allows same creator to upsert an existing workspace entity', async () => {
    const quads1 = [q(ENTITY, 'http://schema.org/name', '"First"')];
    await publisher.share(PARANET, quads1, { publisherPeerId: 'peer1' });

    const quads2 = [q(ENTITY, 'http://schema.org/name', '"Updated by same creator"')];
    await publisher.share(PARANET, quads2, { publisherPeerId: 'peer1' });

    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Updated by same creator"');
    }
  });

  it('rejects write when rootEntity in workspace was created by a different peer (Rule 4)', async () => {
    const quads1 = [q(ENTITY, 'http://schema.org/name', '"First"')];
    await publisher.share(PARANET, quads1, { publisherPeerId: 'peer1' });

    const quads2 = [q(ENTITY, 'http://schema.org/name', '"Second"')];
    await expect(
      publisher.share(PARANET, quads2, { publisherPeerId: 'peer2' }),
    ).rejects.toThrow(/Rule 4|Workspace validation failed/);
  });

  it('rejects write when rootEntity already in data graph (Rule 4)', async () => {
    await publisher.publish({
      contextGraphId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"Published"')],
    });

    const quads = [q(ENTITY, 'http://schema.org/description', '"In workspace"')];
    await expect(
      publisher.share(PARANET, quads, { publisherPeerId: 'peer1' }),
    ).rejects.toThrow(/Rule 4|Workspace validation failed/);
  });

  it('upsert replaces old triples, not appends', async () => {
    await publisher.share(PARANET, [
      q(ENTITY, 'http://schema.org/name', '"Original"'),
      q(ENTITY, 'http://schema.org/description', '"Will be removed"'),
    ], { publisherPeerId: 'peer1' });

    await publisher.share(PARANET, [
      q(ENTITY, 'http://schema.org/name', '"Replaced"'),
    ], { publisherPeerId: 'peer1' });

    const nameResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(nameResult.type).toBe('bindings');
    if (nameResult.type === 'bindings') {
      expect(nameResult.bindings.length).toBe(1);
      expect(nameResult.bindings[0]['o']).toBe('"Replaced"');
    }

    const descResult = await store.query(
      `ASK { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/description> ?o } }`,
    );
    expect(descResult.type).toBe('boolean');
    if (descResult.type === 'boolean') {
      expect(descResult.value).toBe(false);
    }
  });
});

describe('Workspace: publishFromSharedMemory', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;
  let chain: EVMChainAdapter;

  let _fileSnapshot: string;
  beforeAll(async () => {
    _fileSnapshot = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
  });
  afterAll(async () => {
    await revertSnapshot(_fileSnapshot);
  });

  let _testSnapshot: string;
  beforeEach(async () => {
    _testSnapshot = await takeSnapshot();
    store = new OxigraphStore();
    chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    await seedContextGraphRegistration(store, PARANET);
  });
  afterEach(async () => {
    await revertSnapshot(_testSnapshot);
  });

  it('reads workspace and publishes to data graph (selection: all)', async () => {
    const quads = [
      q(ENTITY, 'http://schema.org/name', '"Enshrine Me"'),
      q(ENTITY, 'http://schema.org/description', '"Will be enshrined"'),
    ];
    await publisher.share(PARANET, quads, { publisherPeerId: 'peer1' });

    const result = await publisher.publishFromSharedMemory(PARANET, 'all');

    expect(result.status).toBe('confirmed');
    expect(result.kaManifest.length).toBe(1);
    expect(result.kaManifest[0].rootEntity).toBe(ENTITY);

    const dataResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(dataResult.type).toBe('bindings');
    if (dataResult.type === 'bindings') {
      expect(dataResult.bindings.length).toBe(1);
      expect(dataResult.bindings[0]['o']).toBe('"Enshrine Me"');
    }
  });

  it('enshrine with rootEntities filter only enshrines those entities', async () => {
    const entity1 = 'urn:test:entity:1';
    const entity2 = 'urn:test:entity:2';
    await publisher.share(PARANET, [
      q(entity1, 'http://schema.org/name', '"One"'),
      q(entity2, 'http://schema.org/name', '"Two"'),
    ], { publisherPeerId: 'peer1' });

    const result = await publisher.publishFromSharedMemory(PARANET, {
      rootEntities: [entity1],
    });

    expect(result.kaManifest.length).toBe(1);
    expect(result.kaManifest[0].rootEntity).toBe(entity1);

    const oneInData = await store.query(
      `ASK { GRAPH <${DATA_GRAPH}> { <${entity1}> <http://schema.org/name> ?o } }`,
    );
    expect(oneInData.type).toBe('boolean');
    if (oneInData.type === 'boolean') expect(oneInData.value).toBe(true);

    const twoInWorkspace = await store.query(
      `ASK { GRAPH <${WORKSPACE_GRAPH}> { <${entity2}> <http://schema.org/name> ?o } }`,
    );
    expect(twoInWorkspace.type).toBe('boolean');
    if (twoInWorkspace.type === 'boolean') expect(twoInWorkspace.value).toBe(true);
  });

  it('clearSharedMemoryAfter removes enshrined rootEntities from workspace', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"Clear After"')];
    await publisher.share(PARANET, quads, { publisherPeerId: 'peer1' });

    await publisher.publishFromSharedMemory(PARANET, 'all', {
      clearSharedMemoryAfter: true,
    });

    const stillInWorkspace = await store.query(
      `ASK { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> ?p ?o } }`,
    );
    expect(stillInWorkspace.type).toBe('boolean');
    if (stillInWorkspace.type === 'boolean') expect(stillInWorkspace.value).toBe(false);
  });

  it('throws when workspace is empty for selection', async () => {
    await expect(
      publisher.publishFromSharedMemory(PARANET, 'all'),
    ).rejects.toThrow(/No quads in shared memory/);
  });

  it('escapes backslash and double-quote in rootEntity filter (SPARQL injection prevention)', async () => {
    const entityWithSpecialChars = 'urn:test:entity:with\\"backslash';
    await expect(
      publisher.publishFromSharedMemory(PARANET, {
        rootEntities: [entityWithSpecialChars],
      }),
    ).rejects.toThrow(/No valid rootEntities provided/);
  });

  it('throws distinct error for empty rootEntities array', async () => {
    await expect(
      publisher.publishFromSharedMemory(PARANET, { rootEntities: [] }),
    ).rejects.toThrow(/No rootEntities provided/);
  });

  it('publishFromSharedMemory with contextGraphId remaps quads to context graph URIs', async () => {
    const cgResult = await chain.createOnChainContextGraph({
      participantIdentityIds: [BigInt(getSharedContext().coreProfileId)],
      requiredSignatures: 1,
    });
    const ctxId = String(cgResult.contextGraphId);
    const ctxDataGraph = `did:dkg:context-graph:${PARANET}/context/${ctxId}`;
    const ctxMetaGraph = `did:dkg:context-graph:${PARANET}/context/${ctxId}/_meta`;

    const quads = [
      q(ENTITY, 'http://schema.org/name', '"Context Enshrine"'),
      q(ENTITY, 'http://schema.org/description', '"In context graph"'),
    ];
    await publisher.share(PARANET, quads, { publisherPeerId: 'peer1' });

    const result = await publisher.publishFromSharedMemory(PARANET, 'all', {
      publishContextGraphId: ctxId,
    });

    expect(result.status).toBe('confirmed');

    const dataResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(dataResult.type).toBe('bindings');
    if (dataResult.type === 'bindings') {
      expect(dataResult.bindings.length).toBe(1);
      expect(dataResult.bindings[0]['o']).toBe('"Context Enshrine"');
    }

    const metaResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${ctxMetaGraph}> { ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/KnowledgeAsset> } }`,
    );
    expect(metaResult.type).toBe('bindings');
    if (metaResult.type === 'bindings') {
      expect(metaResult.bindings.length).toBeGreaterThan(0);
    }
  });

  it('publishFromSharedMemory with contextGraphId calls verify', async () => {
    const cgResult = await chain.createOnChainContextGraph({
      participantIdentityIds: [BigInt(getSharedContext().coreProfileId)],
      requiredSignatures: 1,
    });
    const ctxId = String(cgResult.contextGraphId);

    const quads = [q(ENTITY, 'http://schema.org/name', '"Batch Test"')];
    await publisher.share(PARANET, quads, { publisherPeerId: 'peer1' });

    const result = await publisher.publishFromSharedMemory(PARANET, 'all', { publishContextGraphId: ctxId });
    expect(result.status).toBe('confirmed');
  });
});

describe('Workspace: ownership persistence and reconstruction', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  let _fileSnapshot: string;
  beforeAll(async () => {
    _fileSnapshot = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
  });
  afterAll(async () => {
    await revertSnapshot(_fileSnapshot);
  });

  let _testSnapshot: string;
  beforeEach(async () => {
    _testSnapshot = await takeSnapshot();
    store = new OxigraphStore();
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
    await seedContextGraphRegistration(store, PARANET);
  });
  afterEach(async () => {
    await revertSnapshot(_testSnapshot);
  });

  it('persists ownership quads to workspace_meta on share', async () => {
    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"Test"'),
    ];
    await publisher.share(PARANET, quads, { publisherPeerId: '12D3KooWCreator' });

    const result = await store.query(
      `SELECT ?creator WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { <${ENTITY}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['creator']).toBe('"12D3KooWCreator"');
    }
  });

  it('reconstructs sharedMemoryOwnedEntities from persisted ownership triples', async () => {
    await publisher.share(PARANET, [
      q(ENTITY, 'http://schema.org/name', '"First"'),
    ], { publisherPeerId: 'peerA' });

    const entity2 = 'urn:test:entity:2';
    await publisher.share(PARANET, [
      q(entity2, 'http://schema.org/name', '"Second"'),
    ], { publisherPeerId: 'peerB' });

    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const freshOwned = new Map<string, Map<string, string>>();
    const freshPublisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      sharedMemoryOwnedEntities: freshOwned,
    });

    const count = await freshPublisher.reconstructWorkspaceOwnership();
    expect(count).toBe(2);
    expect(freshOwned.get(PARANET)?.get(ENTITY)).toBe('peerA');
    expect(freshOwned.get(PARANET)?.get(entity2)).toBe('peerB');
  });

  it('clears ownership quads on publishFromSharedMemory with clearSharedMemoryAfter', async () => {
    await publisher.share(PARANET, [
      q(ENTITY, 'http://schema.org/name', '"Enshrine"'),
    ], { publisherPeerId: 'peer1' });

    await publisher.publishFromSharedMemory(PARANET, 'all', { clearSharedMemoryAfter: true });

    const result = await store.query(
      `ASK { GRAPH <${WORKSPACE_META_GRAPH}> { <${ENTITY}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') {
      expect(result.value).toBe(false);
    }
  });

  it('does not create duplicate ownership quads on upsert by same creator', async () => {
    await publisher.share(PARANET, [
      q(ENTITY, 'http://schema.org/name', '"First"'),
    ], { publisherPeerId: 'peer1' });

    await publisher.share(PARANET, [
      q(ENTITY, 'http://schema.org/name', '"Updated"'),
    ], { publisherPeerId: 'peer1' });

    const result = await store.query(
      `SELECT ?creator WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { <${ENTITY}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
    }
  });
});

describe('SharedMemoryHandler', () => {
  let store: OxigraphStore;
  let handler: SharedMemoryHandler;
  let workspaceOwned: Map<string, Map<string, string>>;

  beforeEach(async () => {
    store = new OxigraphStore();
    workspaceOwned = new Map();
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
    });
  });

  it('stores valid workspace message to workspace and workspace_meta', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const nquads = `<${ENTITY}> <http://schema.org/name> "Handler Test" <${DATA_GRAPH}> .`;
    const msg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(nquads),
      manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'ws-handler-1',
      timestampMs: Date.now(),
    });

    await handler.handle(msg, '12D3KooWPeer');

    const gm = new GraphManager(store);
    await gm.ensureContextGraph(PARANET);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Handler Test"');
    }
    expect(workspaceOwned.get(PARANET)?.has(ENTITY)).toBe(true);
  });

  it('rejects message when rootEntity was created by a different peer (Rule 4)', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    workspaceOwned.set(PARANET, new Map([[ENTITY, 'otherPeer']]));

    const nquads = `<${ENTITY}> <http://schema.org/name> "Duplicate" <${DATA_GRAPH}> .`;
    const msg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(nquads),
      manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'ws-dup',
      timestampMs: Date.now(),
    });

    await handler.handle(msg, '12D3KooWPeer');

    const gm = new GraphManager(store);
    await gm.ensureContextGraph(PARANET);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const askResult = await store.query(
      `ASK { GRAPH <${wsGraph}> { <${ENTITY}> ?p ?o } }`,
    );
    expect(askResult.type).toBe('boolean');
    if (askResult.type === 'boolean') {
      expect(askResult.value).toBe(false);
    }
  });

  it('allows same creator to upsert via gossip handler', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const peerId = '12D3KooWSameCreator';

    const msg1 = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "Original" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-1',
      timestampMs: Date.now(),
    });
    await handler.handle(msg1, peerId);

    const msg2 = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "Updated" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-2',
      timestampMs: Date.now(),
    });
    await handler.handle(msg2, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Updated"');
    }
  });

  it('persists ownership triples and does not duplicate on same-creator upsert', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const peerId = '12D3KooWOwner';

    const msg1 = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "First" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-own-1',
      timestampMs: Date.now(),
    });
    await handler.handle(msg1, peerId);

    const gm = new GraphManager(store);
    const wsMetaGraph = gm.workspaceMetaGraphUri(PARANET);
    const afterFirst = await store.query(
      `SELECT ?creator WHERE { GRAPH <${wsMetaGraph}> { <${ENTITY}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(afterFirst.type).toBe('bindings');
    if (afterFirst.type === 'bindings') {
      expect(afterFirst.bindings.length).toBe(1);
      expect(afterFirst.bindings[0]['creator']).toBe(`"${peerId}"`);
    }

    const msg2 = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "Updated" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-own-2',
      timestampMs: Date.now(),
    });
    await handler.handle(msg2, peerId);

    const afterSecond = await store.query(
      `SELECT ?creator WHERE { GRAPH <${wsMetaGraph}> { <${ENTITY}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(afterSecond.type).toBe('bindings');
    if (afterSecond.type === 'bindings') {
      expect(afterSecond.bindings.length).toBe(1);
      expect(afterSecond.bindings[0]['creator']).toBe(`"${peerId}"`);
    }
  });
});

describe('SharedMemoryHandler: CAS gossip enforcement', () => {
  let store: OxigraphStore;
  let handler: SharedMemoryHandler;
  let workspaceOwned: Map<string, Map<string, string>>;

  beforeEach(async () => {
    store = new OxigraphStore();
    workspaceOwned = new Map();
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
    });
  });

  it('rejects CAS conditions with SPARQL injection in subject', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const peerId = '12D3KooWPeer';
    const safeEntity = 'urn:test:safe-entity';
    const nquads = `<${safeEntity}> <http://schema.org/name> "Test" <${DATA_GRAPH}> .`;

    const msg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(nquads),
      manifest: [{ rootEntity: safeEntity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-inject-1',
      timestampMs: Date.now(),
      casConditions: [{
        subject: 'urn:x> } } . DROP ALL #<urn:y',
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
        expectAbsent: false,
      }],
    });

    await handler.handle(msg, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `ASK { GRAPH <${wsGraph}> { <${safeEntity}> ?p ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(false);
  });

  it('rejects CAS conditions with SPARQL injection in expectedValue', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const peerId = '12D3KooWPeer';
    const safeEntity = 'urn:test:safe-entity2';

    // First write so the entity exists
    const setupMsg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${safeEntity}> <http://schema.org/name> "Setup" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: safeEntity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-setup',
      timestampMs: Date.now(),
    });
    await handler.handle(setupMsg, peerId);

    const nquads = `<${safeEntity}> <http://schema.org/name> "Updated" <${DATA_GRAPH}> .`;
    const msg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(nquads),
      manifest: [{ rootEntity: safeEntity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-inject-2',
      timestampMs: Date.now(),
      casConditions: [{
        subject: safeEntity,
        predicate: 'http://schema.org/name',
        expectedValue: '"Setup" } } . DROP ALL #',
        expectAbsent: false,
      }],
    });

    await handler.handle(msg, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${safeEntity}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Setup"');
    }
  });

  it('accepts valid CAS conditions and enforces them', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:cas-valid';

    const setupMsg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "recruiting" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: entity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-cas-setup',
      timestampMs: Date.now(),
    });
    await handler.handle(setupMsg, peerId);

    const updateMsg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "traveling" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: entity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-cas-update',
      timestampMs: Date.now(),
      casConditions: [{
        subject: entity,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
        expectAbsent: false,
      }],
    });
    await handler.handle(updateMsg, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${entity}> <http://example.org/status> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"traveling"');
    }
  });

  it('rejects write when CAS condition value mismatches', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:cas-mismatch';

    const setupMsg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "traveling" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: entity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-mismatch-setup',
      timestampMs: Date.now(),
    });
    await handler.handle(setupMsg, peerId);

    const updateMsg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "arrived" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: entity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-mismatch-update',
      timestampMs: Date.now(),
      casConditions: [{
        subject: entity,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
        expectAbsent: false,
      }],
    });
    await handler.handle(updateMsg, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${entity}> <http://example.org/status> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"traveling"');
    }
  });

  it('expectAbsent: allows write when triple does not exist', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:absent-pass';

    const msg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "recruiting" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: entity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-absent-pass',
      timestampMs: Date.now(),
      casConditions: [{
        subject: entity,
        predicate: 'http://example.org/status',
        expectedValue: '',
        expectAbsent: true,
      }],
    });
    await handler.handle(msg, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `ASK { GRAPH <${wsGraph}> { <${entity}> <http://example.org/status> ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(true);
  });

  it('expectAbsent: rejects write when triple already exists', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:absent-fail';

    const setupMsg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "recruiting" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: entity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-absent-setup',
      timestampMs: Date.now(),
    });
    await handler.handle(setupMsg, peerId);

    const updateMsg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "traveling" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: entity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-absent-reject',
      timestampMs: Date.now(),
      casConditions: [{
        subject: entity,
        predicate: 'http://example.org/status',
        expectedValue: '',
        expectAbsent: true,
      }],
    });
    await handler.handle(updateMsg, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${entity}> <http://example.org/status> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"recruiting"');
    }
  });

  it('rejects non-absent CAS condition with empty expectedValue (protobuf default)', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:empty-expected';

    const setupMsg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${entity}> <http://schema.org/name> "Setup" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: entity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-empty-setup',
      timestampMs: Date.now(),
    });
    await handler.handle(setupMsg, peerId);

    const updateMsg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${entity}> <http://schema.org/name> "Updated" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: entity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-empty-update',
      timestampMs: Date.now(),
      casConditions: [{
        subject: entity,
        predicate: 'http://schema.org/name',
        expectedValue: '',
        expectAbsent: false,
      }],
    });
    await handler.handle(updateMsg, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${entity}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Setup"');
    }
  });
});

describe('Workspace: conditionalShare (CAS)', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
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

  it('succeeds when condition matches current value', async () => {
    const initial = [q(ENTITY, 'http://example.org/status', '"recruiting"')];
    await publisher.share(PARANET, initial, { publisherPeerId: 'peer1' });

    const updated = [q(ENTITY, 'http://example.org/status', '"traveling"')];
    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
      }],
    };

    const result = await publisher.conditionalShare(PARANET, updated, opts);
    expect(result.shareOperationId).toBeTruthy();

    const check = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://example.org/status> ?o } }`,
    );
    expect(check.type).toBe('bindings');
    if (check.type === 'bindings') {
      expect(check.bindings[0].o).toBe('"traveling"');
    }
  });

  it('throws StaleWriteError when condition does not match', async () => {
    const initial = [q(ENTITY, 'http://example.org/status', '"traveling"')];
    await publisher.share(PARANET, initial, { publisherPeerId: 'peer1' });

    const updated = [q(ENTITY, 'http://example.org/status', '"traveling"')];
    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
      }],
    };

    await expect(publisher.conditionalShare(PARANET, updated, opts))
      .rejects.toThrow(StaleWriteError);
  });

  it('throws StaleWriteError when expecting absent but triple exists', async () => {
    const initial = [q(ENTITY, 'http://example.org/status', '"recruiting"')];
    await publisher.share(PARANET, initial, { publisherPeerId: 'peer1' });

    const newQuads = [q(ENTITY, 'http://example.org/status', '"recruiting"')];
    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: null,
      }],
    };

    await expect(publisher.conditionalShare(PARANET, newQuads, opts))
      .rejects.toThrow(StaleWriteError);
  });

  it('succeeds when expecting absent and triple does not exist', async () => {
    const quads = [q(ENTITY, 'http://example.org/status', '"recruiting"')];
    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: null,
      }],
    };

    const result = await publisher.conditionalShare(PARANET, quads, opts);
    expect(result.shareOperationId).toBeTruthy();
  });

  it('StaleWriteError includes condition and actual value', async () => {
    const initial = [q(ENTITY, 'http://example.org/status', '"traveling"')];
    await publisher.share(PARANET, initial, { publisherPeerId: 'peer1' });

    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
      }],
    };

    try {
      await publisher.conditionalShare(PARANET, [q(ENTITY, 'http://example.org/status', '"traveling"')], opts);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StaleWriteError);
      const e = err as InstanceType<typeof StaleWriteError>;
      expect(e.condition.subject).toBe(ENTITY);
      expect(e.condition.predicate).toBe('http://example.org/status');
      expect(e.condition.expectedValue).toBe('"recruiting"');
      expect(e.actualValue).not.toBeNull();
    }
  });

  it('supports multiple conditions (all must pass)', async () => {
    const initial = [
      q(ENTITY, 'http://example.org/status', '"recruiting"'),
      q(ENTITY, 'http://example.org/turn', '"1"^^<http://www.w3.org/2001/XMLSchema#integer>'),
    ];
    await publisher.share(PARANET, initial, { publisherPeerId: 'peer1' });

    const updated = [
      q(ENTITY, 'http://example.org/status', '"traveling"'),
      q(ENTITY, 'http://example.org/turn', '"2"^^<http://www.w3.org/2001/XMLSchema#integer>'),
    ];
    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [
        { subject: ENTITY, predicate: 'http://example.org/status', expectedValue: '"recruiting"' },
        { subject: ENTITY, predicate: 'http://example.org/turn', expectedValue: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' },
      ],
    };

    const result = await publisher.conditionalShare(PARANET, updated, opts);
    expect(result.shareOperationId).toBeTruthy();
  });

  it('fails if any one of multiple conditions mismatches', async () => {
    const initial = [
      q(ENTITY, 'http://example.org/status', '"recruiting"'),
      q(ENTITY, 'http://example.org/turn', '"5"^^<http://www.w3.org/2001/XMLSchema#integer>'),
    ];
    await publisher.share(PARANET, initial, { publisherPeerId: 'peer1' });

    const updated = [q(ENTITY, 'http://example.org/status', '"traveling"')];
    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [
        { subject: ENTITY, predicate: 'http://example.org/status', expectedValue: '"recruiting"' },
        { subject: ENTITY, predicate: 'http://example.org/turn', expectedValue: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' },
      ],
    };

    await expect(publisher.conditionalShare(PARANET, updated, opts))
      .rejects.toThrow(StaleWriteError);
  });

  it('rejects unsafe RDF terms in expectedValue (SPARQL injection)', async () => {
    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting" } } . DROP ALL #',
      }],
    };
    await expect(publisher.conditionalShare(PARANET, [], opts))
      .rejects.toThrow('Unsafe RDF term');
  });

  it('accepts valid RDF literal and IRI terms', async () => {
    await publisher.share(PARANET, [
      q(ENTITY, 'http://example.org/status', '"recruiting"'),
    ], { publisherPeerId: 'peer1' });

    const literalOpts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
      }],
    };
    await expect(publisher.conditionalShare(PARANET, [], literalOpts))
      .resolves.toBeDefined();
  });

  it('serializes concurrent CAS writes to the same subject+predicate', async () => {
    await publisher.share(PARANET, [
      q(ENTITY, 'http://example.org/counter', '"1"^^<http://www.w3.org/2001/XMLSchema#integer>'),
    ], { publisherPeerId: 'peer1' });

    const write1 = publisher.conditionalShare(PARANET, [
      q(ENTITY, 'http://example.org/counter', '"2"^^<http://www.w3.org/2001/XMLSchema#integer>'),
    ], {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/counter',
        expectedValue: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
      }],
    });

    const write2 = publisher.conditionalShare(PARANET, [
      q(ENTITY, 'http://example.org/counter', '"3"^^<http://www.w3.org/2001/XMLSchema#integer>'),
    ], {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/counter',
        expectedValue: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
      }],
    });

    const results = await Promise.allSettled([write1, write2]);
    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleWriteError);
  });
});

describe('SharedMemoryHandler: CAS edge cases', () => {
  let store: OxigraphStore;
  let handler: SharedMemoryHandler;
  let workspaceOwned: Map<string, Map<string, string>>;

  beforeEach(async () => {
    store = new OxigraphStore();
    workspaceOwned = new Map();
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
    });
  });

  it('rejects CAS conditions with SPARQL injection in predicate', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:inject-pred';
    const nquads = `<${entity}> <http://schema.org/name> "Test" <${DATA_GRAPH}> .`;

    const msg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(nquads),
      manifest: [{ rootEntity: entity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-inject-pred',
      timestampMs: Date.now(),
      casConditions: [{
        subject: entity,
        predicate: 'http://example.org/status> } } . DROP ALL #<http://x',
        expectedValue: '"recruiting"',
        expectAbsent: false,
      }],
    });

    await handler.handle(msg, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `ASK { GRAPH <${wsGraph}> { <${entity}> ?p ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(false);
  });

  it('cross-subject CAS: condition on subject A, write targets subject B — lock covers both', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const peerId = '12D3KooWPeer';
    const subjectA = 'urn:test:lock-a';
    const subjectB = 'urn:test:lock-b';

    const setupA = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${subjectA}> <http://example.org/status> "active" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: subjectA, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-lock-setup-a',
      timestampMs: Date.now(),
    });
    await handler.handle(setupA, peerId);

    const writeB = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${subjectB}> <http://example.org/name> "Created conditionally" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: subjectB, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-lock-write-b',
      timestampMs: Date.now(),
      casConditions: [{
        subject: subjectA,
        predicate: 'http://example.org/status',
        expectedValue: '"active"',
        expectAbsent: false,
      }],
    });
    await handler.handle(writeB, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `ASK { GRAPH <${wsGraph}> { <${subjectB}> <http://example.org/name> ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(true);
  });

  it('cross-subject CAS: rejects when condition on subject A fails', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const peerId = '12D3KooWPeer';
    const subjectA = 'urn:test:lock-a2';
    const subjectB = 'urn:test:lock-b2';

    const setupA = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${subjectA}> <http://example.org/status> "inactive" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: subjectA, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-lock-setup-a2',
      timestampMs: Date.now(),
    });
    await handler.handle(setupA, peerId);

    const writeB = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${subjectB}> <http://example.org/name> "Should not appear" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: subjectB, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-lock-write-b2',
      timestampMs: Date.now(),
      casConditions: [{
        subject: subjectA,
        predicate: 'http://example.org/status',
        expectedValue: '"active"',
        expectAbsent: false,
      }],
    });
    await handler.handle(writeB, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `ASK { GRAPH <${wsGraph}> { <${subjectB}> ?p ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(false);
  });

  it('multiple gossip CAS conditions: rejects if any single condition fails', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:multi-cond';

    const setup = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(
        `<${entity}> <http://example.org/status> "recruiting" <${DATA_GRAPH}> .\n` +
        `<${entity}> <http://example.org/turn> "5"^^<http://www.w3.org/2001/XMLSchema#integer> <${DATA_GRAPH}> .`,
      ),
      manifest: [{ rootEntity: entity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-multi-setup',
      timestampMs: Date.now(),
    });
    await handler.handle(setup, peerId);

    const update = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "traveling" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: entity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-multi-update',
      timestampMs: Date.now(),
      casConditions: [
        { subject: entity, predicate: 'http://example.org/status', expectedValue: '"recruiting"', expectAbsent: false },
        { subject: entity, predicate: 'http://example.org/turn', expectedValue: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', expectAbsent: false },
      ],
    });
    await handler.handle(update, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${entity}> <http://example.org/status> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"recruiting"');
    }
  });

  it('gossip CAS with typed literal (xsd:integer) succeeds when match', async () => {
    const { encodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:typed-lit';

    const setup = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(
        `<${entity}> <http://example.org/turn> "1"^^<http://www.w3.org/2001/XMLSchema#integer> <${DATA_GRAPH}> .`,
      ),
      manifest: [{ rootEntity: entity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-typed-setup',
      timestampMs: Date.now(),
    });
    await handler.handle(setup, peerId);

    const update = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(
        `<${entity}> <http://example.org/turn> "2"^^<http://www.w3.org/2001/XMLSchema#integer> <${DATA_GRAPH}> .`,
      ),
      manifest: [{ rootEntity: entity, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-typed-update',
      timestampMs: Date.now(),
      casConditions: [{
        subject: entity,
        predicate: 'http://example.org/turn',
        expectedValue: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
        expectAbsent: false,
      }],
    });
    await handler.handle(update, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${entity}> <http://example.org/turn> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"2"^^<http://www.w3.org/2001/XMLSchema#integer>');
    }
  });
});

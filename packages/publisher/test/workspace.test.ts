import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@dkg/storage';
import { GraphManager } from '@dkg/storage';
import { MockChainAdapter } from '@dkg/chain';
import { TypedEventBus } from '@dkg/core';
import { generateEd25519Keypair } from '@dkg/core';
import {
  DKGPublisher,
  WorkspaceHandler,
  type WriteToWorkspaceOptions,
} from '../src/index.js';
import { ethers } from 'ethers';

const PARANET = 'test-workspace';
const DATA_GRAPH = `did:dkg:paranet:${PARANET}`;
const WORKSPACE_GRAPH = `did:dkg:paranet:${PARANET}/_workspace`;
const WORKSPACE_META_GRAPH = `did:dkg:paranet:${PARANET}/_workspace_meta`;
const ENTITY = 'urn:test:entity:1';

function q(s: string, p: string, o: string, g = ''): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('Workspace: writeToWorkspace', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;
  const wallet = ethers.Wallet.createRandom();

  beforeEach(async () => {
    store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });
  });

  it('stores quads in workspace and workspace_meta, returns encoded message', async () => {
    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"Test"'),
      q(ENTITY, 'http://schema.org/description', '"Workspace draft"'),
    ];
    const opts: WriteToWorkspaceOptions = {
      publisherPeerId: '12D3KooWTest',
    };

    const result = await publisher.writeToWorkspace(PARANET, quads, opts);

    expect(result.workspaceOperationId).toMatch(/^ws-\d+-[a-z0-9]+$/);
    expect(result.message).toBeInstanceOf(Uint8Array);
    expect(result.message.length).toBeGreaterThan(0);

    const workspaceResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(workspaceResult.type).toBe('bindings');
    if (workspaceResult.type === 'bindings') {
      expect(workspaceResult.bindings.length).toBe(1);
      expect(workspaceResult.bindings[0]['o']).toContain('Test');
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
    await publisher.writeToWorkspace(PARANET, quads1, { publisherPeerId: 'peer1' });

    const quads2 = [q(ENTITY, 'http://schema.org/name', '"Updated by same creator"')];
    await publisher.writeToWorkspace(PARANET, quads2, { publisherPeerId: 'peer1' });

    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toContain('Updated by same creator');
    }
  });

  it('rejects write when rootEntity in workspace was created by a different peer (Rule 4)', async () => {
    const quads1 = [q(ENTITY, 'http://schema.org/name', '"First"')];
    await publisher.writeToWorkspace(PARANET, quads1, { publisherPeerId: 'peer1' });

    const quads2 = [q(ENTITY, 'http://schema.org/name', '"Second"')];
    await expect(
      publisher.writeToWorkspace(PARANET, quads2, { publisherPeerId: 'peer2' }),
    ).rejects.toThrow(/Rule 4|Workspace validation failed/);
  });

  it('rejects write when rootEntity already in data graph (Rule 4)', async () => {
    await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"Published"')],
    });

    const quads = [q(ENTITY, 'http://schema.org/description', '"In workspace"')];
    await expect(
      publisher.writeToWorkspace(PARANET, quads, { publisherPeerId: 'peer1' }),
    ).rejects.toThrow(/Rule 4|Workspace validation failed/);
  });

  it('upsert replaces old triples, not appends', async () => {
    await publisher.writeToWorkspace(PARANET, [
      q(ENTITY, 'http://schema.org/name', '"Original"'),
      q(ENTITY, 'http://schema.org/description', '"Will be removed"'),
    ], { publisherPeerId: 'peer1' });

    await publisher.writeToWorkspace(PARANET, [
      q(ENTITY, 'http://schema.org/name', '"Replaced"'),
    ], { publisherPeerId: 'peer1' });

    const nameResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(nameResult.type).toBe('bindings');
    if (nameResult.type === 'bindings') {
      expect(nameResult.bindings.length).toBe(1);
      expect(nameResult.bindings[0]['o']).toContain('Replaced');
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

describe('Workspace: enshrineFromWorkspace', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;
  const wallet = ethers.Wallet.createRandom();

  beforeEach(async () => {
    store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });
  });

  it('reads workspace and publishes to data graph (selection: all)', async () => {
    const quads = [
      q(ENTITY, 'http://schema.org/name', '"Enshrine Me"'),
      q(ENTITY, 'http://schema.org/description', '"Will be enshrined"'),
    ];
    await publisher.writeToWorkspace(PARANET, quads, { publisherPeerId: 'peer1' });

    const result = await publisher.enshrineFromWorkspace(PARANET, 'all');

    expect(result.status).toBe('confirmed');
    expect(result.kaManifest.length).toBe(1);
    expect(result.kaManifest[0].rootEntity).toBe(ENTITY);

    const dataResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(dataResult.type).toBe('bindings');
    if (dataResult.type === 'bindings') {
      expect(dataResult.bindings.length).toBe(1);
      expect(dataResult.bindings[0]['o']).toContain('Enshrine Me');
    }
  });

  it('enshrine with rootEntities filter only enshrines those entities', async () => {
    const entity1 = 'urn:test:entity:1';
    const entity2 = 'urn:test:entity:2';
    await publisher.writeToWorkspace(PARANET, [
      q(entity1, 'http://schema.org/name', '"One"'),
      q(entity2, 'http://schema.org/name', '"Two"'),
    ], { publisherPeerId: 'peer1' });

    const result = await publisher.enshrineFromWorkspace(PARANET, {
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

  it('clearWorkspaceAfter removes enshrined rootEntities from workspace', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"Clear After"')];
    await publisher.writeToWorkspace(PARANET, quads, { publisherPeerId: 'peer1' });

    await publisher.enshrineFromWorkspace(PARANET, 'all', {
      clearWorkspaceAfter: true,
    });

    const stillInWorkspace = await store.query(
      `ASK { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> ?p ?o } }`,
    );
    expect(stillInWorkspace.type).toBe('boolean');
    if (stillInWorkspace.type === 'boolean') expect(stillInWorkspace.value).toBe(false);
  });

  it('throws when workspace is empty for selection', async () => {
    await expect(
      publisher.enshrineFromWorkspace(PARANET, 'all'),
    ).rejects.toThrow(/No quads in workspace/);
  });

  it('escapes backslash and double-quote in rootEntity filter (SPARQL injection prevention)', async () => {
    // rootEntity containing \" must not break SPARQL query construction
    const entityWithSpecialChars = 'urn:test:entity:with\\"backslash';
    await expect(
      publisher.enshrineFromWorkspace(PARANET, {
        rootEntities: [entityWithSpecialChars],
      }),
    ).rejects.toThrow(/No quads in workspace/);
    // If escaping were wrong, we would get a SPARQL parse error instead
  });
});

describe('Workspace: ownership persistence and reconstruction', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;
  const wallet = ethers.Wallet.createRandom();

  beforeEach(async () => {
    store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });
  });

  it('persists ownership quads to workspace_meta on writeToWorkspace', async () => {
    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"Test"'),
    ];
    await publisher.writeToWorkspace(PARANET, quads, { publisherPeerId: '12D3KooWCreator' });

    const result = await store.query(
      `SELECT ?creator WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { <${ENTITY}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['creator']).toContain('12D3KooWCreator');
    }
  });

  it('reconstructs workspaceOwnedEntities from persisted ownership triples', async () => {
    await publisher.writeToWorkspace(PARANET, [
      q(ENTITY, 'http://schema.org/name', '"First"'),
    ], { publisherPeerId: 'peerA' });

    const entity2 = 'urn:test:entity:2';
    await publisher.writeToWorkspace(PARANET, [
      q(entity2, 'http://schema.org/name', '"Second"'),
    ], { publisherPeerId: 'peerB' });

    // Create a fresh publisher with a new empty map
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();
    const freshOwned = new Map<string, Map<string, string>>();
    const freshPublisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
      workspaceOwnedEntities: freshOwned,
    });

    const count = await freshPublisher.reconstructWorkspaceOwnership();
    expect(count).toBe(2);
    expect(freshOwned.get(PARANET)?.get(ENTITY)).toBe('peerA');
    expect(freshOwned.get(PARANET)?.get(entity2)).toBe('peerB');
  });

  it('clears ownership quads on enshrineFromWorkspace with clearWorkspaceAfter', async () => {
    await publisher.writeToWorkspace(PARANET, [
      q(ENTITY, 'http://schema.org/name', '"Enshrine"'),
    ], { publisherPeerId: 'peer1' });

    await publisher.enshrineFromWorkspace(PARANET, 'all', { clearWorkspaceAfter: true });

    const result = await store.query(
      `ASK { GRAPH <${WORKSPACE_META_GRAPH}> { <${ENTITY}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') {
      expect(result.value).toBe(false);
    }
  });

  it('does not create duplicate ownership quads on upsert by same creator', async () => {
    await publisher.writeToWorkspace(PARANET, [
      q(ENTITY, 'http://schema.org/name', '"First"'),
    ], { publisherPeerId: 'peer1' });

    await publisher.writeToWorkspace(PARANET, [
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

describe('WorkspaceHandler', () => {
  let store: OxigraphStore;
  let handler: WorkspaceHandler;
  let workspaceOwned: Map<string, Map<string, string>>;

  beforeEach(async () => {
    store = new OxigraphStore();
    workspaceOwned = new Map();
    handler = new WorkspaceHandler(store, new TypedEventBus(), {
      workspaceOwnedEntities: workspaceOwned,
    });
  });

  it('stores valid workspace message to workspace and workspace_meta', async () => {
    const { encodeWorkspacePublishRequest } = await import('@dkg/core');
    const nquads = `<${ENTITY}> <http://schema.org/name> "Handler Test" <${DATA_GRAPH}> .`;
    const msg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(nquads),
      manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeer',
      workspaceOperationId: 'ws-handler-1',
      timestampMs: Date.now(),
    });

    await handler.handle(msg, '12D3KooWPeer');

    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toContain('Handler Test');
    }
    expect(workspaceOwned.get(PARANET)?.has(ENTITY)).toBe(true);
  });

  it('rejects message when rootEntity was created by a different peer (Rule 4)', async () => {
    const { encodeWorkspacePublishRequest } = await import('@dkg/core');
    workspaceOwned.set(PARANET, new Map([[ENTITY, 'otherPeer']]));

    const nquads = `<${ENTITY}> <http://schema.org/name> "Duplicate" <${DATA_GRAPH}> .`;
    const msg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(nquads),
      manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeer',
      workspaceOperationId: 'ws-dup',
      timestampMs: Date.now(),
    });

    await handler.handle(msg, '12D3KooWPeer');

    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);
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
    const { encodeWorkspacePublishRequest } = await import('@dkg/core');
    const peerId = '12D3KooWSameCreator';

    const msg1 = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "Original" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      workspaceOperationId: 'ws-1',
      timestampMs: Date.now(),
    });
    await handler.handle(msg1, peerId);

    const msg2 = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "Updated" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      workspaceOperationId: 'ws-2',
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
      expect(result.bindings[0]['o']).toContain('Updated');
    }
  });

  it('persists ownership triples and does not duplicate on same-creator upsert', async () => {
    const { encodeWorkspacePublishRequest } = await import('@dkg/core');
    const peerId = '12D3KooWOwner';

    const msg1 = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "First" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      workspaceOperationId: 'ws-own-1',
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
      expect(afterFirst.bindings[0]['creator']).toContain(peerId);
    }

    const msg2 = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "Updated" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
      publisherPeerId: peerId,
      workspaceOperationId: 'ws-own-2',
      timestampMs: Date.now(),
    });
    await handler.handle(msg2, peerId);

    const afterSecond = await store.query(
      `SELECT ?creator WHERE { GRAPH <${wsMetaGraph}> { <${ENTITY}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(afterSecond.type).toBe('bindings');
    if (afterSecond.type === 'bindings') {
      expect(afterSecond.bindings.length).toBe(1);
      expect(afterSecond.bindings[0]['creator']).toContain(peerId);
    }
  });
});

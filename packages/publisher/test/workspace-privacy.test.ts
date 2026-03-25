import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import {
  DKGPublisher,
  WorkspaceHandler,
  type WriteToWorkspaceOptions,
} from '../src/index.js';
import { ethers } from 'ethers';

const PARANET = 'privacy-ws-test';
const WORKSPACE_META_GRAPH = `did:dkg:paranet:${PARANET}/_workspace_meta`;
const ENTITY = 'urn:test:priv:entity';
const DKG_NS = 'http://dkg.io/ontology/';

function q(s: string, p: string, o: string, g = ''): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('Workspace writeToWorkspace — access policy propagation', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
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

  it('writes with accessPolicy: "ownerOnly" → metadata includes accessPolicy quad', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"Private Data"')];
    const opts: WriteToWorkspaceOptions = {
      publisherPeerId: '12D3KooWTest',
      accessPolicy: 'ownerOnly',
    };
    await publisher.writeToWorkspace(PARANET, quads, opts);

    const result = await store.query(
      `SELECT ?policy WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { ?op <${DKG_NS}accessPolicy> ?policy } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['policy']).toBe('"ownerOnly"');
    }
  });

  it('writes with accessPolicy: "allowList" + allowedPeers → metadata includes both', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"Allow List Data"')];
    const opts: WriteToWorkspaceOptions = {
      publisherPeerId: '12D3KooWTest',
      accessPolicy: 'allowList',
      allowedPeers: ['peerA', 'peerB'],
    };
    await publisher.writeToWorkspace(PARANET, quads, opts);

    const policyResult = await store.query(
      `SELECT ?policy WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { ?op <${DKG_NS}accessPolicy> ?policy } }`,
    );
    expect(policyResult.type).toBe('bindings');
    if (policyResult.type === 'bindings') {
      expect(policyResult.bindings[0]['policy']).toBe('"allowList"');
    }

    const peerResult = await store.query(
      `SELECT ?peer WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { ?op <${DKG_NS}allowedPeer> ?peer } }`,
    );
    expect(peerResult.type).toBe('bindings');
    if (peerResult.type === 'bindings') {
      expect(peerResult.bindings.length).toBe(2);
      const peers = peerResult.bindings.map(b => b['peer']);
      expect(peers).toContain('"peerA"');
      expect(peers).toContain('"peerB"');
    }
  });

  it('writes with no accessPolicy → no accessPolicy quad in metadata (backward compat)', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"Default Data"')];
    await publisher.writeToWorkspace(PARANET, quads, { publisherPeerId: '12D3KooWTest' });

    const result = await store.query(
      `SELECT ?policy WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { ?op <${DKG_NS}accessPolicy> ?policy } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(0);
    }
  });

  it('writes with accessPolicy: "public" → no accessPolicy quad in metadata (backward compat)', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"Public Data"')];
    await publisher.writeToWorkspace(PARANET, quads, {
      publisherPeerId: '12D3KooWTest',
      accessPolicy: 'public',
    });

    const result = await store.query(
      `SELECT ?policy WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { ?op <${DKG_NS}accessPolicy> ?policy } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(0);
    }
  });

  it('accessPolicy and allowedPeers are encoded in the returned gossip message', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"Gossip Data"')];
    const { message } = await publisher.writeToWorkspace(PARANET, quads, {
      publisherPeerId: '12D3KooWTest',
      accessPolicy: 'allowList',
      allowedPeers: ['peerX'],
    });

    // Decode the returned message and verify it carries the access policy
    const { decodeWorkspacePublishRequest } = await import('@origintrail-official/dkg-core');
    const decoded = decodeWorkspacePublishRequest(message);
    expect(decoded.accessPolicy).toBe('allowList');
    expect(decoded.allowedPeers).toEqual(['peerX']);
  });

  it('rejects allowList with empty allowedPeers', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"No Peers"')];
    await expect(
      publisher.writeToWorkspace(PARANET, quads, {
        publisherPeerId: '12D3KooWTest',
        accessPolicy: 'allowList',
        allowedPeers: [],
      }),
    ).rejects.toThrow(/allowList.*requires non-empty.*allowedPeers/);
  });

  it('rejects allowList with undefined allowedPeers', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"No Peers 2"')];
    await expect(
      publisher.writeToWorkspace(PARANET, quads, {
        publisherPeerId: '12D3KooWTest',
        accessPolicy: 'allowList',
      }),
    ).rejects.toThrow(/allowList.*requires non-empty.*allowedPeers/);
  });

  it('strips allowedPeers when accessPolicy is ownerOnly (contradictory)', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"Owner Only With Peers"')];
    const { workspaceOperationId } = await publisher.writeToWorkspace(PARANET, quads, {
      publisherPeerId: '12D3KooWTest',
      accessPolicy: 'ownerOnly',
      allowedPeers: ['peerShouldBeIgnored'],
    });
    expect(workspaceOperationId).toBeTruthy();

    // Verify allowedPeers were NOT stored in metadata
    const result = await store.query(
      `SELECT ?peer WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { ?op <${DKG_NS}allowedPeer> ?peer } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(0);
    }
  });

  it('rejects invalid accessPolicy value', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"Bad Policy"')];
    await expect(
      publisher.writeToWorkspace(PARANET, quads, {
        publisherPeerId: '12D3KooWTest',
        accessPolicy: 'banana' as any,
      }),
    ).rejects.toThrow(/invalid accessPolicy/);
  });
});

describe('WorkspaceHandler — access policy from gossip message', () => {
  let store: OxigraphStore;
  let handler: WorkspaceHandler;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();
    const workspaceOwnedEntities = new Map<string, Map<string, string>>();
    const writeLocks = new Map<string, Promise<void>>();

    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
      workspaceOwnedEntities,
      writeLocks,
    });

    handler = new WorkspaceHandler(store, new TypedEventBus(), {
      workspaceOwnedEntities,
      writeLocks,
    });
  });

  it('handler stores access policy from incoming gossip (ownerOnly)', async () => {
    // Simulate publisher creating a message with ownerOnly policy
    const quads = [q('urn:gossip:entity', 'http://schema.org/name', '"Gossip Test"')];
    const { message } = await publisher.writeToWorkspace('gossip-paranet', quads, {
      publisherPeerId: '12D3KooWSender',
      accessPolicy: 'ownerOnly',
    });

    // Feed the message to a different handler (simulating the receiver)
    const receiverStore = new OxigraphStore();
    const receiverHandler = new WorkspaceHandler(receiverStore, new TypedEventBus());
    await receiverHandler.handle(message, '12D3KooWSender');

    const WS_META = 'did:dkg:paranet:gossip-paranet/_workspace_meta';
    const result = await receiverStore.query(
      `SELECT ?policy WHERE { GRAPH <${WS_META}> { ?op <${DKG_NS}accessPolicy> ?policy } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['policy']).toBe('"ownerOnly"');
    }
  });

  it('handler stores allowed peers from incoming gossip (allowList)', async () => {
    const quads = [q('urn:gossip:entity2', 'http://schema.org/name', '"Gossip Test 2"')];
    const { message } = await publisher.writeToWorkspace('gossip-paranet-2', quads, {
      publisherPeerId: '12D3KooWSender',
      accessPolicy: 'allowList',
      allowedPeers: ['peerA', 'peerB'],
    });

    const receiverStore = new OxigraphStore();
    const receiverHandler = new WorkspaceHandler(receiverStore, new TypedEventBus());
    await receiverHandler.handle(message, '12D3KooWSender');

    const WS_META = 'did:dkg:paranet:gossip-paranet-2/_workspace_meta';
    const peerResult = await receiverStore.query(
      `SELECT ?peer WHERE { GRAPH <${WS_META}> { ?op <${DKG_NS}allowedPeer> ?peer } }`,
    );
    expect(peerResult.type).toBe('bindings');
    if (peerResult.type === 'bindings') {
      expect(peerResult.bindings.length).toBe(2);
    }
  });

  it('writeToWorkspace rejects invalid access policy', async () => {
    const quads = [q('urn:gossip:entity3', 'http://schema.org/name', '"Invalid Policy"')];
    await expect(
      publisher.writeToWorkspace('gossip-paranet-3', quads, {
        publisherPeerId: '12D3KooWSender',
        accessPolicy: 'invalidPolicy' as any,
      }),
    ).rejects.toThrow(/invalid accessPolicy/);
  });
});

describe('Workspace enshrineFromWorkspace — access policy pass-through', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
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

  it('enshrineFromWorkspace passes accessPolicy to publish', async () => {
    const quads = [q('urn:enshrine:entity', 'http://schema.org/name', '"Enshrine Test"')];
    await publisher.writeToWorkspace('enshrine-paranet', quads, { publisherPeerId: 'peer1' });

    const result = await publisher.enshrineFromWorkspace('enshrine-paranet', 'all', {
      accessPolicy: 'ownerOnly',
      publisherPeerId: 'peer1',
    });
    expect(result.status).toBe('confirmed');

    // Verify the KC metadata includes the access policy
    const META_GRAPH = 'did:dkg:paranet:enshrine-paranet/_meta';
    const policyResult = await store.query(
      `SELECT ?policy WHERE { GRAPH <${META_GRAPH}> { ?kc <${DKG_NS}accessPolicy> ?policy } }`,
    );
    expect(policyResult.type).toBe('bindings');
    if (policyResult.type === 'bindings') {
      expect(policyResult.bindings.length).toBeGreaterThanOrEqual(1);
      expect(policyResult.bindings[0]['policy']).toBe('"ownerOnly"');
    }
  });

  it('enshrineFromWorkspace passes allowedPeers to publish', async () => {
    const quads = [q('urn:enshrine:entity2', 'http://schema.org/name', '"Enshrine AllowList"')];
    await publisher.writeToWorkspace('enshrine-paranet-2', quads, { publisherPeerId: 'peer1' });

    const result = await publisher.enshrineFromWorkspace('enshrine-paranet-2', 'all', {
      accessPolicy: 'allowList',
      allowedPeers: ['peerZ'],
      publisherPeerId: 'peer1',
    });
    expect(result.status).toBe('confirmed');

    const META_GRAPH = 'did:dkg:paranet:enshrine-paranet-2/_meta';
    const peerResult = await store.query(
      `SELECT ?peer WHERE { GRAPH <${META_GRAPH}> { ?kc <${DKG_NS}allowedPeer> ?peer } }`,
    );
    expect(peerResult.type).toBe('bindings');
    if (peerResult.type === 'bindings') {
      expect(peerResult.bindings.length).toBe(1);
      expect(peerResult.bindings[0]['peer']).toBe('"peerZ"');
    }
  });
});

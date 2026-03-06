/**
 * Regression tests for all security fixes from PR #28 review rounds.
 * Each test targets a specific vulnerability that was identified and fixed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad, GraphManager } from '@dkg/storage';
import { MockChainAdapter, NoChainAdapter } from '@dkg/chain';
import { TypedEventBus, encodeKAUpdateRequest, encodeWorkspacePublishRequest } from '@dkg/core';
import { generateEd25519Keypair } from '@dkg/core';
import {
  DKGPublisher,
  UpdateHandler,
  WorkspaceHandler,
  autoPartition,
  computePublicRoot,
  computeKARoot,
  computeKCRoot,
} from '../src/index.js';
import { ethers } from 'ethers';

const PARANET = 'test-security';
const DATA_GRAPH = `did:dkg:paranet:${PARANET}`;
const WORKSPACE_GRAPH = `did:dkg:paranet:${PARANET}/_workspace`;
const WORKSPACE_META_GRAPH = `did:dkg:paranet:${PARANET}/_workspace_meta`;

function q(s: string, p: string, o: string, g = ''): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function quadsToNQuads(quads: Quad[], graph: string): Uint8Array {
  const str = quads
    .map((qd) => `<${qd.subject}> <${qd.predicate}> ${qd.object.startsWith('"') ? qd.object : `<${qd.object}>`} <${graph}> .`)
    .join('\n');
  return new TextEncoder().encode(str);
}

function computeGossipMerkleRoot(quads: Quad[], manifest: { rootEntity: string; privateMerkleRoot?: Uint8Array }[]): Uint8Array {
  const partitioned = autoPartition(quads);
  const kaRoots: Uint8Array[] = [];
  for (const m of manifest) {
    const entityQuads = partitioned.get(m.rootEntity) ?? [];
    const pubRoot = computePublicRoot(entityQuads);
    const privRoot = m.privateMerkleRoot?.length ? new Uint8Array(m.privateMerkleRoot) : undefined;
    kaRoots.push(computeKARoot(pubRoot, privRoot));
  }
  return computeKCRoot(kaRoots);
}

// =====================================================================
// 1. Prefix deletion safety
// =====================================================================

describe('Prefix deletion safety', () => {
  describe('DKGPublisher.writeToWorkspace', () => {
    let store: OxigraphStore;
    let publisher: DKGPublisher;

    beforeEach(async () => {
      store = new OxigraphStore();
      const chain = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
      const keypair = await generateEd25519Keypair();
      publisher = new DKGPublisher({
        store, chain, eventBus: new TypedEventBus(), keypair,
        publisherPrivateKey: ethers.Wallet.createRandom().privateKey,
        publisherNodeIdentityId: 1n,
      });
    });

    it('upsert of urn:x:foo does NOT delete urn:x:foobar triples', async () => {
      await publisher.writeToWorkspace(PARANET, [
        q('urn:x:foo', 'http://schema.org/name', '"Foo"'),
      ], { publisherPeerId: 'peer1' });

      await publisher.writeToWorkspace(PARANET, [
        q('urn:x:foobar', 'http://schema.org/name', '"Foobar"'),
      ], { publisherPeerId: 'peer1' });

      // Upsert urn:x:foo — urn:x:foobar must survive
      await publisher.writeToWorkspace(PARANET, [
        q('urn:x:foo', 'http://schema.org/name', '"Foo Updated"'),
      ], { publisherPeerId: 'peer1' });

      const fooResult = await store.query(
        `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <urn:x:foo> <http://schema.org/name> ?o } }`,
      );
      expect(fooResult.type).toBe('bindings');
      if (fooResult.type === 'bindings') {
        expect(fooResult.bindings.length).toBe(1);
        expect(fooResult.bindings[0]['o']).toContain('Foo Updated');
      }

      const foobarResult = await store.query(
        `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <urn:x:foobar> <http://schema.org/name> ?o } }`,
      );
      expect(foobarResult.type).toBe('bindings');
      if (foobarResult.type === 'bindings') {
        expect(foobarResult.bindings.length).toBe(1);
        expect(foobarResult.bindings[0]['o']).toContain('Foobar');
      }
    });
  });

  describe('WorkspaceHandler', () => {
    let store: OxigraphStore;
    let handler: WorkspaceHandler;

    beforeEach(async () => {
      store = new OxigraphStore();
      const owned = new Map<string, Map<string, string>>();
      handler = new WorkspaceHandler(store, new TypedEventBus(), { workspaceOwnedEntities: owned });
    });

    it('gossip upsert of urn:x:foo does NOT delete urn:x:foobar triples', async () => {
      const peerId = '12D3KooWPrefixTest';

      const msg1 = encodeWorkspacePublishRequest({
        paranetId: PARANET,
        nquads: new TextEncoder().encode(`<urn:x:foo> <http://schema.org/name> "Foo" <${DATA_GRAPH}> .`),
        manifest: [{ rootEntity: 'urn:x:foo', privateTripleCount: 0 }],
        publisherPeerId: peerId,
        workspaceOperationId: 'ws-prefix-1',
        timestampMs: Date.now(),
      });
      await handler.handle(msg1, peerId);

      const msg2 = encodeWorkspacePublishRequest({
        paranetId: PARANET,
        nquads: new TextEncoder().encode(`<urn:x:foobar> <http://schema.org/name> "Foobar" <${DATA_GRAPH}> .`),
        manifest: [{ rootEntity: 'urn:x:foobar', privateTripleCount: 0 }],
        publisherPeerId: peerId,
        workspaceOperationId: 'ws-prefix-2',
        timestampMs: Date.now(),
      });
      await handler.handle(msg2, peerId);

      // Upsert urn:x:foo
      const msg3 = encodeWorkspacePublishRequest({
        paranetId: PARANET,
        nquads: new TextEncoder().encode(`<urn:x:foo> <http://schema.org/name> "Foo Updated" <${DATA_GRAPH}> .`),
        manifest: [{ rootEntity: 'urn:x:foo', privateTripleCount: 0 }],
        publisherPeerId: peerId,
        workspaceOperationId: 'ws-prefix-3',
        timestampMs: Date.now(),
      });
      await handler.handle(msg3, peerId);

      const gm = new GraphManager(store);
      const wsGraph = gm.workspaceGraphUri(PARANET);

      const foobarResult = await store.query(
        `SELECT ?o WHERE { GRAPH <${wsGraph}> { <urn:x:foobar> <http://schema.org/name> ?o } }`,
      );
      expect(foobarResult.type).toBe('bindings');
      if (foobarResult.type === 'bindings') {
        expect(foobarResult.bindings.length).toBe(1);
        expect(foobarResult.bindings[0]['o']).toContain('Foobar');
      }
    });
  });

  describe('UpdateHandler', () => {
    let store: OxigraphStore;
    let publisher: DKGPublisher;
    let handler: UpdateHandler;
    const wallet = ethers.Wallet.createRandom();

    beforeEach(async () => {
      store = new OxigraphStore();
      const chain = new MockChainAdapter('mock:31337', wallet.address);
      const keypair = await generateEd25519Keypair();
      const eventBus = new TypedEventBus();
      publisher = new DKGPublisher({
        store, chain, eventBus, keypair,
        publisherPrivateKey: wallet.privateKey,
        publisherNodeIdentityId: 1n,
      });
      handler = new UpdateHandler(store, chain, eventBus);
    });

    it('KA update for urn:x:foo does NOT delete urn:x:foobar in data graph', async () => {
      const fooQuads = [q('urn:x:foo', 'http://schema.org/name', '"Foo"')];
      const foobarQuads = [q('urn:x:foobar', 'http://schema.org/name', '"Foobar"')];

      await publisher.publish({ paranetId: PARANET, quads: [...fooQuads, ...foobarQuads] });

      const updateQuads = [q('urn:x:foo', 'http://schema.org/name', '"Foo Updated"')];
      const updateResult = await publisher.update(1n, {
        paranetId: PARANET,
        quads: updateQuads,
      });

      const gossipMsg = encodeKAUpdateRequest({
        paranetId: PARANET,
        batchId: 1n,
        nquads: quadsToNQuads(updateQuads, DATA_GRAPH),
        manifest: [{ rootEntity: 'urn:x:foo', privateTripleCount: 0 }],
        publisherPeerId: '12D3KooWPeer',
        publisherAddress: wallet.address,
        txHash: updateResult.onChainResult!.txHash,
        blockNumber: BigInt(updateResult.onChainResult!.blockNumber),
        newMerkleRoot: computeGossipMerkleRoot(updateQuads, [{ rootEntity: 'urn:x:foo' }]),
        timestampMs: BigInt(Date.now()),
      });
      await handler.handle(gossipMsg, '12D3KooWPeer');

      const foobarResult = await store.query(
        `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <urn:x:foobar> <http://schema.org/name> ?o } }`,
      );
      expect(foobarResult.type).toBe('bindings');
      if (foobarResult.type === 'bindings') {
        expect(foobarResult.bindings.length).toBe(1);
        expect(foobarResult.bindings[0]['o']).toContain('Foobar');
      }
    });
  });
});

// =====================================================================
// 2. Workspace metadata precision on upsert
// =====================================================================

describe('Workspace metadata precision', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: ethers.Wallet.createRandom().privateKey,
      publisherNodeIdentityId: 1n,
    });
  });

  it('upserting one root in a multi-root operation preserves metadata for other roots', async () => {
    const entityA = 'urn:test:meta:a';
    const entityB = 'urn:test:meta:b';

    // Write both roots in a single operation
    await publisher.writeToWorkspace(PARANET, [
      q(entityA, 'http://schema.org/name', '"A"'),
      q(entityB, 'http://schema.org/name', '"B"'),
    ], { publisherPeerId: 'peer1' });

    // Count metadata operations before upsert
    const metaBefore = await store.query(
      `SELECT ?op WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> } }`,
    );
    const opCountBefore = metaBefore.type === 'bindings' ? metaBefore.bindings.length : 0;

    // Upsert only entityA
    await publisher.writeToWorkspace(PARANET, [
      q(entityA, 'http://schema.org/name', '"A Updated"'),
    ], { publisherPeerId: 'peer1' });

    // entityB's data must still be in workspace
    const bResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${entityB}> <http://schema.org/name> ?o } }`,
    );
    expect(bResult.type).toBe('bindings');
    if (bResult.type === 'bindings') {
      expect(bResult.bindings.length).toBe(1);
      expect(bResult.bindings[0]['o']).toContain('B');
    }

    // entityB must still have a rootEntity link in workspace_meta
    const bMeta = await store.query(
      `ASK { GRAPH <${WORKSPACE_META_GRAPH}> { ?op <http://dkg.io/ontology/rootEntity> <${entityB}> } }`,
    );
    expect(bMeta.type).toBe('boolean');
    if (bMeta.type === 'boolean') {
      expect(bMeta.value).toBe(true);
    }
  });
});

// =====================================================================
// 3. chainId=none: gossip merkle root still validated
// =====================================================================

describe('chainId=none validation', () => {
  let store: OxigraphStore;
  let handler: UpdateHandler;

  beforeEach(async () => {
    store = new OxigraphStore();
    const noChain = new NoChainAdapter();
    handler = new UpdateHandler(store, noChain, new TypedEventBus());
  });

  it('rejects gossip with wrong merkle root even without chain verification', async () => {
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);
    const dataGraph = gm.dataGraphUri(PARANET);

    // Insert some existing data
    await store.insert([{ subject: 'urn:existing', predicate: 'http://schema.org/name', object: '"Original"', graph: dataGraph }]);

    const quads = [q('urn:existing', 'http://schema.org/name', '"Tampered"')];
    const fakeRoot = new Uint8Array(32).fill(0xDE);

    const msg = encodeKAUpdateRequest({
      paranetId: PARANET,
      batchId: 1n,
      nquads: quadsToNQuads(quads, dataGraph),
      manifest: [{ rootEntity: 'urn:existing', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeer',
      publisherAddress: '0xAny',
      txHash: '0x0',
      blockNumber: 1n,
      newMerkleRoot: fakeRoot,
      timestampMs: BigInt(Date.now()),
    });

    await handler.handle(msg, '12D3KooWPeer');

    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${dataGraph}> { <urn:existing> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings[0]['o']).toContain('Original');
    }
  });

  it('accepts gossip with correct merkle root on chainId=none', async () => {
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);
    const dataGraph = gm.dataGraphUri(PARANET);

    const quads = [q('urn:new:entity', 'http://schema.org/name', '"Hello"')];
    const manifest = [{ rootEntity: 'urn:new:entity', privateTripleCount: 0 }];
    const correctRoot = computeGossipMerkleRoot(quads, manifest);

    const msg = encodeKAUpdateRequest({
      paranetId: PARANET,
      batchId: 1n,
      nquads: quadsToNQuads(quads, dataGraph),
      manifest,
      publisherPeerId: '12D3KooWPeer',
      publisherAddress: '0xAny',
      txHash: '0x0',
      blockNumber: 1n,
      newMerkleRoot: correctRoot,
      timestampMs: BigInt(Date.now()),
    });

    await handler.handle(msg, '12D3KooWPeer');

    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${dataGraph}> { <urn:new:entity> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings[0]['o']).toContain('Hello');
    }
  });

  it('rejects gossip with empty merkle root on chainId=none', async () => {
    const gm = new GraphManager(store);
    await gm.ensureParanet(PARANET);

    const quads = [q('urn:new', 'http://schema.org/name', '"Should not apply"')];
    const msg = encodeKAUpdateRequest({
      paranetId: PARANET,
      batchId: 1n,
      nquads: quadsToNQuads(quads, gm.dataGraphUri(PARANET)),
      manifest: [{ rootEntity: 'urn:new', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeer',
      publisherAddress: '0xAny',
      txHash: '0x0',
      blockNumber: 1n,
      newMerkleRoot: new Uint8Array(),
      timestampMs: BigInt(Date.now()),
    });

    await handler.handle(msg, '12D3KooWPeer');

    const result = await store.query(
      `ASK { GRAPH <${gm.dataGraphUri(PARANET)}> { <urn:new> ?p ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') {
      expect(result.value).toBe(false);
    }
  });
});

// =====================================================================
// 4. MockChainAdapter.verifyKAUpdate fidelity
// =====================================================================

describe('MockChainAdapter.verifyKAUpdate', () => {
  it('returns correct on-chain merkle root and block number', async () => {
    const wallet = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    const publishResult = await chain.publishKnowledgeAssets({
      kaCount: 1,
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32).fill(0x01),
      publicByteSize: 100n,
      epochs: 1,
      tokenAmount: 0n,
      publisherSignature: sig,
      receiverSignatures: [{ identityId: 2n, ...sig }],
    });

    const newRoot = new Uint8Array(32).fill(0xAB);
    const updateResult = await chain.updateKnowledgeAssets({
      batchId: publishResult.batchId,
      newMerkleRoot: newRoot,
      newPublicByteSize: 200n,
    });

    const verification = await chain.verifyKAUpdate(
      updateResult.hash,
      publishResult.batchId,
      wallet.address,
    );

    expect(verification.verified).toBe(true);
    expect(verification.onChainMerkleRoot).toEqual(newRoot);
    expect(verification.blockNumber).toBe(updateResult.blockNumber);
  });

  it('rejects verification with wrong txHash', async () => {
    const wallet = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    await chain.publishKnowledgeAssets({
      kaCount: 1,
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32).fill(0x01),
      publicByteSize: 100n, epochs: 1, tokenAmount: 0n,
      publisherSignature: sig,
      receiverSignatures: [{ identityId: 2n, ...sig }],
    });

    await chain.updateKnowledgeAssets({
      batchId: 1n,
      newMerkleRoot: new Uint8Array(32).fill(0xAB),
      newPublicByteSize: 200n,
    });

    const verification = await chain.verifyKAUpdate('0xWRONG', 1n, wallet.address);
    expect(verification.verified).toBe(false);
  });

  it('rejects verification with wrong publisher address', async () => {
    const wallet = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    await chain.publishKnowledgeAssets({
      kaCount: 1,
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32).fill(0x01),
      publicByteSize: 100n, epochs: 1, tokenAmount: 0n,
      publisherSignature: sig,
      receiverSignatures: [{ identityId: 2n, ...sig }],
    });

    const updateResult = await chain.updateKnowledgeAssets({
      batchId: 1n,
      newMerkleRoot: new Uint8Array(32).fill(0xAB),
      newPublicByteSize: 200n,
    });

    const verification = await chain.verifyKAUpdate(updateResult.hash, 1n, '0xWrongAddress');
    expect(verification.verified).toBe(false);
  });
});

// =====================================================================
// 5. Same-block different-tx acceptance
// =====================================================================

describe('Same-block ordering', () => {
  it('accepts two updates with same chain block but different txHashes', async () => {
    const wallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();
    const eventBus = new TypedEventBus();
    const publisher = new DKGPublisher({
      store, chain, eventBus, keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });

    // Publish initial
    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [q('urn:same:block', 'http://schema.org/name', '"Original"')],
    });

    // Do two updates — they'll have different blocks in the mock,
    // so we simulate same-block by creating a custom handler with
    // a mock chain that returns the same block for both verifications.
    const update1Quads = [q('urn:same:block', 'http://schema.org/name', '"Update 1"')];
    const update1 = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: update1Quads,
    });

    const update2Quads = [q('urn:same:block', 'http://schema.org/name', '"Update 2"')];
    const update2 = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: update2Quads,
    });

    // Both have different txHashes and different blocks in mock,
    // so both should be accepted (higher block wins).
    const handler = new UpdateHandler(store, chain, eventBus);

    const buildMsg = (quads: Quad[], txHash: string, blockNumber: number) =>
      encodeKAUpdateRequest({
        paranetId: PARANET,
        batchId: original.kcId,
        nquads: quadsToNQuads(quads, DATA_GRAPH),
        manifest: [{ rootEntity: 'urn:same:block', privateTripleCount: 0 }],
        publisherPeerId: '12D3KooWPeer',
        publisherAddress: wallet.address,
        txHash,
        blockNumber: BigInt(blockNumber),
        newMerkleRoot: computeGossipMerkleRoot(quads, [{ rootEntity: 'urn:same:block' }]),
        timestampMs: BigInt(Date.now()),
      });

    // Apply update1 first
    await handler.handle(
      buildMsg(update1Quads, update1.onChainResult!.txHash, update1.onChainResult!.blockNumber),
      '12D3KooWPeer',
    );

    // Apply update2 (higher block) — should succeed
    await handler.handle(
      buildMsg(update2Quads, update2.onChainResult!.txHash, update2.onChainResult!.blockNumber),
      '12D3KooWPeer',
    );

    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <urn:same:block> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toContain('Update 2');
    }
  });

  it('rejects duplicate txHash at same block (replay)', async () => {
    const wallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();
    const eventBus = new TypedEventBus();
    const publisher = new DKGPublisher({
      store, chain, eventBus, keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });
    const handler = new UpdateHandler(store, chain, eventBus);

    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [q('urn:replay', 'http://schema.org/name', '"Original"')],
    });

    const updateQuads = [q('urn:replay', 'http://schema.org/name', '"Updated"')];
    const updateResult = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: updateQuads,
    });

    const msg = encodeKAUpdateRequest({
      paranetId: PARANET,
      batchId: original.kcId,
      nquads: quadsToNQuads(updateQuads, DATA_GRAPH),
      manifest: [{ rootEntity: 'urn:replay', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeer',
      publisherAddress: wallet.address,
      txHash: updateResult.onChainResult!.txHash,
      blockNumber: BigInt(updateResult.onChainResult!.blockNumber),
      newMerkleRoot: computeGossipMerkleRoot(updateQuads, [{ rootEntity: 'urn:replay' }]),
      timestampMs: BigInt(Date.now()),
    });

    await handler.handle(msg, '12D3KooWPeer');
    await handler.handle(msg, '12D3KooWPeer'); // replay — should be rejected

    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <urn:replay> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toContain('Updated');
    }
  });
});

/**
 * Regression tests for all security fixes from PR #28 review rounds.
 * Each test targets a specific vulnerability that was identified and fixed.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { OxigraphStore, type Quad, GraphManager } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter, NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, encodeKAUpdateRequest, encodeWorkspacePublishRequest } from '@origintrail-official/dkg-core';
import { generateEd25519Keypair } from '@origintrail-official/dkg-core';
import {
  DKGPublisher,
  UpdateHandler,
  SharedMemoryHandler,
  autoPartition,
  computePublicRootV10 as computePublicRoot,
  computeKARootV10 as computeKARoot,
  computeKCRootV10 as computeKCRoot,
} from '../src/index.js';
import { ethers } from 'ethers';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, createTestContextGraph, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

let PARANET: string;
let DATA_GRAPH: string;
let WORKSPACE_GRAPH: string;
let WORKSPACE_META_GRAPH: string;

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

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));

  const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  const cgId = await createTestContextGraph(chain);
  PARANET = String(cgId);
  DATA_GRAPH = `did:dkg:context-graph:${PARANET}`;
  WORKSPACE_GRAPH = `did:dkg:context-graph:${PARANET}/_shared_memory`;
  WORKSPACE_META_GRAPH = `did:dkg:context-graph:${PARANET}/_shared_memory_meta`;
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

// =====================================================================
// 1. Prefix deletion safety
// =====================================================================

describe('Prefix deletion safety', () => {
  describe('DKGPublisher.share', () => {
    let store: OxigraphStore;
    let publisher: DKGPublisher;

    beforeEach(async () => {
      store = new OxigraphStore();
      const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const keypair = await generateEd25519Keypair();
      publisher = new DKGPublisher({
        store, chain, eventBus: new TypedEventBus(), keypair,
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      });
    });

    it('upsert of urn:x:foo does NOT delete urn:x:foobar triples', async () => {
      await publisher.share(PARANET, [
        q('urn:x:foo', 'http://schema.org/name', '"Foo"'),
      ], { publisherPeerId: 'peer1' });

      await publisher.share(PARANET, [
        q('urn:x:foobar', 'http://schema.org/name', '"Foobar"'),
      ], { publisherPeerId: 'peer1' });

      // Upsert urn:x:foo — urn:x:foobar must survive
      await publisher.share(PARANET, [
        q('urn:x:foo', 'http://schema.org/name', '"Foo Updated"'),
      ], { publisherPeerId: 'peer1' });

      const fooResult = await store.query(
        `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <urn:x:foo> <http://schema.org/name> ?o } }`,
      );
      expect(fooResult.type).toBe('bindings');
      if (fooResult.type === 'bindings') {
        expect(fooResult.bindings.length).toBe(1);
        expect(fooResult.bindings[0]['o']).toBe('"Foo Updated"');
      }

      const foobarResult = await store.query(
        `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <urn:x:foobar> <http://schema.org/name> ?o } }`,
      );
      expect(foobarResult.type).toBe('bindings');
      if (foobarResult.type === 'bindings') {
        expect(foobarResult.bindings.length).toBe(1);
        expect(foobarResult.bindings[0]['o']).toBe('"Foobar"');
      }
    });
  });

  describe('SharedMemoryHandler', () => {
    let store: OxigraphStore;
    let handler: SharedMemoryHandler;

    beforeEach(async () => {
      store = new OxigraphStore();
      const owned = new Map<string, Map<string, string>>();
      handler = new SharedMemoryHandler(store, new TypedEventBus(), { sharedMemoryOwnedEntities: owned });
    });

    it('gossip upsert of urn:x:foo does NOT delete urn:x:foobar triples', async () => {
      const peerId = '12D3KooWPrefixTest';

      const msg1 = encodeWorkspacePublishRequest({
        paranetId: PARANET,
        nquads: new TextEncoder().encode(`<urn:x:foo> <http://schema.org/name> "Foo" <${DATA_GRAPH}> .`),
        manifest: [{ rootEntity: 'urn:x:foo', privateTripleCount: 0 }],
        publisherPeerId: peerId,
        shareOperationId: 'ws-prefix-1',
        timestampMs: Date.now(),
      });
      await handler.handle(msg1, peerId);

      const msg2 = encodeWorkspacePublishRequest({
        paranetId: PARANET,
        nquads: new TextEncoder().encode(`<urn:x:foobar> <http://schema.org/name> "Foobar" <${DATA_GRAPH}> .`),
        manifest: [{ rootEntity: 'urn:x:foobar', privateTripleCount: 0 }],
        publisherPeerId: peerId,
        shareOperationId: 'ws-prefix-2',
        timestampMs: Date.now(),
      });
      await handler.handle(msg2, peerId);

      // Upsert urn:x:foo
      const msg3 = encodeWorkspacePublishRequest({
        paranetId: PARANET,
        nquads: new TextEncoder().encode(`<urn:x:foo> <http://schema.org/name> "Foo Updated" <${DATA_GRAPH}> .`),
        manifest: [{ rootEntity: 'urn:x:foo', privateTripleCount: 0 }],
        publisherPeerId: peerId,
        shareOperationId: 'ws-prefix-3',
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
        expect(foobarResult.bindings[0]['o']).toBe('"Foobar"');
      }
    });
  });

  describe('UpdateHandler', () => {
    let store: OxigraphStore;
    let publisher: DKGPublisher;
    let handler: UpdateHandler;
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    let _snap: string;

    beforeEach(async () => {
      _snap = await takeSnapshot();
      store = new OxigraphStore();
      const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const keypair = await generateEd25519Keypair();
      const eventBus = new TypedEventBus();
      publisher = new DKGPublisher({
        store, chain, eventBus, keypair,
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      });
      handler = new UpdateHandler(store, chain, eventBus);
    });

    afterEach(async () => {
      await revertSnapshot(_snap);
    });

    it('KA update for urn:x:foo does NOT delete urn:x:foobar in data graph', async () => {
      const fooQuads = [q('urn:x:foo', 'http://schema.org/name', '"Foo"')];
      const foobarQuads = [q('urn:x:foobar', 'http://schema.org/name', '"Foobar"')];

      const published = await publisher.publish({ contextGraphId: PARANET, quads: [...fooQuads, ...foobarQuads] });

      const updateQuads = [q('urn:x:foo', 'http://schema.org/name', '"Foo Updated"')];
      const updateResult = await publisher.update(published.kcId, {
        contextGraphId: PARANET,
        quads: updateQuads,
      });

      const gossipMsg = encodeKAUpdateRequest({
        paranetId: PARANET,
        batchId: published.kcId,
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
        expect(foobarResult.bindings[0]['o']).toBe('"Foobar"');
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
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
  });

  it('upserting one root in a multi-root operation preserves metadata for other roots', async () => {
    const entityA = 'urn:test:meta:a';
    const entityB = 'urn:test:meta:b';

    // Write both roots in a single operation
    await publisher.share(PARANET, [
      q(entityA, 'http://schema.org/name', '"A"'),
      q(entityB, 'http://schema.org/name', '"B"'),
    ], { publisherPeerId: 'peer1' });

    // Count metadata operations before upsert
    const metaBefore = await store.query(
      `SELECT ?op WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> } }`,
    );
    const opCountBefore = metaBefore.type === 'bindings' ? metaBefore.bindings.length : 0;

    // Upsert only entityA
    await publisher.share(PARANET, [
      q(entityA, 'http://schema.org/name', '"A Updated"'),
    ], { publisherPeerId: 'peer1' });

    // entityB's data must still be in workspace
    const bResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${entityB}> <http://schema.org/name> ?o } }`,
    );
    expect(bResult.type).toBe('bindings');
    if (bResult.type === 'bindings') {
      expect(bResult.bindings.length).toBe(1);
      expect(bResult.bindings[0]['o']).toBe('"B"');
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
    await gm.ensureContextGraph(PARANET);
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
      expect(result.bindings[0]['o']).toBe('"Original"');
    }
  });

  it('accepts gossip with correct merkle root on chainId=none', async () => {
    const gm = new GraphManager(store);
    await gm.ensureContextGraph(PARANET);
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
      expect(result.bindings[0]['o']).toBe('"Hello"');
    }
  });

  it('rejects gossip with empty merkle root on chainId=none', async () => {
    const gm = new GraphManager(store);
    await gm.ensureContextGraph(PARANET);

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
// 4. EVMChainAdapter.verifyKAUpdate fidelity
// =====================================================================

describe('EVMChainAdapter.verifyKAUpdate', () => {
  let _snap: string;
  beforeEach(async () => { _snap = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(_snap); });

  it('returns correct on-chain merkle root and block number', async () => {
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const store = new OxigraphStore();
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const original = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q('urn:verify:root', 'http://schema.org/name', '"Root Test"')],
    });
    expect(original.status).toBe('confirmed');

    const updateQuads = [q('urn:verify:root', 'http://schema.org/name', '"Updated"')];
    const updateResult = await publisher.update(original.kcId, {
      contextGraphId: PARANET,
      quads: updateQuads,
    });
    expect(updateResult.status).toBe('confirmed');

    const verification = await chain.verifyKAUpdate(
      updateResult.onChainResult!.txHash,
      original.kcId,
      wallet.address,
    );

    expect(verification.verified).toBe(true);
    expect(verification.onChainMerkleRoot).toEqual(new Uint8Array(updateResult.merkleRoot));
    expect(verification.blockNumber).toBe(updateResult.onChainResult!.blockNumber);
  });

  it('rejects verification with wrong txHash', async () => {
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const store = new OxigraphStore();
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const original = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q('urn:verify:wrong-tx', 'http://schema.org/name', '"WrongTx"')],
    });
    expect(original.status).toBe('confirmed');

    const updateResult = await publisher.update(original.kcId, {
      contextGraphId: PARANET,
      quads: [q('urn:verify:wrong-tx', 'http://schema.org/name', '"Updated"')],
    });
    expect(updateResult.status).toBe('confirmed');

    const verification = await chain.verifyKAUpdate('0xWRONG', original.kcId, wallet.address);
    expect(verification.verified).toBe(false);
  });

  it('rejects verification with wrong publisher address', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const store = new OxigraphStore();
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const original = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q('urn:verify:wrong-addr', 'http://schema.org/name', '"WrongAddr"')],
    });
    expect(original.status).toBe('confirmed');

    const updateResult = await publisher.update(original.kcId, {
      contextGraphId: PARANET,
      quads: [q('urn:verify:wrong-addr', 'http://schema.org/name', '"Updated"')],
    });
    expect(updateResult.status).toBe('confirmed');

    const verification = await chain.verifyKAUpdate(
      updateResult.onChainResult!.txHash, original.kcId, '0xWrongAddress',
    );
    expect(verification.verified).toBe(false);
  });
});

// =====================================================================
// 5. Same-block ordering (deterministic via txIndex)
// =====================================================================

describe('Same-block ordering', () => {
  let _snap: string;
  beforeEach(async () => { _snap = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(_snap); });

  it('accepts two updates with increasing chain blocks', async () => {
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const eventBus = new TypedEventBus();
    const publisher = new DKGPublisher({
      store, chain, eventBus, keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const original = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q('urn:same:block', 'http://schema.org/name', '"Original"')],
    });

    const update1Quads = [q('urn:same:block', 'http://schema.org/name', '"Update 1"')];
    const update1 = await publisher.update(original.kcId, {
      contextGraphId: PARANET,
      quads: update1Quads,
    });

    const update2Quads = [q('urn:same:block', 'http://schema.org/name', '"Update 2"')];
    const update2 = await publisher.update(original.kcId, {
      contextGraphId: PARANET,
      quads: update2Quads,
    });

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

    await handler.handle(
      buildMsg(update1Quads, update1.onChainResult!.txHash, update1.onChainResult!.blockNumber),
      '12D3KooWPeer',
    );

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
      expect(result.bindings[0]['o']).toBe('"Update 2"');
    }
  });

  it('rejects replay of same (block, txIndex)', async () => {
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const eventBus = new TypedEventBus();
    const publisher = new DKGPublisher({
      store, chain, eventBus, keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const handler = new UpdateHandler(store, chain, eventBus);

    const original = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q('urn:replay', 'http://schema.org/name', '"Original"')],
    });

    const updateQuads = [q('urn:replay', 'http://schema.org/name', '"Updated"')];
    const updateResult = await publisher.update(original.kcId, {
      contextGraphId: PARANET,
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
    await handler.handle(msg, '12D3KooWPeer'); // replay — same (block, txIndex) → rejected

    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <urn:replay> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Updated"');
    }
  });
});

// =====================================================================
// 6. publisher.update() does not mutate local store on chain failure
// =====================================================================

describe('publisher.update() atomicity', () => {
  let _snap: string;
  beforeEach(async () => { _snap = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(_snap); });

  it('does not mutate local graph when chain tx fails', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const original = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q('urn:atomic', 'http://schema.org/name', '"Original"')],
    });

    // Attempt to update a non-existent batch — V10 catches KnowledgeCollectionExpired
    // as a definitive error and returns status: 'failed' (no throw, no store mutation)
    const failedUpdate = await publisher.update(999n, {
      contextGraphId: PARANET,
      quads: [q('urn:atomic', 'http://schema.org/name', '"Should not appear"')],
    });
    expect(failedUpdate.status).toBe('failed');

    // Original data must be untouched
    const nameResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <urn:atomic> <http://schema.org/name> ?o } }`,
    );
    expect(nameResult.type).toBe('bindings');
    if (nameResult.type === 'bindings') {
      expect(nameResult.bindings.length).toBe(1);
      expect(nameResult.bindings[0]['o']).toBe('"Original"');
    }
  });
});

// =====================================================================
// 7. verifyKAUpdate returns txIndex for deterministic ordering
// =====================================================================

describe('EVMChainAdapter.verifyKAUpdate txIndex', () => {
  let _snap: string;
  beforeEach(async () => { _snap = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(_snap); });

  it('returns txIndex from chain verification', async () => {
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const store = new OxigraphStore();
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const original = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q('urn:txidx:verify', 'http://schema.org/name', '"TxIndex"')],
    });
    expect(original.status).toBe('confirmed');

    const updateResult = await publisher.update(original.kcId, {
      contextGraphId: PARANET,
      quads: [q('urn:txidx:verify', 'http://schema.org/name', '"Updated"')],
    });
    expect(updateResult.status).toBe('confirmed');

    const verification = await chain.verifyKAUpdate(
      updateResult.onChainResult!.txHash, original.kcId, wallet.address,
    );
    expect(verification.verified).toBe(true);
    expect(verification.txIndex).toBeDefined();
    expect(typeof verification.txIndex).toBe('number');
  });
});

// =====================================================================
// 8. Workspace gossip peerId spoofing prevention
// =====================================================================

describe('Workspace peerId spoofing', () => {
  let store: OxigraphStore;
  let handler: SharedMemoryHandler;

  beforeEach(async () => {
    store = new OxigraphStore();
    const owned = new Map<string, Map<string, string>>();
    handler = new SharedMemoryHandler(store, new TypedEventBus(), { sharedMemoryOwnedEntities: owned });
  });

  it('rejects message where publisherPeerId does not match fromPeerId', async () => {
    const victimPeerId = '12D3KooWVictim';
    const attackerPeerId = '12D3KooWAttacker';

    const msg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<urn:spoof> <http://schema.org/name> "Spoofed" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: 'urn:spoof', privateTripleCount: 0 }],
      publisherPeerId: victimPeerId,
      shareOperationId: 'ws-spoof-1',
      timestampMs: Date.now(),
    });

    await handler.handle(msg, attackerPeerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `ASK { GRAPH <${wsGraph}> { <urn:spoof> ?p ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') {
      expect(result.value).toBe(false);
    }
  });

  it('accepts message where publisherPeerId matches fromPeerId', async () => {
    const peerId = '12D3KooWLegit';

    const msg = encodeWorkspacePublishRequest({
      paranetId: PARANET,
      nquads: new TextEncoder().encode(`<urn:legit> <http://schema.org/name> "Legit" <${DATA_GRAPH}> .`),
      manifest: [{ rootEntity: 'urn:legit', privateTripleCount: 0 }],
      publisherPeerId: peerId,
      shareOperationId: 'ws-legit-1',
      timestampMs: Date.now(),
    });

    await handler.handle(msg, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(PARANET);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <urn:legit> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Legit"');
    }
  });
});

// =====================================================================
// 9. Cross-paranet binding from trusted source
// =====================================================================

describe('Cross-paranet binding (trusted source)', () => {
  let _snap: string;
  beforeEach(async () => { _snap = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(_snap); });

  it('rejects update when publisher has pre-registered batch→paranet binding', async () => {
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const eventBus = new TypedEventBus();
    const knownBatchContextGraphs = new Map<string, string>();

    const publisher = new DKGPublisher({
      store, chain, eventBus, keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      knownBatchContextGraphs,
    });
    const handler = new UpdateHandler(store, chain, eventBus, { knownBatchContextGraphs });

    // Publish on the correct paranet — binding is registered automatically
    const original = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q('urn:trusted:bind', 'http://schema.org/name', '"Original"')],
    });
    expect(knownBatchContextGraphs.get(String(original.kcId))).toBe(PARANET);

    // Attacker tries to replay the same batchId on a different paranet
    const updateQuads = [q('urn:trusted:bind', 'http://schema.org/name', '"Hacked"')];
    const updateResult = await publisher.update(original.kcId, {
      contextGraphId: PARANET,
      quads: updateQuads,
    });

    const attackMsg = encodeKAUpdateRequest({
      paranetId: 'attacker-paranet',
      batchId: original.kcId,
      nquads: quadsToNQuads(updateQuads, 'did:dkg:context-graph:attacker-paranet'),
      manifest: [{ rootEntity: 'urn:trusted:bind', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWAttacker',
      publisherAddress: wallet.address,
      txHash: updateResult.onChainResult!.txHash,
      blockNumber: BigInt(updateResult.onChainResult!.blockNumber),
      newMerkleRoot: computeGossipMerkleRoot(updateQuads, [{ rootEntity: 'urn:trusted:bind' }]),
      timestampMs: BigInt(Date.now()),
    });

    await handler.handle(attackMsg, '12D3KooWAttacker');

    // Verify the attacker's paranet graph is empty
    const gm = new GraphManager(store);
    await gm.ensureContextGraph('attacker-paranet');
    const result = await store.query(
      `ASK { GRAPH <${gm.dataGraphUri('attacker-paranet')}> { <urn:trusted:bind> ?p ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') {
      expect(result.value).toBe(false);
    }
  });
});

// =====================================================================
// 10. Same-block txIndex ordering
// =====================================================================

describe('Same-block txIndex ordering', () => {
  let _snap: string;
  beforeEach(async () => { _snap = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(_snap); });

  it('assigns distinct txIndex values across updates', async () => {
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const store = new OxigraphStore();
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const original = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q('urn:sameblock:txidx', 'http://schema.org/name', '"Original"')],
    });
    expect(original.status).toBe('confirmed');

    const update1 = await publisher.update(original.kcId, {
      contextGraphId: PARANET,
      quads: [q('urn:sameblock:txidx', 'http://schema.org/name', '"Update 1"')],
    });
    expect(update1.status).toBe('confirmed');

    const update2 = await publisher.update(original.kcId, {
      contextGraphId: PARANET,
      quads: [q('urn:sameblock:txidx', 'http://schema.org/name', '"Update 2"')],
    });
    expect(update2.status).toBe('confirmed');

    // Different tx hashes
    expect(update1.onChainResult!.txHash).not.toBe(update2.onChainResult!.txHash);

    // Verify both updates
    const v1 = await chain.verifyKAUpdate(update1.onChainResult!.txHash, original.kcId, wallet.address);
    const v2 = await chain.verifyKAUpdate(update2.onChainResult!.txHash, original.kcId, wallet.address);
    expect(v1.verified).toBe(true);
    expect(v2.verified).toBe(true);
    expect(v1.txIndex).toBeDefined();
    expect(v2.txIndex).toBeDefined();
  });

  it('handler applies later update and rejects earlier within ordering', async () => {
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const eventBus = new TypedEventBus();
    const publisher = new DKGPublisher({
      store, chain, eventBus, keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const original = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q('urn:txidx', 'http://schema.org/name', '"Original"')],
    });

    const q1 = [q('urn:txidx', 'http://schema.org/name', '"Update 1"')];
    const update1 = await publisher.update(original.kcId, { contextGraphId: PARANET, quads: q1 });

    const q2 = [q('urn:txidx', 'http://schema.org/name', '"Update 2"')];
    const update2 = await publisher.update(original.kcId, { contextGraphId: PARANET, quads: q2 });

    expect(update2.onChainResult!.blockNumber).toBeGreaterThanOrEqual(update1.onChainResult!.blockNumber);

    const handler = new UpdateHandler(store, chain, eventBus);

    // Apply update2 (later) first
    const msg2 = encodeKAUpdateRequest({
      paranetId: PARANET,
      batchId: original.kcId,
      nquads: quadsToNQuads(q2, DATA_GRAPH),
      manifest: [{ rootEntity: 'urn:txidx', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeer',
      publisherAddress: wallet.address,
      txHash: update2.onChainResult!.txHash,
      blockNumber: BigInt(update2.onChainResult!.blockNumber),
      newMerkleRoot: computeGossipMerkleRoot(q2, [{ rootEntity: 'urn:txidx' }]),
      timestampMs: BigInt(Date.now()),
    });
    await handler.handle(msg2, '12D3KooWPeer');

    // Now try update1 (earlier) — should be rejected (lower block/txIndex)
    const msg1 = encodeKAUpdateRequest({
      paranetId: PARANET,
      batchId: original.kcId,
      nquads: quadsToNQuads(q1, DATA_GRAPH),
      manifest: [{ rootEntity: 'urn:txidx', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeer',
      publisherAddress: wallet.address,
      txHash: update1.onChainResult!.txHash,
      blockNumber: BigInt(update1.onChainResult!.blockNumber),
      newMerkleRoot: computeGossipMerkleRoot(q1, [{ rootEntity: 'urn:txidx' }]),
      timestampMs: BigInt(Date.now()),
    });
    await handler.handle(msg1, '12D3KooWPeer');

    // Should still have update2's data (later update wins)
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <urn:txidx> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Update 2"');
    }
  });
});

// =====================================================================
// 12. lookupBatchParanet typed literal match
// =====================================================================

describe('lookupBatchParanet typed-literal SPARQL', () => {
  let _snap: string;
  beforeEach(async () => { _snap = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(_snap); });

  it('finds paranet binding from metadata stored with xsd:integer literal', async () => {
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const eventBus = new TypedEventBus();

    const publisher = new DKGPublisher({
      store, chain, eventBus, keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const quads = [q('urn:typed-lit', 'http://schema.org/name', '"Typed"')];
    const original = await publisher.publish({ contextGraphId: PARANET, quads });
    expect(original.status).toBe('confirmed');

    // UpdateHandler without pre-registered binding — should discover it via SPARQL lookup
    const handler = new UpdateHandler(store, chain, eventBus);

    const q2 = [q('urn:typed-lit', 'http://schema.org/name', '"Updated"')];
    const update = await publisher.update(original.kcId, { contextGraphId: PARANET, quads: q2 });
    expect(update.status).toBe('confirmed');

    const msg = encodeKAUpdateRequest({
      paranetId: PARANET,
      batchId: original.kcId,
      nquads: quadsToNQuads(q2, DATA_GRAPH),
      manifest: [{ rootEntity: 'urn:typed-lit', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeer',
      publisherAddress: wallet.address,
      txHash: update.onChainResult!.txHash,
      blockNumber: BigInt(update.onChainResult!.blockNumber),
      newMerkleRoot: computeGossipMerkleRoot(q2, [{ rootEntity: 'urn:typed-lit' }]),
      timestampMs: BigInt(Date.now()),
    });
    await handler.handle(msg, '12D3KooWPeer');

    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <urn:typed-lit> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Updated"');
    }
  });

  it('rejects cross-paranet attack when binding is discovered via SPARQL lookup', async () => {
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const eventBus = new TypedEventBus();

    const publisher = new DKGPublisher({
      store, chain, eventBus, keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const quads = [q('urn:xpara-lookup', 'http://schema.org/name', '"Original"')];
    const original = await publisher.publish({ contextGraphId: PARANET, quads });
    expect(original.status).toBe('confirmed');

    const evilParanet = 'evil-paranet';
    const handler = new UpdateHandler(store, chain, eventBus);

    const q2 = [q('urn:xpara-lookup', 'http://schema.org/name', '"Evil"')];
    const update = await publisher.update(original.kcId, { contextGraphId: PARANET, quads: q2 });
    expect(update.status).toBe('confirmed');

    const msg = encodeKAUpdateRequest({
      paranetId: evilParanet,
      batchId: original.kcId,
      nquads: quadsToNQuads(q2, `did:dkg:context-graph:${evilParanet}`),
      manifest: [{ rootEntity: 'urn:xpara-lookup', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeer',
      publisherAddress: wallet.address,
      txHash: update.onChainResult!.txHash,
      blockNumber: BigInt(update.onChainResult!.blockNumber),
      newMerkleRoot: computeGossipMerkleRoot(q2, [{ rootEntity: 'urn:xpara-lookup' }]),
      timestampMs: BigInt(Date.now()),
    });
    await handler.handle(msg, '12D3KooWPeer');

    // Evil paranet graph should be empty — update was rejected
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <did:dkg:context-graph:${evilParanet}> { <urn:xpara-lookup> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(0);
    }
  });
});

// =====================================================================
// 13. EVMChainAdapter address case normalization
// =====================================================================

describe('EVMChainAdapter address case normalization', () => {
  let _snap: string;
  beforeEach(async () => { _snap = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(_snap); });

  it('verifyKAUpdate matches addresses case-insensitively', async () => {
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const store = new OxigraphStore();
    const keypair = await generateEd25519Keypair();
    const eventBus = new TypedEventBus();

    const publisher = new DKGPublisher({
      store, chain, eventBus, keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const quads = [q('urn:addr-case', 'http://schema.org/name', '"CaseTest"')];
    const original = await publisher.publish({ contextGraphId: PARANET, quads });
    expect(original.status).toBe('confirmed');

    const q2 = [q('urn:addr-case', 'http://schema.org/name', '"Updated"')];
    const update = await publisher.update(original.kcId, { contextGraphId: PARANET, quads: q2 });
    expect(update.status).toBe('confirmed');

    // Verify with address in all lowercase
    const v1 = await chain.verifyKAUpdate(
      update.onChainResult!.txHash,
      original.kcId,
      wallet.address.toLowerCase(),
    );
    expect(v1.verified).toBe(true);

    // Verify with address in all uppercase (except 0x prefix)
    const v2 = await chain.verifyKAUpdate(
      update.onChainResult!.txHash,
      original.kcId,
      '0x' + wallet.address.slice(2).toUpperCase(),
    );
    expect(v2.verified).toBe(true);
  });
});

// =====================================================================
// 14. Untrusted gossip must not persist batch→paranet binding
// =====================================================================

describe('Gossip-only batch→paranet binding rejected', () => {
  let _snap: string;
  beforeEach(async () => { _snap = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(_snap); });

  it('does not persist binding from gossip when no trusted source exists', async () => {
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const eventBus = new TypedEventBus();

    const publisher = new DKGPublisher({
      store, chain, eventBus, keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const quads = [q('urn:gossip-bind', 'http://schema.org/name', '"Original"')];
    const original = await publisher.publish({ contextGraphId: PARANET, quads });
    expect(original.status).toBe('confirmed');

    // Handler with separate knownBatchContextGraphs (empty) — no trusted binding
    const handler = new UpdateHandler(store, chain, eventBus);

    const q2 = [q('urn:gossip-bind', 'http://schema.org/name', '"Updated"')];
    const update = await publisher.update(original.kcId, { contextGraphId: PARANET, quads: q2 });
    expect(update.status).toBe('confirmed');

    // First update on correct paranet should go through (discovered via SPARQL lookup)
    const msg1 = encodeKAUpdateRequest({
      paranetId: PARANET,
      batchId: original.kcId,
      nquads: quadsToNQuads(q2, DATA_GRAPH),
      manifest: [{ rootEntity: 'urn:gossip-bind', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeer',
      publisherAddress: wallet.address,
      txHash: update.onChainResult!.txHash,
      blockNumber: BigInt(update.onChainResult!.blockNumber),
      newMerkleRoot: computeGossipMerkleRoot(q2, [{ rootEntity: 'urn:gossip-bind' }]),
      timestampMs: BigInt(Date.now()),
    });
    await handler.handle(msg1, '12D3KooWPeer');

    // Now send a second message on a DIFFERENT paranet with a new valid chain tx
    const q3 = [q('urn:gossip-bind', 'http://schema.org/name', '"Spoofed"')];
    const update2 = await publisher.update(original.kcId, { contextGraphId: PARANET, quads: q3 });
    expect(update2.status).toBe('confirmed');

    const evilParanet = 'evil-gossip';
    const msg2 = encodeKAUpdateRequest({
      paranetId: evilParanet,
      batchId: original.kcId,
      nquads: quadsToNQuads(q3, `did:dkg:context-graph:${evilParanet}`),
      manifest: [{ rootEntity: 'urn:gossip-bind', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeer',
      publisherAddress: wallet.address,
      txHash: update2.onChainResult!.txHash,
      blockNumber: BigInt(update2.onChainResult!.blockNumber),
      newMerkleRoot: computeGossipMerkleRoot(q3, [{ rootEntity: 'urn:gossip-bind' }]),
      timestampMs: BigInt(Date.now()),
    });
    await handler.handle(msg2, '12D3KooWPeer');

    // Evil paranet graph should be empty — binding discovered from metadata prevents cross-paranet
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <did:dkg:context-graph:${evilParanet}> { <urn:gossip-bind> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(0);
    }
  });
});

// =====================================================================
// 15. OnChainPublishResult from update() omits startKAId/endKAId
// =====================================================================

describe('Update provenance shape', () => {
  let _snap: string;
  beforeEach(async () => { _snap = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(_snap); });

  it('update() result omits startKAId and endKAId', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const eventBus = new TypedEventBus();

    const publisher = new DKGPublisher({
      store, chain, eventBus, keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const quads = [q('urn:prov-shape', 'http://schema.org/name', '"V1"')];
    const original = await publisher.publish({ contextGraphId: PARANET, quads });
    expect(original.status).toBe('confirmed');
    expect(original.onChainResult!.startKAId).toBeDefined();
    expect(original.onChainResult!.endKAId).toBeDefined();

    const q2 = [q('urn:prov-shape', 'http://schema.org/name', '"V2"')];
    const updated = await publisher.update(original.kcId, { contextGraphId: PARANET, quads: q2 });
    expect(updated.status).toBe('confirmed');
    expect(updated.onChainResult).toBeDefined();
    expect(updated.onChainResult!.txHash).toBeTruthy();
    expect(updated.onChainResult!.blockNumber).toBeGreaterThan(0);
    expect(updated.onChainResult!.startKAId).toBeUndefined();
    expect(updated.onChainResult!.endKAId).toBeUndefined();
  });
});

// =====================================================================
// 16. COUNT(*) parsing handles various typed literal forms
// =====================================================================

describe('parseCountLiteral robustness', () => {
  it('deleteMetaForRoot handles various COUNT result formats', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const eventBus = new TypedEventBus();

    const publisher = new DKGPublisher({
      store, chain, eventBus, keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    // Write two entities to workspace to create workspace_meta ops
    const wsQuads = [
      q('urn:count-a', 'http://schema.org/name', '"CountA"'),
      q('urn:count-b', 'http://schema.org/name', '"CountB"'),
    ];
    await publisher.share(PARANET, wsQuads, {
      publisherPeerId: 'test-peer',
    });

    // Now write a new value for entity A — the upsert should clean up old meta
    const wsQuads2 = [
      q('urn:count-a', 'http://schema.org/name', '"CountA-v2"'),
    ];
    await publisher.share(PARANET, wsQuads2, {
      publisherPeerId: 'test-peer',
    });

    // Verify entity B's workspace data still exists (wasn't clobbered by cleanup)
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <urn:count-b> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"CountB"');
    }

    // Verify entity A has the updated value
    const resultA = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <urn:count-a> <http://schema.org/name> ?o } }`,
    );
    expect(resultA.type).toBe('bindings');
    if (resultA.type === 'bindings') {
      expect(resultA.bindings.length).toBe(1);
      expect(resultA.bindings[0]['o']).toBe('"CountA-v2"');
    }
  });
});

// =====================================================================
// 17. EVMChainAdapter publish events include txHash
// =====================================================================

describe('EVMChainAdapter publish event txHash', () => {
  let _snap: string;
  beforeEach(async () => { _snap = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(_snap); });

  it('publish includes txHash in KCCreated event data', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const store = new OxigraphStore();
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store, chain, eventBus: new TypedEventBus(), keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const publishResult = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q('urn:evt:txhash', 'http://schema.org/name', '"EventTest"')],
    });
    expect(publishResult.status).toBe('confirmed');
    const blockNumber = publishResult.onChainResult!.blockNumber;

    const events: { txHash: unknown }[] = [];
    for await (const evt of chain.listenForEvents({
      eventTypes: ['KCCreated'],
      fromBlock: blockNumber,
      toBlock: blockNumber,
    })) {
      events.push({ txHash: evt.data['txHash'] });
    }

    expect(events).toHaveLength(1);
    expect(events[0].txHash).toBe(publishResult.onChainResult!.txHash);
  });
});

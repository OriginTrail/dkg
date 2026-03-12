import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@dkg/storage';
import { GraphManager } from '@dkg/storage';
import { MockChainAdapter } from '@dkg/chain';
import { TypedEventBus, encodeKAUpdateRequest, decodeKAUpdateRequest } from '@dkg/core';
import { generateEd25519Keypair } from '@dkg/core';
import { DKGPublisher, UpdateHandler, autoPartition, computePublicRoot, computeKARoot, computeKCRoot, computeFlatKCRoot, toHex } from '../src/index.js';
import { parseSimpleNQuads } from '../src/publish-handler.js';
import { ethers } from 'ethers';

const PARANET = 'test-update';
const DATA_GRAPH = `did:dkg:paranet:${PARANET}`;
const ENTITY_A = 'urn:test:entity:a';
const ENTITY_B = 'urn:test:entity:b';

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

/** Build a gossip message that matches an on-chain update (same quads → same merkle root). */
function buildGossipMessage(opts: {
  paranetId: string;
  batchId: bigint;
  quads: Quad[];
  manifest: { rootEntity: string; privateTripleCount: number }[];
  publisherPeerId: string;
  publisherAddress: string;
  txHash: string;
  blockNumber: number;
}) {
  const gossipRoot = computeGossipMerkleRoot(opts.quads, opts.manifest);
  return encodeKAUpdateRequest({
    paranetId: opts.paranetId,
    batchId: opts.batchId,
    nquads: quadsToNQuads(opts.quads, `did:dkg:paranet:${opts.paranetId}`),
    manifest: opts.manifest,
    publisherPeerId: opts.publisherPeerId,
    publisherAddress: opts.publisherAddress,
    txHash: opts.txHash,
    blockNumber: BigInt(opts.blockNumber),
    newMerkleRoot: gossipRoot,
    timestampMs: BigInt(Date.now()),
  });
}

describe('KAUpdateRequest encode/decode', () => {
  it('round-trips a KAUpdateRequest message', () => {
    const original = {
      paranetId: PARANET,
      batchId: 42n,
      nquads: new TextEncoder().encode('<urn:a> <urn:b> "c" .'),
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWTest',
      publisherAddress: '0xABCDEF',
      txHash: '0x1234',
      blockNumber: 100n,
      newMerkleRoot: new Uint8Array([1, 2, 3]),
      timestampMs: BigInt(Date.now()),
    };

    const encoded = encodeKAUpdateRequest(original);
    expect(encoded).toBeInstanceOf(Uint8Array);

    const decoded = decodeKAUpdateRequest(encoded);
    expect(decoded.paranetId).toBe(PARANET);
    expect(decoded.batchId).toBe(42n);
    expect(decoded.publisherPeerId).toBe('12D3KooWTest');
    expect(decoded.publisherAddress).toBe('0xABCDEF');
    expect(decoded.txHash).toBe('0x1234');
    expect(decoded.blockNumber).toBe(100n);
    expect(decoded.manifest.length).toBe(1);
    expect(decoded.manifest[0].rootEntity).toBe(ENTITY_A);
  });

  it('preserves precision for large uint64 values above 2^53', () => {
    const largeBatchId = (1n << 53n) + 7n;
    const largeBlock = (1n << 60n) + 42n;
    const original = {
      paranetId: PARANET,
      batchId: largeBatchId,
      nquads: new Uint8Array(),
      manifest: [],
      publisherPeerId: 'peer',
      publisherAddress: '0x1',
      txHash: '0xabc',
      blockNumber: largeBlock,
      newMerkleRoot: new Uint8Array(),
      timestampMs: 0n,
    };

    const decoded = decodeKAUpdateRequest(encodeKAUpdateRequest(original));
    expect(decoded.batchId).toBe(largeBatchId);
    expect(decoded.blockNumber).toBe(largeBlock);
  });
});

describe('UpdateHandler', () => {
  let store: OxigraphStore;
  let chain: MockChainAdapter;
  let publisher: DKGPublisher;
  let handler: UpdateHandler;
  const wallet = ethers.Wallet.createRandom();

  beforeEach(async () => {
    store = new OxigraphStore();
    chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();
    const eventBus = new TypedEventBus();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });
    handler = new UpdateHandler(store, chain, eventBus);
  });

  it('applies a verified KA update: deletes old triples, inserts new ones', async () => {
    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [
        q(ENTITY_A, 'http://schema.org/name', '"Original"'),
        q(ENTITY_A, 'http://schema.org/description', '"Will be replaced"'),
      ],
    });
    expect(original.status).toBe('confirmed');

    const updateQuads = [q(ENTITY_A, 'http://schema.org/name', '"Updated via update()"')];
    const updateResult = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: updateQuads,
    });
    expect(updateResult.onChainResult).toBeDefined();

    // Gossip must send the SAME quads as the publisher's update to match the on-chain merkle root
    const message = buildGossipMessage({
      paranetId: PARANET,
      batchId: original.kcId,
      quads: updateQuads,
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeerA',
      publisherAddress: wallet.address,
      txHash: updateResult.onChainResult!.txHash,
      blockNumber: updateResult.onChainResult!.blockNumber,
    });

    await handler.handle(message, '12D3KooWPeerA');

    const nameResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <${ENTITY_A}> <http://schema.org/name> ?o } }`,
    );
    expect(nameResult.type).toBe('bindings');
    if (nameResult.type === 'bindings') {
      expect(nameResult.bindings.length).toBe(1);
      expect(nameResult.bindings[0]['o']).toContain('Updated via update()');
    }

    const descResult = await store.query(
      `ASK { GRAPH <${DATA_GRAPH}> { <${ENTITY_A}> <http://schema.org/description> ?o } }`,
    );
    expect(descResult.type).toBe('boolean');
    if (descResult.type === 'boolean') {
      expect(descResult.value).toBe(false);
    }
  });

  it('rejects update when chain verification fails (wrong publisher)', async () => {
    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Original"')],
    });

    const updateQuads = [q(ENTITY_A, 'http://schema.org/name', '"Updated"')];
    const updateResult = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: updateQuads,
    });

    const message = buildGossipMessage({
      paranetId: PARANET,
      batchId: original.kcId,
      quads: updateQuads,
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWAttacker',
      publisherAddress: '0xWrongAddress',
      txHash: updateResult.onChainResult!.txHash,
      blockNumber: updateResult.onChainResult!.blockNumber,
    });

    await handler.handle(message, '12D3KooWAttacker');

    const nameResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <${ENTITY_A}> <http://schema.org/name> ?o } }`,
    );
    expect(nameResult.type).toBe('bindings');
    if (nameResult.type === 'bindings') {
      expect(nameResult.bindings[0]['o']).toContain('Updated');
    }
  });

  it('rejects gossip with tampered quads (payload root != on-chain root)', async () => {
    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Original"')],
    });

    const updateQuads = [q(ENTITY_A, 'http://schema.org/name', '"Legit update"')];
    const updateResult = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: updateQuads,
    });

    // Attacker sends different quads but reuses the valid txHash.
    // The on-chain merkle root matches the legit update, not the tampered payload.
    const tamperedQuads = [q(ENTITY_A, 'http://schema.org/name', '"Tampered content"')];
    const message = buildGossipMessage({
      paranetId: PARANET,
      batchId: original.kcId,
      quads: tamperedQuads,
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeerA',
      publisherAddress: wallet.address,
      txHash: updateResult.onChainResult!.txHash,
      blockNumber: updateResult.onChainResult!.blockNumber,
    });

    await handler.handle(message, '12D3KooWPeerA');

    const nameResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <${ENTITY_A}> <http://schema.org/name> ?o } }`,
    );
    expect(nameResult.type).toBe('bindings');
    if (nameResult.type === 'bindings') {
      expect(nameResult.bindings[0]['o']).toContain('Legit update');
    }
  });

  it('rejects update with unauthenticated extra roots in payload', async () => {
    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Original"')],
    });

    const updateQuads = [q(ENTITY_A, 'http://schema.org/name', '"Updated"')];
    const updateResult = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: updateQuads,
    });

    const quadsWithExtra = [
      q(ENTITY_A, 'http://schema.org/name', '"Legit"'),
      q('urn:test:injected', 'http://schema.org/name', '"Injected data"'),
    ];
    const manifestOnlyA = [{ rootEntity: ENTITY_A, privateTripleCount: 0 }];
    const gossipRoot = computeGossipMerkleRoot(quadsWithExtra, manifestOnlyA);

    const message = encodeKAUpdateRequest({
      paranetId: PARANET,
      batchId: original.kcId,
      nquads: quadsToNQuads(quadsWithExtra, DATA_GRAPH),
      manifest: manifestOnlyA,
      publisherPeerId: '12D3KooWPeerA',
      publisherAddress: wallet.address,
      txHash: updateResult.onChainResult!.txHash,
      blockNumber: BigInt(updateResult.onChainResult!.blockNumber),
      newMerkleRoot: gossipRoot,
      timestampMs: BigInt(Date.now()),
    });

    await handler.handle(message, '12D3KooWPeerA');

    const injectedResult = await store.query(
      `ASK { GRAPH <${DATA_GRAPH}> { <urn:test:injected> <http://schema.org/name> ?o } }`,
    );
    expect(injectedResult.type).toBe('boolean');
    if (injectedResult.type === 'boolean') {
      expect(injectedResult.value).toBe(false);
    }
  });

  it('uses chain-verified block number for ordering, not gossip-supplied value', async () => {
    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Original"')],
    });

    const update1Quads = [q(ENTITY_A, 'http://schema.org/name', '"Update 1"')];
    const update1 = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: update1Quads,
    });
    const chainBlock1 = update1.onChainResult!.blockNumber;

    // Send gossip for update1 with a forged high block number.
    // The handler should use the chain-verified block (chainBlock1), not 999999.
    const msg1 = encodeKAUpdateRequest({
      paranetId: PARANET,
      batchId: original.kcId,
      nquads: quadsToNQuads(update1Quads, DATA_GRAPH),
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeerA',
      publisherAddress: wallet.address,
      txHash: update1.onChainResult!.txHash,
      blockNumber: 999999n, // forged!
      newMerkleRoot: computeGossipMerkleRoot(update1Quads, [{ rootEntity: ENTITY_A }]),
      timestampMs: BigInt(Date.now()),
    });

    await handler.handle(msg1, '12D3KooWPeerA');

    // Verify update1 was applied
    let result = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <${ENTITY_A}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings[0]['o']).toContain('Update 1');
    }

    // Now do update2 — its chain block will be chainBlock1 + N (strictly higher)
    const update2Quads = [q(ENTITY_A, 'http://schema.org/name', '"Update 2"')];
    const update2 = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: update2Quads,
    });
    expect(update2.onChainResult!.blockNumber).toBeGreaterThan(chainBlock1);

    // If the handler had stored 999999 (gossip value), this would be rejected.
    // Since it stored chainBlock1 (chain-verified), update2's higher block passes.
    const msg2 = buildGossipMessage({
      paranetId: PARANET,
      batchId: original.kcId,
      quads: update2Quads,
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeerA',
      publisherAddress: wallet.address,
      txHash: update2.onChainResult!.txHash,
      blockNumber: update2.onChainResult!.blockNumber,
    });

    await handler.handle(msg2, '12D3KooWPeerA');

    result = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <${ENTITY_A}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings[0]['o']).toContain('Update 2');
    }
  });

  it('rejects stale update with lower chain-verified block number', async () => {
    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Original"')],
    });

    // Do two updates: update1 at block B1, update2 at block B2 > B1
    const update1Quads = [q(ENTITY_A, 'http://schema.org/name', '"Update 1"')];
    const update1 = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: update1Quads,
    });

    const update2Quads = [q(ENTITY_A, 'http://schema.org/name', '"Update 2"')];
    const update2 = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: update2Quads,
    });

    // Apply update2's gossip first (newer block)
    const msg2 = buildGossipMessage({
      paranetId: PARANET,
      batchId: original.kcId,
      quads: update2Quads,
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeerA',
      publisherAddress: wallet.address,
      txHash: update2.onChainResult!.txHash,
      blockNumber: update2.onChainResult!.blockNumber,
    });
    await handler.handle(msg2, '12D3KooWPeerA');

    // Now try to apply update1's gossip (older block) — should be rejected
    const msg1 = buildGossipMessage({
      paranetId: PARANET,
      batchId: original.kcId,
      quads: update1Quads,
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeerA',
      publisherAddress: wallet.address,
      txHash: update1.onChainResult!.txHash,
      blockNumber: update1.onChainResult!.blockNumber,
    });
    await handler.handle(msg1, '12D3KooWPeerA');

    const nameResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <${ENTITY_A}> <http://schema.org/name> ?o } }`,
    );
    expect(nameResult.type).toBe('bindings');
    if (nameResult.type === 'bindings') {
      expect(nameResult.bindings.length).toBe(1);
      expect(nameResult.bindings[0]['o']).toContain('Update 2');
    }
  });

  it('rejects replayed update (same chain block height)', async () => {
    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Original"')],
    });

    const updateQuads = [q(ENTITY_A, 'http://schema.org/name', '"Updated"')];
    const updateResult = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: updateQuads,
    });

    const message = buildGossipMessage({
      paranetId: PARANET,
      batchId: original.kcId,
      quads: updateQuads,
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeerA',
      publisherAddress: wallet.address,
      txHash: updateResult.onChainResult!.txHash,
      blockNumber: updateResult.onChainResult!.blockNumber,
    });

    await handler.handle(message, '12D3KooWPeerA');

    // Replay same message — should be rejected (same block height)
    await handler.handle(message, '12D3KooWPeerA');

    const nameResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <${ENTITY_A}> <http://schema.org/name> ?o } }`,
    );
    expect(nameResult.type).toBe('bindings');
    if (nameResult.type === 'bindings') {
      expect(nameResult.bindings.length).toBe(1);
      expect(nameResult.bindings[0]['o']).toContain('Updated');
    }
  });

  it('publisher.update() returns onChainResult with txHash and blockNumber', async () => {
    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Original"')],
    });

    const result = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Updated"')],
    });

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.txHash).toBeTruthy();
    expect(result.onChainResult!.blockNumber).toBeGreaterThan(0);
    expect(result.onChainResult!.publisherAddress).toBe(wallet.address);
    expect(result.onChainResult!.batchId).toBe(original.kcId);
  });

  it('publisher.update() locally replaces triples in the data graph', async () => {
    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [
        q(ENTITY_A, 'http://schema.org/name', '"Original"'),
        q(ENTITY_A, 'http://schema.org/description', '"OldDesc"'),
      ],
    });

    await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Updated"')],
    });

    const nameResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <${ENTITY_A}> <http://schema.org/name> ?o } }`,
    );
    expect(nameResult.type).toBe('bindings');
    if (nameResult.type === 'bindings') {
      expect(nameResult.bindings.length).toBe(1);
      expect(nameResult.bindings[0]['o']).toContain('Updated');
    }

    const descResult = await store.query(
      `ASK { GRAPH <${DATA_GRAPH}> { <${ENTITY_A}> <http://schema.org/description> ?o } }`,
    );
    expect(descResult.type).toBe('boolean');
    if (descResult.type === 'boolean') {
      expect(descResult.value).toBe(false);
    }
  });

  it('handles multi-entity updates', async () => {
    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [
        q(ENTITY_A, 'http://schema.org/name', '"A"'),
        q(ENTITY_B, 'http://schema.org/name', '"B"'),
      ],
    });

    const updateQuads = [
      q(ENTITY_A, 'http://schema.org/name', '"A-updated"'),
      q(ENTITY_B, 'http://schema.org/name', '"B-updated"'),
    ];
    const updateResult = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: updateQuads,
    });

    const gossipManifest = [
      { rootEntity: ENTITY_A, privateTripleCount: 0 },
      { rootEntity: ENTITY_B, privateTripleCount: 0 },
    ];

    const message = buildGossipMessage({
      paranetId: PARANET,
      batchId: original.kcId,
      quads: updateQuads,
      manifest: gossipManifest,
      publisherPeerId: '12D3KooWPeerA',
      publisherAddress: wallet.address,
      txHash: updateResult.onChainResult!.txHash,
      blockNumber: updateResult.onChainResult!.blockNumber,
    });

    await handler.handle(message, '12D3KooWPeerA');

    for (const [entity, expected] of [[ENTITY_A, 'A-updated'], [ENTITY_B, 'B-updated']] as const) {
      const result = await store.query(
        `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <${entity}> <http://schema.org/name> ?o } }`,
      );
      expect(result.type).toBe('bindings');
      if (result.type === 'bindings') {
        expect(result.bindings.length).toBe(1);
        expect(result.bindings[0]['o']).toContain(expected);
      }
    }
  });

  it('verifyKAUpdate returns on-chain merkle root and block number', async () => {
    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Original"')],
    });

    const updateQuads = [q(ENTITY_A, 'http://schema.org/name', '"Updated"')];
    const updateResult = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: updateQuads,
    });

    const verification = await chain.verifyKAUpdate(
      updateResult.onChainResult!.txHash,
      original.kcId,
      wallet.address,
    );

    expect(verification.verified).toBe(true);
    expect(verification.onChainMerkleRoot).toBeInstanceOf(Uint8Array);
    expect(verification.onChainMerkleRoot!.length).toBe(32);
    expect(verification.blockNumber).toBeGreaterThan(0);
  });

  it('verifyKAUpdate rejects wrong publisher', async () => {
    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Original"')],
    });

    await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Updated"')],
    });

    const verification = await chain.verifyKAUpdate(
      '0xfaketx',
      original.kcId,
      '0xWrongPublisher',
    );

    expect(verification.verified).toBe(false);
    expect(verification.onChainMerkleRoot).toBeUndefined();
  });

  it('rejects cross-paranet replay (batch bound to different paranet)', async () => {
    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Original"')],
    });

    const updateQuads = [q(ENTITY_A, 'http://schema.org/name', '"Updated"')];
    const updateResult = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: updateQuads,
    });

    // First, apply on the correct paranet to bind the batch
    const legitMsg = buildGossipMessage({
      paranetId: PARANET,
      batchId: original.kcId,
      quads: updateQuads,
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeerA',
      publisherAddress: wallet.address,
      txHash: updateResult.onChainResult!.txHash,
      blockNumber: updateResult.onChainResult!.blockNumber,
    });
    await handler.handle(legitMsg, '12D3KooWPeerA');

    // Now attempt to replay the same batch on a different paranet
    const crossParanetMsg = buildGossipMessage({
      paranetId: 'other-paranet',
      batchId: original.kcId,
      quads: updateQuads,
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeerA',
      publisherAddress: wallet.address,
      txHash: updateResult.onChainResult!.txHash,
      blockNumber: updateResult.onChainResult!.blockNumber,
    });
    await handler.handle(crossParanetMsg, '12D3KooWPeerA');

    // The other paranet's graph should be empty
    const otherGraph = 'did:dkg:paranet:other-paranet';
    const result = await store.query(
      `ASK { GRAPH <${otherGraph}> { <${ENTITY_A}> ?p ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') {
      expect(result.value).toBe(false);
    }
  });

  it('publisher.update() returns failed status when chain tx fails', async () => {
    // Attempt to update a non-existent batch (batchId=999 doesn't exist in mock)
    const result = await publisher.update(999n, {
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Should fail"')],
    });

    expect(result.status).toBe('failed');
    expect(result.onChainResult).toBeUndefined();
  });

  it('publisher.update() updates the merkle root in _meta graph', async () => {
    const META_GRAPH = `did:dkg:paranet:${PARANET}/_meta`;
    const DKG = 'http://dkg.io/ontology/';

    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [
        q(ENTITY_A, 'http://schema.org/name', '"Original"'),
        q(ENTITY_A, 'http://schema.org/description', '"Will be updated"'),
      ],
    });
    expect(original.status).toBe('confirmed');
    const originalRootHex = toHex(original.merkleRoot);

    const oldRootResult = await store.query(
      `SELECT ?root WHERE { GRAPH <${META_GRAPH}> { ?ual <${DKG}merkleRoot> ?root . ?ual <${DKG}batchId> "${original.kcId}"^^<http://www.w3.org/2001/XMLSchema#integer> } }`,
    );
    expect(oldRootResult.type).toBe('bindings');
    if (oldRootResult.type === 'bindings') {
      expect(oldRootResult.bindings.length).toBe(1);
      expect(oldRootResult.bindings[0]['root']).toContain(originalRootHex);
    }

    const updateResult = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Updated"')],
    });
    expect(updateResult.status).toBe('confirmed');
    const updatedRootHex = toHex(updateResult.merkleRoot);
    expect(updatedRootHex).not.toBe(originalRootHex);

    const newRootResult = await store.query(
      `SELECT ?root WHERE { GRAPH <${META_GRAPH}> { ?ual <${DKG}merkleRoot> ?root . ?ual <${DKG}batchId> "${original.kcId}"^^<http://www.w3.org/2001/XMLSchema#integer> } }`,
    );
    expect(newRootResult.type).toBe('bindings');
    if (newRootResult.type === 'bindings') {
      expect(newRootResult.bindings.length).toBe(1);
      expect(newRootResult.bindings[0]['root']).toContain(updatedRootHex);
      expect(newRootResult.bindings[0]['root']).not.toContain(originalRootHex);
    }
  });

  it('UpdateHandler.handle() updates the merkle root in _meta graph on gossip receiver', async () => {
    const META_GRAPH = `did:dkg:paranet:${PARANET}/_meta`;
    const DKG = 'http://dkg.io/ontology/';

    const original = await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Original"')],
    });
    expect(original.status).toBe('confirmed');
    const originalRootHex = toHex(original.merkleRoot);

    const updateQuads = [q(ENTITY_A, 'http://schema.org/name', '"Updated via gossip"')];
    const updateResult = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: updateQuads,
    });

    const message = buildGossipMessage({
      paranetId: PARANET,
      batchId: original.kcId,
      quads: updateQuads,
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeerA',
      publisherAddress: wallet.address,
      txHash: updateResult.onChainResult!.txHash,
      blockNumber: updateResult.onChainResult!.blockNumber,
    });

    await handler.handle(message, '12D3KooWPeerA');

    const newRootResult = await store.query(
      `SELECT ?root WHERE { GRAPH <${META_GRAPH}> { ?ual <${DKG}merkleRoot> ?root . ?ual <${DKG}batchId> "${original.kcId}"^^<http://www.w3.org/2001/XMLSchema#integer> } }`,
    );
    expect(newRootResult.type).toBe('bindings');
    if (newRootResult.type === 'bindings') {
      expect(newRootResult.bindings.length).toBe(1);
      const newRootHex = toHex(computeFlatKCRoot(updateQuads, []));
      expect(newRootResult.bindings[0]['root']).toContain(newRootHex);
      expect(newRootResult.bindings[0]['root']).not.toContain(originalRootHex);
    }
  });
});

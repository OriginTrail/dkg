import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@dkg/storage';
import { GraphManager } from '@dkg/storage';
import { MockChainAdapter } from '@dkg/chain';
import { TypedEventBus, encodeKAUpdateRequest, decodeKAUpdateRequest } from '@dkg/core';
import { generateEd25519Keypair } from '@dkg/core';
import { DKGPublisher, UpdateHandler } from '../src/index.js';
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

describe('KAUpdateRequest encode/decode', () => {
  it('round-trips a KAUpdateRequest message', () => {
    const original = {
      paranetId: PARANET,
      batchId: 42,
      nquads: new TextEncoder().encode('<urn:a> <urn:b> "c" .'),
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWTest',
      publisherAddress: '0xABCDEF',
      txHash: '0x1234',
      blockNumber: 100,
      newMerkleRoot: new Uint8Array([1, 2, 3]),
      timestampMs: Date.now(),
    };

    const encoded = encodeKAUpdateRequest(original);
    expect(encoded).toBeInstanceOf(Uint8Array);

    const decoded = decodeKAUpdateRequest(encoded);
    expect(decoded.paranetId).toBe(PARANET);
    expect(decoded.batchId).toBe(42);
    expect(decoded.publisherPeerId).toBe('12D3KooWTest');
    expect(decoded.publisherAddress).toBe('0xABCDEF');
    expect(decoded.txHash).toBe('0x1234');
    expect(decoded.blockNumber).toBe(100);
    expect(decoded.manifest.length).toBe(1);
    expect(decoded.manifest[0].rootEntity).toBe(ENTITY_A);
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

    const updateResult = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: [
        q(ENTITY_A, 'http://schema.org/name', '"Updated via update()"'),
      ],
    });
    expect(updateResult.onChainResult).toBeDefined();

    const newQuads = [q(ENTITY_A, 'http://schema.org/name', '"From gossip update"')];
    const message = encodeKAUpdateRequest({
      paranetId: PARANET,
      batchId: original.kcId,
      nquads: quadsToNQuads(newQuads, DATA_GRAPH),
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWPeerA',
      publisherAddress: wallet.address,
      txHash: updateResult.onChainResult!.txHash,
      blockNumber: updateResult.onChainResult!.blockNumber,
      newMerkleRoot: updateResult.merkleRoot,
      timestampMs: Date.now(),
    });

    await handler.handle(message, '12D3KooWPeerA');

    const nameResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${DATA_GRAPH}> { <${ENTITY_A}> <http://schema.org/name> ?o } }`,
    );
    expect(nameResult.type).toBe('bindings');
    if (nameResult.type === 'bindings') {
      expect(nameResult.bindings.length).toBe(1);
      expect(nameResult.bindings[0]['o']).toContain('From gossip update');
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

    const updateResult = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: [q(ENTITY_A, 'http://schema.org/name', '"Updated"')],
    });

    const attackerQuads = [q(ENTITY_A, 'http://schema.org/name', '"Attacker override"')];
    const message = encodeKAUpdateRequest({
      paranetId: PARANET,
      batchId: original.kcId,
      nquads: quadsToNQuads(attackerQuads, DATA_GRAPH),
      manifest: [{ rootEntity: ENTITY_A, privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWAttacker',
      publisherAddress: '0xWrongAddress',
      txHash: updateResult.onChainResult!.txHash,
      blockNumber: updateResult.onChainResult!.blockNumber,
      newMerkleRoot: updateResult.merkleRoot,
      timestampMs: Date.now(),
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
      quads: [
        q(ENTITY_A, 'http://schema.org/name', '"Updated"'),
      ],
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

    const updateResult = await publisher.update(original.kcId, {
      paranetId: PARANET,
      quads: [
        q(ENTITY_A, 'http://schema.org/name', '"A-updated"'),
        q(ENTITY_B, 'http://schema.org/name', '"B-updated"'),
      ],
    });

    const newQuads = [
      q(ENTITY_A, 'http://schema.org/name', '"A-gossip"'),
      q(ENTITY_B, 'http://schema.org/name', '"B-gossip"'),
    ];
    const message = encodeKAUpdateRequest({
      paranetId: PARANET,
      batchId: original.kcId,
      nquads: quadsToNQuads(newQuads, DATA_GRAPH),
      manifest: [
        { rootEntity: ENTITY_A, privateTripleCount: 0 },
        { rootEntity: ENTITY_B, privateTripleCount: 0 },
      ],
      publisherPeerId: '12D3KooWPeerA',
      publisherAddress: wallet.address,
      txHash: updateResult.onChainResult!.txHash,
      blockNumber: updateResult.onChainResult!.blockNumber,
      newMerkleRoot: updateResult.merkleRoot,
      timestampMs: Date.now(),
    });

    await handler.handle(message, '12D3KooWPeerA');

    for (const [entity, expected] of [[ENTITY_A, 'A-gossip'], [ENTITY_B, 'B-gossip']] as const) {
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
});

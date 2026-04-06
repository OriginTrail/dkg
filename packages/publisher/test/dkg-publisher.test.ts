import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { DKGPublisher } from '../src/dkg-publisher.js';
import type { Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

const PARANET = 'agent-registry';
const GRAPH = `did:dkg:context-graph:${PARANET}`;
const ENTITY = 'did:dkg:agent:QmImageBot';
const ENTITY2 = 'did:dkg:agent:QmTextBot';
const TEST_WALLET = ethers.Wallet.createRandom();
const TEST_PUBLISHER_ADDRESS = TEST_WALLET.address;

function q(s: string, p: string, o: string, g = GRAPH): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('DKGPublisher', () => {
  let publisher: DKGPublisher;
  let store: OxigraphStore;
  let chain: MockChainAdapter;
  let eventBus: TypedEventBus;

  beforeEach(async () => {
    store = new OxigraphStore();
    chain = new MockChainAdapter('mock:31337', TEST_PUBLISHER_ADDRESS);
    eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });
  });

  it('publishes a single KA', async () => {
    const result = await publisher.publish({
      contextGraphId: PARANET,
      quads: [
        q(ENTITY, 'http://schema.org/name', '"ImageBot"'),
        q(ENTITY, 'http://schema.org/description', '"Analyzes images"'),
      ],
    });

    expect(result.merkleRoot).toHaveLength(32);
    expect(result.kaManifest).toHaveLength(1);
    expect(result.kaManifest[0].rootEntity).toBe(ENTITY);
    expect(result.status).toBe('confirmed');

    const count = await store.countQuads(GRAPH);
    expect(count).toBe(2);

    const metaGraph = `did:dkg:context-graph:${PARANET}/_meta`;
    const metaCount = await store.countQuads(metaGraph);
    expect(metaCount).toBeGreaterThan(0);
  });

  it('publishes multiple KAs in one KC', async () => {
    const result = await publisher.publish({
      contextGraphId: PARANET,
      quads: [
        q(ENTITY, 'http://schema.org/name', '"ImageBot"'),
        q(ENTITY2, 'http://schema.org/name', '"TextBot"'),
      ],
    });

    expect(result.kaManifest).toHaveLength(2);
    expect(result.kaManifest.map((m) => m.rootEntity).sort()).toEqual(
      [ENTITY, ENTITY2].sort(),
    );
    expect(result.status).toBe('confirmed');
  });

  it('publishes with blank nodes (auto-skolemized)', async () => {
    const result = await publisher.publish({
      contextGraphId: PARANET,
      quads: [
        q(ENTITY, 'http://schema.org/name', '"ImageBot"'),
        q(ENTITY, 'http://ex.org/offers', '_:o1'),
        q('_:o1', 'http://ex.org/type', '"ImageAnalysis"'),
      ],
    });

    expect(result.kaManifest).toHaveLength(1);
    expect(result.status).toBe('confirmed');

    const queryResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } }`,
    );
    if (queryResult.type === 'bindings') {
      const subjects = queryResult.bindings.map((b) => b['s']);
      const hasSkolemized = subjects.some((s) =>
        s.includes('/.well-known/genid/'),
      );
      expect(hasSkolemized).toBe(true);
    }
  });

  it('publishes with private triples', async () => {
    const result = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"ImageBot"')],
      privateQuads: [q(ENTITY, 'http://ex.org/apiKey', '"secret-key-123"')],
      publisherPeerId: '12D3KooWTestPublisher',
    });

    expect(result.kaManifest[0].privateTripleCount).toBe(1);
    expect(result.kaManifest[0].privateMerkleRoot).toBeDefined();
    expect(result.kaManifest[0].privateMerkleRoot!).toHaveLength(32);
    expect(result.status).toBe('confirmed');
  });

  it('rejects duplicate entity (exclusivity)', async () => {
    await publisher.publish({
      contextGraphId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"ImageBot"')],
    });

    await expect(
      publisher.publish({
        contextGraphId: PARANET,
        quads: [q(ENTITY, 'http://schema.org/name', '"Duplicate"')],
      }),
    ).rejects.toThrow('Validation failed');
  });

  it('updates an existing KC', async () => {
    const initial = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"OldName"')],
    });

    const updated = await publisher.update(initial.kcId, {
      contextGraphId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"NewName"')],
    });

    expect(updated.merkleRoot).not.toEqual(initial.merkleRoot);
    expect(updated.status).toBe('confirmed');

    const result = await store.query(
      `SELECT ?name WHERE { GRAPH <${GRAPH}> { <${ENTITY}> <http://schema.org/name> ?name } }`,
    );
    if (result.type === 'bindings') {
      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0]['name']).toBe('"NewName"');
    }
  });

  it('emits KC_PUBLISHED event', async () => {
    let emitted = false;
    eventBus.on('kc:published', () => {
      emitted = true;
    });

    await publisher.publish({
      contextGraphId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"Bot"')],
    });

    expect(emitted).toBe(true);
  });

  it('publishes with confirmed status and onChainResult', async () => {
    const result = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"ImageBot"')],
    });

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.batchId).toBeTypeOf('bigint');
    expect(result.onChainResult!.txHash).toBeTypeOf('string');
    expect(result.onChainResult!.blockNumber).toBeTypeOf('number');
    expect(result.onChainResult!.blockTimestamp).toBeTypeOf('number');
    expect(result.onChainResult!.publisherAddress).toBeTypeOf('string');
    expect(result.onChainResult!.startKAId).toBeDefined();
    expect(result.onChainResult!.endKAId).toBeDefined();
  });

  it('generates address-based UAL format', async () => {
    const result = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"ImageBot"')],
    });

    const metaGraph = `did:dkg:context-graph:${PARANET}/_meta`;
    const metaResult = await store.query(
      `SELECT ?ual WHERE { GRAPH <${metaGraph}> { ?ual <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/KnowledgeCollection> } }`,
    );

    expect(metaResult.type).toBe('bindings');
    if (metaResult.type === 'bindings') {
      expect(metaResult.bindings).toHaveLength(1);
      const ual = metaResult.bindings[0]['ual'];
      // V9 UAL: did:dkg:{chainId}/{publisherAddress}/{startKAId}
      expect(ual).toMatch(/^did:dkg:mock:31337\/0x[0-9a-fA-F]{40}\/\d+$/);
      expect(ual).toContain(result.onChainResult!.publisherAddress);
    }
  });

  it('derives publisherAddress from private key', async () => {
    const result = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"ImageBot"')],
    });

    expect(result.onChainResult!.publisherAddress.toLowerCase()).toBe(
      TEST_PUBLISHER_ADDRESS.toLowerCase(),
    );
  });

  it('stores only confirmed status in meta graph on successful publish', async () => {
    await publisher.publish({
      contextGraphId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"ImageBot"')],
    });

    const metaGraph = `did:dkg:context-graph:${PARANET}/_meta`;
    const statusResult = await store.query(
      `SELECT ?status WHERE { GRAPH <${metaGraph}> { ?ual <http://dkg.io/ontology/status> ?status } }`,
    );

    expect(statusResult.type).toBe('bindings');
    if (statusResult.type === 'bindings') {
      const statuses = statusResult.bindings.map((b) => b['status']);
      // Clean model: either tentative or confirmed, never both. On success we have only confirmed.
      expect(statuses).toHaveLength(1);
      expect(statuses.some((s) => s.includes('confirmed'))).toBe(true);
      expect(statuses.some((s) => s.includes('tentative'))).toBe(false);
    }
  });
});

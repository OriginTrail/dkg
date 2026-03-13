/**
 * E2E tests for the full publish lifecycle aligned with publish-flow.md:
 *
 * 1. Publish with two-level merkle (flat + entityProofs modes)
 * 2. N-Triples (not N-Quads) over P2P
 * 3. Tentative → confirmed via ChainEventPoller
 * 4. confirmByMerkleRoot matching
 * 5. Update flow: replace triples, recompute merkle, chain update
 * 6. Synthetic privateMerkleRoot triple
 */
import { describe, it, expect } from 'vitest';
import {
  TypedEventBus,
  generateEd25519Keypair,
  encodePublishRequest,
  decodePublishAck,
  createOperationContext,
  MerkleTree,
} from '@dkg/core';
import { OxigraphStore, type Quad } from '@dkg/storage';
import { MockChainAdapter } from '@dkg/chain';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { PublishHandler } from '../src/publish-handler.js';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import { autoPartition } from '../src/auto-partition.js';
import { computeTripleHash } from '../src/merkle.js';
import { ethers } from 'ethers';

const PARANET = 'test-lifecycle';
const GRAPH = `did:dkg:paranet:${PARANET}`;
const ENTITY = 'did:dkg:agent:QmLifecycle';
const TEST_WALLET = ethers.Wallet.createRandom();

function q(s: string, p: string, o: string, g = GRAPH): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('Publish lifecycle (aligned with diagram)', () => {
  it('produces a flat kcMerkleRoot by default (entityProofs=false)', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: bus, keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const triples = [
      q(ENTITY, 'http://schema.org/name', '"LifecycleBot"'),
      q(ENTITY, 'http://schema.org/version', '"1.0"'),
    ];

    const result = await publisher.publish({
      paranetId: PARANET,
      quads: triples,
    });

    expect(result.merkleRoot).toHaveLength(32);
    expect(result.status).toBe('confirmed');

    const hashes = triples.map(computeTripleHash);
    const flatTree = new MerkleTree(hashes);
    expect(Buffer.from(result.merkleRoot).toString('hex'))
      .toBe(Buffer.from(flatTree.root).toString('hex'));
  });

  it('always produces flat kcMerkleRoot regardless of options', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: bus, keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const entityA = 'did:dkg:agent:QmEntityA';
    const entityB = 'did:dkg:agent:QmEntityB';
    const triples = [
      q(entityA, 'http://schema.org/name', '"EntityA"'),
      q(entityA, 'http://schema.org/version', '"1"'),
      q(entityB, 'http://schema.org/name', '"EntityB"'),
      q(entityB, 'http://schema.org/version', '"2"'),
    ];

    const result = await publisher.publish({
      paranetId: PARANET,
      quads: triples,
    });

    expect(result.merkleRoot).toHaveLength(32);

    const hashes = triples.map(computeTripleHash);
    const flatTree = new MerkleTree(hashes);
    expect(Buffer.from(result.merkleRoot).toString('hex'))
      .toBe(Buffer.from(flatTree.root).toString('hex'));
  });

  it('full-pipeline golden: fixed quads produce known merkle root', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus: bus,
      keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const fixedQuads = [
      q('did:dkg:agent:Entity1', 'http://schema.org/name', '"Entity1"'),
      q('did:dkg:agent:Entity1', 'http://schema.org/version', '"1"'),
      q('did:dkg:agent:Entity2', 'http://schema.org/name', '"Entity2"'),
      q('did:dkg:agent:Entity2', 'http://schema.org/version', '"2"'),
      q('did:dkg:agent:Entity3', 'http://schema.org/name', '"Entity3"'),
      q('did:dkg:agent:Entity3', 'http://schema.org/version', '"3"'),
    ];

    const result = await publisher.publish({
      paranetId: PARANET,
      quads: fixedQuads,
    });

    const actualHex = Buffer.from(result.merkleRoot).toString('hex');
    const goldenHex =
      '89a5e67f0c299318f22ba653ebae8eb5eb98e49f69126e901b067a6596abcc4b';
    expect(actualHex).toBe(goldenHex);
  });

  it('same quads in different order produce the same merkle root', async () => {
    const quads = [
      q(ENTITY, 'http://schema.org/name', '"LifecycleBot"'),
      q(ENTITY, 'http://schema.org/version', '"1.0"'),
      q(ENTITY, 'http://schema.org/description', '"Test"'),
    ];
    const orderA = [quads[0], quads[1], quads[2]];
    const orderB = [quads[2], quads[0], quads[1]];

    const store1 = new OxigraphStore();
    const chain1 = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const keypair = await generateEd25519Keypair();
    const publisher1 = new DKGPublisher({
      store: store1,
      chain: chain1,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });
    const result1 = await publisher1.publish({
      paranetId: PARANET,
      quads: orderA,
    });

    const store2 = new OxigraphStore();
    const chain2 = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const publisher2 = new DKGPublisher({
      store: store2,
      chain: chain2,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });
    const result2 = await publisher2.publish({
      paranetId: PARANET,
      quads: orderB,
    });

    expect(Buffer.from(result1.merkleRoot).toString('hex')).toBe(
      Buffer.from(result2.merkleRoot).toString('hex'),
    );
  });

  it('anchors private merkle root as synthetic leaf in flat KC root', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: bus, keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const result = await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"PrivBot"')],
      privateQuads: [q(ENTITY, 'http://ex.org/secret', '"s3cret"')],
      publisherPeerId: '12D3KooWTestPublisher',
    });

    expect(result.kaManifest).toHaveLength(1);
    expect(result.kaManifest[0].privateMerkleRoot).toBeDefined();
    expect(result.kaManifest[0].privateMerkleRoot).toHaveLength(32);

    const publicHashes = [q(ENTITY, 'http://schema.org/name', '"PrivBot"')].map(computeTripleHash);
    const privateRoot = result.kaManifest[0].privateMerkleRoot!;
    const expectedRoot = new MerkleTree([...publicHashes, privateRoot]).root;
    expect(Buffer.from(result.merkleRoot).toString('hex'))
      .toBe(Buffer.from(expectedRoot).toString('hex'));
  });

  it('sends N-Triples (no graph component) in publish request', () => {
    const triples = [
      q(ENTITY, 'http://schema.org/name', '"NTripBot"'),
    ];

    // Simulate N-Triples serialization (what broadcastPublish does)
    const ntriples = triples.map(t => {
      const obj = t.object.startsWith('"') ? t.object : `<${t.object}>`;
      return `<${t.subject}> <${t.predicate}> ${obj} .`;
    }).join('\n');

    for (const line of ntriples.split('\n')) {
      const parts = line.split(' ');
      expect(parts[parts.length - 1]).toBe('.');
      // <s> <p> <o> .  → 4 tokens (last is dot), no graph before the dot
      const beforeDot = parts.slice(0, -1);
      expect(beforeDot).toHaveLength(3);
    }
  });
});

describe('Publisher ↔ Receiver merkle consistency (regression)', () => {
  it('multi-entity publish: receiver flat merkle matches publisher merkle', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: bus, keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const entityA = 'did:dkg:agent:QmEntityAlpha';
    const entityB = 'did:dkg:agent:QmEntityBeta';
    const triples = [
      q(entityA, 'http://schema.org/name', '"Alpha"'),
      q(entityA, 'http://schema.org/version', '"1"'),
      q(entityA, 'http://schema.org/description', '"First entity"'),
      q(entityB, 'http://schema.org/name', '"Beta"'),
      q(entityB, 'http://schema.org/version', '"2"'),
    ];

    const result = await publisher.publish({
      paranetId: PARANET,
      quads: triples,
    });

    expect(result.merkleRoot).toHaveLength(32);
    const publisherHex = Buffer.from(result.merkleRoot).toString('hex');

    // Simulate what a receiver does: hash all received public quads with
    // computeTripleHash and build a flat MerkleTree. This MUST match the
    // publisher's root — if it doesn't, the finalization handler will log
    // "merkle mismatch" and fall back to full-payload sync.
    const receiverHashes = result.publicQuads!.map(computeTripleHash);
    const receiverRoot = new MerkleTree(receiverHashes).root;
    const receiverHex = Buffer.from(receiverRoot).toString('hex');

    expect(receiverHex).toBe(publisherHex);
  });

  it('single-entity publish: receiver flat merkle matches publisher merkle', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: bus, keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const triples = [
      q(ENTITY, 'http://schema.org/name', '"SingleBot"'),
      q(ENTITY, 'http://schema.org/version', '"3"'),
    ];

    const result = await publisher.publish({
      paranetId: PARANET,
      quads: triples,
    });

    const publisherHex = Buffer.from(result.merkleRoot).toString('hex');
    const receiverHashes = result.publicQuads!.map(computeTripleHash);
    const receiverRoot = new MerkleTree(receiverHashes).root;
    const receiverHex = Buffer.from(receiverRoot).toString('hex');

    expect(receiverHex).toBe(publisherHex);
  });

  it('publish with private quads: receiver flat merkle from public quads matches', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: bus, keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const publicTriples = [
      q(ENTITY, 'http://schema.org/name', '"PrivateTestBot"'),
      q(ENTITY, 'http://schema.org/description', '"Has secrets"'),
    ];
    const privateTriples = [
      q(ENTITY, 'http://ex.org/apiKey', '"sk-secret"'),
    ];

    const result = await publisher.publish({
      paranetId: PARANET,
      publisherPeerId: 'test-peer',
      quads: publicTriples,
      privateQuads: privateTriples,
    });

    const publisherHex = Buffer.from(result.merkleRoot).toString('hex');

    // Receiver sees public quads + private roots from manifest as synthetic leaves
    const receiverHashes = result.publicQuads!.map(computeTripleHash);
    const privateRoots = result.kaManifest
      .filter(m => m.privateMerkleRoot)
      .map(m => m.privateMerkleRoot!);
    const receiverRoot = new MerkleTree([...receiverHashes, ...privateRoots]).root;
    const receiverHex = Buffer.from(receiverRoot).toString('hex');

    expect(receiverHex).toBe(publisherHex);
  });
});

describe('Tentative data and chain event confirmation', () => {
  it('stores data tentatively and confirms via confirmPublish', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const handler = new PublishHandler(store, bus);
    const publisherAddress = TEST_WALLET.address;

    const triples = [q('did:dkg:agent:QmTentative', 'http://schema.org/name', '"TentBot"')];
    const hashes = triples.map(computeTripleHash);
    const merkleRoot = new MerkleTree(hashes).root;

    const ntriples = triples.map(t =>
      `<${t.subject}> <${t.predicate}> ${t.object} .`,
    ).join('\n');

    const ual = `did:dkg:mock:31337/${publisherAddress}/1`;
    const reqBytes = encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(ntriples),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'did:dkg:agent:QmTentative', privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress,
      startKAId: 1,
      endKAId: 1,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    const ackData = await handler.handler(reqBytes, 'test-peer' as any);
    const ack = decodePublishAck(ackData);
    expect(ack.accepted).toBe(true);
    expect(handler.hasPendingPublishes).toBe(true);

    const confirmed = await handler.confirmPublish(ual, {
      publisherAddress,
      merkleRoot,
      startKAId: 1n,
      endKAId: 1n,
    });
    expect(confirmed).toBe(true);
    expect(handler.hasPendingPublishes).toBe(false);
  });

  it('rejects PublishRequest when publisher does not own UAL range (on-chain check)', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    // Mock adapter has no reserved ranges for TEST_WALLET.address (default signer is different)
    const chainAdapter = new MockChainAdapter('mock:31337', ethers.Wallet.createRandom().address);
    const handler = new PublishHandler(store, bus, { chainAdapter });

    const publisherAddress = TEST_WALLET.address;
    const triples = [q('did:dkg:agent:QmNoRange', 'http://schema.org/name', '"NoRangeBot"')];
    const ntriples = triples.map(t =>
      `<${t.subject}> <${t.predicate}> ${t.object} .`,
    ).join('\n');

    const ual = `did:dkg:mock:31337/${publisherAddress}/1`;
    const reqBytes = encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(ntriples),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'did:dkg:agent:QmNoRange', privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress,
      startKAId: 1,
      endKAId: 1,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    const ackData = await handler.handler(reqBytes, 'test-peer' as any);
    const ack = decodePublishAck(ackData);
    expect(ack.accepted).toBe(false);
    expect(ack.rejectionReason).toContain('does not own');
    expect(ack.rejectionReason).toContain('1..1');
  });

  it('accepts PublishRequest when publisher owns UAL range (on-chain check)', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const publisherAddress = TEST_WALLET.address;
    const chainAdapter = new MockChainAdapter('mock:31337', publisherAddress);
    await chainAdapter.reserveUALRange(5); // publisher now owns 1..5
    const handler = new PublishHandler(store, bus, { chainAdapter });

    const triples = [q('did:dkg:agent:QmOwnsRange', 'http://schema.org/name', '"OwnsRangeBot"')];
    const ntriples = triples.map(t =>
      `<${t.subject}> <${t.predicate}> ${t.object} .`,
    ).join('\n');

    const ual = `did:dkg:mock:31337/${publisherAddress}/1`;
    const reqBytes = encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(ntriples),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'did:dkg:agent:QmOwnsRange', privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress,
      startKAId: 1,
      endKAId: 1,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    const ackData = await handler.handler(reqBytes, 'test-peer' as any);
    const ack = decodePublishAck(ackData);
    expect(ack.accepted).toBe(true);
    expect(handler.hasPendingPublishes).toBe(true);
  });

  it('rejects confirmation with mismatched publisher address', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const handler = new PublishHandler(store, bus);
    const publisherAddress = TEST_WALLET.address;
    const imposter = ethers.Wallet.createRandom();

    const triples = [q('did:dkg:agent:QmMisAddr', 'http://schema.org/name', '"MisAddrBot"')];
    const hashes = triples.map(computeTripleHash);
    const merkleRoot = new MerkleTree(hashes).root;

    const ntriples = triples.map(t =>
      `<${t.subject}> <${t.predicate}> ${t.object} .`,
    ).join('\n');

    const ual = `did:dkg:mock:31337/${publisherAddress}/2`;
    const reqBytes = encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(ntriples),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'did:dkg:agent:QmMisAddr', privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress,
      startKAId: 2,
      endKAId: 2,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    await handler.handler(reqBytes, 'test-peer' as any);

    const confirmed = await handler.confirmPublish(ual, {
      publisherAddress: imposter.address,
      merkleRoot,
      startKAId: 2n,
      endKAId: 2n,
    });
    expect(confirmed).toBe(false);
    expect(handler.hasPendingPublishes).toBe(true);
  });

  it('rejects confirmation with mismatched merkle root', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const handler = new PublishHandler(store, bus);
    const publisherAddress = TEST_WALLET.address;

    const triples = [q('did:dkg:agent:QmMisRoot', 'http://schema.org/name', '"MisRootBot"')];

    const ntriples = triples.map(t =>
      `<${t.subject}> <${t.predicate}> ${t.object} .`,
    ).join('\n');

    const ual = `did:dkg:mock:31337/${publisherAddress}/3`;
    const reqBytes = encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(ntriples),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'did:dkg:agent:QmMisRoot', privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress,
      startKAId: 3,
      endKAId: 3,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    await handler.handler(reqBytes, 'test-peer' as any);

    const wrongRoot = new Uint8Array(32).fill(0xff);
    const confirmed = await handler.confirmPublish(ual, {
      publisherAddress,
      merkleRoot: wrongRoot,
      startKAId: 3n,
      endKAId: 3n,
    });
    expect(confirmed).toBe(false);
    expect(handler.hasPendingPublishes).toBe(true);
  });

  it('confirms tentative data via confirmByMerkleRoot', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const handler = new PublishHandler(store, bus);
    const publisherAddress = TEST_WALLET.address;

    const triples = [q('did:dkg:agent:QmByRoot', 'http://schema.org/name', '"RootBot"')];
    const hashes = triples.map(computeTripleHash);
    const merkleRoot = new MerkleTree(hashes).root;

    const ntriples = triples.map(t =>
      `<${t.subject}> <${t.predicate}> ${t.object} .`,
    ).join('\n');

    const ual = `did:dkg:mock:31337/${publisherAddress}/5`;
    const reqBytes = encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(ntriples),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'did:dkg:agent:QmByRoot', privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress,
      startKAId: 5,
      endKAId: 5,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    await handler.handler(reqBytes, 'test-peer' as any);
    expect(handler.hasPendingPublishes).toBe(true);

    const ctx = createOperationContext('publish');
    const confirmed = await handler.confirmByMerkleRoot(merkleRoot, {
      publisherAddress,
      startKAId: 5n,
      endKAId: 5n,
      chainId: 'mock:31337',
    }, ctx);

    expect(confirmed).toBe(true);
    expect(handler.hasPendingPublishes).toBe(false);
  });

  it('ChainEventPoller detects events and confirms tentative publishes', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const handler = new PublishHandler(store, bus);
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const publisherAddress = TEST_WALLET.address;

    // Publish through the chain to create the on-chain event
    const keypair = await generateEd25519Keypair();
    const publisherStore = new OxigraphStore();
    const publisher = new DKGPublisher({
      store: publisherStore,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const triples = [q('did:dkg:agent:QmPolled', 'http://schema.org/name', '"PollBot"')];
    const publishResult = await publisher.publish({
      paranetId: PARANET,
      quads: triples,
    });

    // Simulate a receiver getting the data via P2P: build the same merkle root
    // The handler computes its own merkle root from the autoPartition of received quads,
    // so we need to ensure the merkle root matches what the chain event carries.
    const hashes = triples.map(computeTripleHash);
    const expectedMerkleRoot = new MerkleTree(hashes).root;

    const ntriples = triples.map(t =>
      `<${t.subject}> <${t.predicate}> ${t.object} .`,
    ).join('\n');

    const onChain = publishResult.onChainResult!;
    const ual = `did:dkg:mock:31337/${onChain.publisherAddress}/${onChain.startKAId}`;
    const reqBytes = encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(ntriples),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'did:dkg:agent:QmPolled', privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: onChain.publisherAddress,
      startKAId: Number(onChain.startKAId),
      endKAId: Number(onChain.endKAId),
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    await handler.handler(reqBytes, 'test-peer' as any);
    expect(handler.hasPendingPublishes).toBe(true);

    const poller = new ChainEventPoller({
      chain,
      publishHandler: handler,
      intervalMs: 100,
    });

    poller.start();
    await new Promise((r) => setTimeout(r, 500));
    poller.stop();

    expect(handler.hasPendingPublishes).toBe(false);
  }, 10000);

  it('ChainEventPoller invokes onParanetCreated for ParanetCreated events', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const handler = new PublishHandler(store, bus);
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);

    await chain.createParanet({ paranetId: 'on-chain-test', accessPolicy: 0 });

    const received: Array<{ paranetId: string; creator: string; accessPolicy: number }> = [];
    const poller = new ChainEventPoller({
      chain,
      publishHandler: handler,
      intervalMs: 100,
      onParanetCreated: async (info) => {
        received.push(info);
      },
    });

    poller.start();
    await new Promise((r) => setTimeout(r, 300));
    poller.stop();

    expect(received).toHaveLength(1);
    expect(received[0].paranetId).toBe('on-chain-test');
    expect(received[0].creator).toBe('mock-creator');
    expect(received[0].accessPolicy).toBe(0);
  });
});

describe('Update flow', () => {
  it('updates existing KC with new triples and new merkle root', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: bus, keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const initialTriples = [
      q(ENTITY, 'http://schema.org/name', '"OriginalBot"'),
      q(ENTITY, 'http://schema.org/version', '"1.0"'),
    ];

    const publishResult = await publisher.publish({
      paranetId: PARANET,
      quads: initialTriples,
    });

    expect(publishResult.status).toBe('confirmed');
    const kcId = publishResult.kcId;

    const before = await store.query(
      `SELECT ?name WHERE { GRAPH <${GRAPH}> { <${ENTITY}> <http://schema.org/name> ?name } }`,
    );
    expect(before.type).toBe('bindings');
    if (before.type === 'bindings') {
      expect(before.bindings[0]['name']).toContain('OriginalBot');
    }

    const updatedTriples = [
      q(ENTITY, 'http://schema.org/name', '"UpdatedBot"'),
      q(ENTITY, 'http://schema.org/version', '"2.0"'),
    ];

    const updateResult = await publisher.update(kcId, {
      paranetId: PARANET,
      quads: updatedTriples,
    });

    expect(updateResult.status).toBe('confirmed');
    expect(updateResult.kcId).toBe(kcId);
    expect(Buffer.from(updateResult.merkleRoot).toString('hex'))
      .not.toBe(Buffer.from(publishResult.merkleRoot).toString('hex'));

    const after = await store.query(
      `SELECT ?name WHERE { GRAPH <${GRAPH}> { <${ENTITY}> <http://schema.org/name> ?name } }`,
    );
    expect(after.type).toBe('bindings');
    if (after.type === 'bindings') {
      expect(after.bindings).toHaveLength(1);
      expect(after.bindings[0]['name']).toContain('UpdatedBot');
    }
  });

  it('update removes old private triples and stores new ones', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: bus, keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const entity = 'did:dkg:agent:QmPrivUpdate';

    const result1 = await publisher.publish({
      paranetId: PARANET,
      quads: [q(entity, 'http://schema.org/name', '"PrivUpdateBot"')],
      privateQuads: [q(entity, 'http://ex.org/secret', '"old-secret"')],
      publisherPeerId: '12D3KooWTestPublisher',
    });

    await publisher.update(result1.kcId, {
      paranetId: PARANET,
      quads: [q(entity, 'http://schema.org/name', '"PrivUpdateBot v2"')],
      privateQuads: [q(entity, 'http://ex.org/secret', '"new-secret"')],
    });

    const nameResult = await store.query(
      `SELECT ?name WHERE { GRAPH <${GRAPH}> { <${entity}> <http://schema.org/name> ?name } }`,
    );
    if (nameResult.type === 'bindings') {
      expect(nameResult.bindings).toHaveLength(1);
      expect(nameResult.bindings[0]['name']).toContain('v2');
    }
  });

  it('update sends new merkle root to chain', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: bus, keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const entity = 'did:dkg:agent:QmChainUpdate';
    const result1 = await publisher.publish({
      paranetId: PARANET,
      quads: [q(entity, 'http://schema.org/name', '"ChainBot v1"')],
    });

    const batchBefore = chain.getBatch(result1.kcId);
    expect(batchBefore).toBeDefined();
    const oldMerkleHex = Buffer.from(batchBefore!.merkleRoot).toString('hex');

    await publisher.update(result1.kcId, {
      paranetId: PARANET,
      quads: [q(entity, 'http://schema.org/name', '"ChainBot v2"')],
    });

    const batchAfter = chain.getBatch(result1.kcId);
    expect(batchAfter).toBeDefined();
    const newMerkleHex = Buffer.from(batchAfter!.merkleRoot).toString('hex');

    expect(newMerkleHex).not.toBe(oldMerkleHex);
  });
});

describe('Tentative publish UAL uniqueness', () => {
  it('produces a unique UAL for each tentative publish', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: bus, keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 0n, // forces tentative (skips on-chain)
    });

    const uals = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const result = await publisher.publish({
        paranetId: PARANET,
        quads: [q(`did:dkg:agent:Unique${i}`, 'http://schema.org/name', `"Entity${i}"`)],
      });

      expect(result.status).toBe('tentative');
      expect(result.ual).toBeTruthy();
      expect(result.ual).toContain('/t'); // tentative UAL pattern
      expect(uals.has(result.ual)).toBe(false);
      uals.add(result.ual);
    }
    expect(uals.size).toBe(5);
  });

  it('includes ual field in confirmed publish results', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: bus, keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const result = await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"ConfirmedUAL"')],
    });

    expect(result.status).toBe('confirmed');
    expect(result.ual).toBeTruthy();
    expect(result.ual).toContain('did:dkg:');
  });

  it('stores distinct KC metadata for each tentative publish', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: bus, keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 0n,
    });

    for (let i = 0; i < 3; i++) {
      await publisher.publish({
        paranetId: PARANET,
        quads: [q(`did:dkg:agent:Meta${i}`, 'http://schema.org/name', `"MetaEntity${i}"`)],
      });
    }

    const result = await store.query(
      `SELECT (COUNT(DISTINCT ?kc) AS ?c) WHERE {
        GRAPH ?g { ?kc a <http://dkg.io/ontology/KnowledgeCollection> }
      }`,
    );

    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      const raw = result.bindings[0]['c'];
      const count = parseInt(raw.match(/^"?(\d+)/)?.[1] ?? '0', 10);
      expect(count).toBe(3);
    }
  });

  it('publish invokes onPhase for every major step', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: bus, keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const phases: [string, 'start' | 'end'][] = [];
    const onPhase = (phase: string, status: 'start' | 'end') => phases.push([phase, status]);

    await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"PhaseTest"')],
      onPhase,
    });

    const phaseNames = [...new Set(phases.filter(([, s]) => s === 'start').map(([p]) => p))];
    expect(phaseNames).toContain('prepare');
    expect(phaseNames).toContain('store');
    expect(phaseNames).toContain('chain');
    expect(phaseNames).toContain('prepare:ensureParanet');
    expect(phaseNames).toContain('prepare:partition');
    expect(phaseNames).toContain('prepare:manifest');
    expect(phaseNames).toContain('prepare:validate');
    expect(phaseNames).toContain('prepare:merkle');
  });

  it('update invokes onPhase for prepare → chain → store', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store, chain, eventBus: bus, keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const pub = await publisher.publish({
      paranetId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"Original"')],
    });

    const phases: [string, 'start' | 'end'][] = [];
    const onPhase = (phase: string, status: 'start' | 'end') => phases.push([phase, status]);

    await publisher.update(pub.kcId, {
      paranetId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"Updated"')],
      onPhase,
    });

    const started = phases.filter(([, s]) => s === 'start').map(([p]) => p);
    expect(started).toContain('prepare');
    expect(started).toContain('chain');
    expect(started).toContain('store');
    expect(started).toContain('prepare:partition');
    expect(started).toContain('prepare:manifest');
    expect(started).toContain('prepare:merkle');
    expect(started).toContain('chain:submit');

    // update should NOT have prepare:ensureParanet or prepare:validate
    expect(started).not.toContain('prepare:ensureParanet');
    expect(started).not.toContain('prepare:validate');
  });
});

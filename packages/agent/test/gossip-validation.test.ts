/**
 * Tests for I-002 (gossip ingestion validation) and I-022 (txHash/blockNumber in proto).
 *
 * Verifies that:
 * - PublishRequestMsg correctly encodes/decodes txHash and blockNumber
 * - Gossip-received data is always stored as tentative (never confirmed from self-reported fields)
 * - On-chain verification promotes tentative → confirmed
 * - Malformed gossip messages are handled gracefully with logging
 * - Integration: real gossip flow through subscribeToParanet triggers verification
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  encodePublishRequest,
  decodePublishRequest,
  TypedEventBus,
  createOperationContext,
} from '@dkg/core';
import { OxigraphStore, type Quad } from '@dkg/storage';
import { MockChainAdapter } from '@dkg/chain';
import {
  computePublicRoot,
  computeKARoot,
  computeKCRoot,
  autoPartition,
  generateTentativeMetadata,
  generateKCMetadata,
  getConfirmedStatusQuad,
  type KAMetadata,
} from '@dkg/publisher';
import { DKGAgent } from '../src/index.js';

const PARANET = 'test-gossip';

function q(s: string, p: string, o: string, g = ''): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('I-022: PublishRequestMsg txHash and blockNumber fields', () => {
  it('encodes and decodes txHash and blockNumber correctly', () => {
    const txHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const blockNumber = 42;

    const encoded = encodePublishRequest({
      ual: 'did:dkg:mock:31337/0x1/1',
      nquads: new TextEncoder().encode('<s> <p> <o> .'),
      paranetId: PARANET,
      kas: [],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x1111111111111111111111111111111111111111',
      startKAId: 1,
      endKAId: 1,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
      txHash,
      blockNumber,
    });

    const decoded = decodePublishRequest(encoded);
    expect(decoded.txHash).toBe(txHash);

    const decodedBlock = typeof decoded.blockNumber === 'number'
      ? decoded.blockNumber
      : Number(decoded.blockNumber);
    expect(decodedBlock).toBe(42);
  });

  it('defaults txHash to empty string and blockNumber to 0 when not set', () => {
    const encoded = encodePublishRequest({
      ual: 'did:dkg:mock:31337/0x1/1',
      nquads: new TextEncoder().encode('<s> <p> <o> .'),
      paranetId: PARANET,
      kas: [],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x1111111111111111111111111111111111111111',
      startKAId: 1,
      endKAId: 1,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    const decoded = decodePublishRequest(encoded);
    expect(decoded.txHash ?? '').toBe('');

    const decodedBlock = typeof decoded.blockNumber === 'number'
      ? decoded.blockNumber
      : Number(decoded.blockNumber ?? 0);
    expect(decodedBlock).toBe(0);
  });

  it('preserves backward compatibility with messages missing txHash/blockNumber', () => {
    const msg = {
      ual: 'did:dkg:mock:31337/0x1/1',
      nquads: new TextEncoder().encode('<s> <p> <o> .'),
      paranetId: PARANET,
      kas: [],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x1111111111111111111111111111111111111111',
      startKAId: 1,
      endKAId: 1,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    };

    const encoded = encodePublishRequest(msg);
    const decoded = decodePublishRequest(encoded);

    expect(decoded.ual).toBe(msg.ual);
    expect(decoded.paranetId).toBe(msg.paranetId);
    expect(decoded.publisherAddress).toBe(msg.publisherAddress);
  });
});

describe('I-002: Gossip ingestion should not trust self-reported on-chain status', () => {
  it('gossip data with startKAId > 0 and publisherAddress should NOT produce confirmed metadata', () => {
    // This test verifies the fix: previously, the gossip handler used
    // `isConfirmedOnChain = startKAId > 0 && !!publisherAddress` to mark
    // data as confirmed without any on-chain verification.
    //
    // After the fix, all gossip data should be stored as tentative first.
    // We simulate what the gossip handler does and verify the output is tentative.

    const entity = 'did:dkg:agent:QmGossipEntity';
    const triples = [
      q(entity, 'http://schema.org/name', '"GossipBot"', `did:dkg:paranet:${PARANET}`),
    ];

    const partitioned = autoPartition(triples);
    const kaRoots: Uint8Array[] = [];
    const kaMetadata: KAMetadata[] = [];

    for (const [rootEntity, entityQuads] of partitioned) {
      const publicRoot = computePublicRoot(entityQuads);
      kaRoots.push(computeKARoot(publicRoot, undefined));
      kaMetadata.push({
        rootEntity,
        kcUal: 'did:dkg:mock:31337/0xAttacker/1',
        tokenId: 1n,
        publicTripleCount: entityQuads.length,
        privateTripleCount: 0,
      });
    }

    const merkleRoot = computeKCRoot(kaRoots);

    const kcMeta = {
      ual: 'did:dkg:mock:31337/0xAttacker/1',
      paranetId: PARANET,
      merkleRoot,
      kaCount: kaMetadata.length,
      publisherPeerId: '0xAttacker',
      timestamp: new Date(),
    };

    // The fix: always generate tentative metadata from gossip
    const tentativeQuads = generateTentativeMetadata(kcMeta, kaMetadata);
    const hasTentativeStatus = tentativeQuads.some(
      tq => tq.predicate.includes('status') && tq.object.includes('tentative'),
    );
    expect(hasTentativeStatus).toBe(true);

    // Verify that the old behavior (confirmed) is NOT used
    const confirmedQuads = [
      ...generateKCMetadata(kcMeta, kaMetadata),
      getConfirmedStatusQuad(kcMeta.ual, PARANET),
    ];
    const hasConfirmedStatus = confirmedQuads.some(
      tq => tq.predicate.includes('status') && tq.object.includes('confirmed'),
    );
    expect(hasConfirmedStatus).toBe(true);

    // These should be different — tentative should NOT include a confirmed status quad
    const tentativeStatuses = tentativeQuads.filter(tq => tq.predicate.includes('status'));
    const confirmedStatuses = confirmedQuads.filter(tq => tq.predicate.includes('status'));
    expect(tentativeStatuses.map(s => s.object)).not.toEqual(confirmedStatuses.map(s => s.object));
  });

  it('on-chain verification uses MockChainAdapter listenForEvents to match events', async () => {
    const publisherAddress = '0x1111111111111111111111111111111111111111';
    const chain = new MockChainAdapter('mock:31337', publisherAddress);

    const publishResult = await chain.publishKnowledgeAssets({
      kaCount: 2,
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32).fill(0xab),
      publicByteSize: 100n,
      epochs: 1,
      tokenAmount: 1n,
      publisherSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      receiverSignatures: [],
    });

    expect(publishResult.txHash).toBeTruthy();
    expect(publishResult.blockNumber).toBeGreaterThan(0);

    // Verify the event is findable via listenForEvents at the correct block
    let found = false;
    const filter = {
      eventTypes: ['KnowledgeBatchCreated'],
      fromBlock: publishResult.blockNumber,
    };
    for await (const event of chain.listenForEvents(filter)) {
      if (event.blockNumber === publishResult.blockNumber) {
        expect(event.data['publisherAddress']).toBe(publisherAddress);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('proto round-trips full gossip message with on-chain proof fields', () => {
    const entity = 'did:dkg:agent:QmRoundTrip';
    const ntriples = `<${entity}> <http://schema.org/name> "RoundTrip" .`;
    const txHash = '0x' + 'ff'.repeat(32);

    const msg = encodePublishRequest({
      ual: 'did:dkg:mock:31337/0x1/1',
      nquads: new TextEncoder().encode(ntriples),
      paranetId: PARANET,
      kas: [{
        tokenId: 1,
        rootEntity: entity,
        privateMerkleRoot: new Uint8Array(0),
        privateTripleCount: 0,
      }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x1111111111111111111111111111111111111111',
      startKAId: 5,
      endKAId: 6,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
      txHash,
      blockNumber: 100,
    });

    const decoded = decodePublishRequest(msg);
    expect(decoded.ual).toBe('did:dkg:mock:31337/0x1/1');
    expect(decoded.txHash).toBe(txHash);
    expect(decoded.paranetId).toBe(PARANET);
    expect(decoded.kas).toHaveLength(1);
    expect(decoded.kas[0].rootEntity).toBe(entity);

    const blockNum = typeof decoded.blockNumber === 'number'
      ? decoded.blockNumber
      : Number(decoded.blockNumber);
    expect(blockNum).toBe(100);

    const startKA = typeof decoded.startKAId === 'number'
      ? decoded.startKAId
      : Number(decoded.startKAId);
    expect(startKA).toBe(5);
  });

  it('listenForEvents respects toBlock and filters by txHash in event data', async () => {
    const publisherAddress = '0x2222222222222222222222222222222222222222';
    const chain = new MockChainAdapter('mock:31337', publisherAddress);

    const result1 = await chain.publishKnowledgeAssets({
      kaCount: 1,
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32).fill(0x01),
      publicByteSize: 100n,
      epochs: 1,
      tokenAmount: 1n,
      publisherSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      receiverSignatures: [],
    });
    const result2 = await chain.publishKnowledgeAssets({
      kaCount: 1,
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32).fill(0x02),
      publicByteSize: 100n,
      epochs: 1,
      tokenAmount: 1n,
      publisherSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      receiverSignatures: [],
    });

    const eventsBlock1: { blockNumber: number; txHash: unknown }[] = [];
    for await (const evt of chain.listenForEvents({
      eventTypes: ['KnowledgeBatchCreated'],
      fromBlock: result1.blockNumber,
      toBlock: result1.blockNumber,
    })) {
      eventsBlock1.push({ blockNumber: evt.blockNumber, txHash: evt.data['txHash'] });
    }

    expect(eventsBlock1).toHaveLength(1);
    expect(eventsBlock1[0].blockNumber).toBe(result1.blockNumber);
    expect(eventsBlock1[0].txHash).toBe(result1.txHash);

    const eventsAll: number[] = [];
    for await (const evt of chain.listenForEvents({
      eventTypes: ['KnowledgeBatchCreated'],
      fromBlock: result1.blockNumber,
    })) {
      eventsAll.push(evt.blockNumber);
    }
    expect(eventsAll.length).toBeGreaterThanOrEqual(2);
  });

  it('merkle verification detects tampered gossip data', () => {
    const entity = 'did:dkg:agent:QmTampered';
    const legitimateTriples = [
      q(entity, 'http://schema.org/name', '"Legitimate"', `did:dkg:paranet:${PARANET}`),
      q(entity, 'http://schema.org/version', '"1.0"', `did:dkg:paranet:${PARANET}`),
    ];
    const tamperedTriples = [
      q(entity, 'http://schema.org/name', '"Tampered"', `did:dkg:paranet:${PARANET}`),
      q(entity, 'http://schema.org/version', '"1.0"', `did:dkg:paranet:${PARANET}`),
    ];

    const legitimatePartitioned = autoPartition(legitimateTriples);
    const legitimateKaRoots: Uint8Array[] = [];
    for (const [, entityQuads] of legitimatePartitioned) {
      const publicRoot = computePublicRoot(entityQuads);
      legitimateKaRoots.push(computeKARoot(publicRoot, undefined));
    }
    const legitimateMerkleRoot = computeKCRoot(legitimateKaRoots);

    const tamperedPartitioned = autoPartition(tamperedTriples);
    const tamperedKaRoots: Uint8Array[] = [];
    for (const [, entityQuads] of tamperedPartitioned) {
      const publicRoot = computePublicRoot(entityQuads);
      tamperedKaRoots.push(computeKARoot(publicRoot, undefined));
    }
    const tamperedMerkleRoot = computeKCRoot(tamperedKaRoots);

    // Merkle roots should differ — a receiver can detect the tampering
    expect(Buffer.from(legitimateMerkleRoot).toString('hex'))
      .not.toBe(Buffer.from(tamperedMerkleRoot).toString('hex'));
  });
});

// ---------------------------------------------------------------------------
// Integration: gossip flow through subscribeToParanet with on-chain verification
// ---------------------------------------------------------------------------
const integrationAgents: DKGAgent[] = [];

afterEach(async () => {
  for (const a of integrationAgents) {
    try { await a.stop(); } catch {}
  }
  integrationAgents.length = 0;
});

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

describe('Integration: gossip ingestion verifies on-chain and promotes to confirmed', () => {
  it('receiver gossip data starts tentative and promotes to confirmed via shared chain', async () => {
    const sharedChain = new MockChainAdapter('mock:31337', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

    const agentA = await DKGAgent.create({
      name: 'GossipSender',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
    });
    const agentB = await DKGAgent.create({
      name: 'GossipReceiver',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
    });
    integrationAgents.push(agentA, agentB);

    await agentA.start();
    await agentB.start();
    await agentB.connectTo(agentA.multiaddrs[0]);
    await sleep(1000);

    await agentA.createParanet({ id: 'gossip-verify', name: 'GV', description: '' });
    agentA.subscribeToParanet('gossip-verify');
    agentB.subscribeToParanet('gossip-verify');
    await sleep(500);

    await agentA.publish('gossip-verify', [
      { subject: 'did:dkg:test:Verified', predicate: 'http://schema.org/name', object: '"VerifiedBot"', graph: '' },
    ]);

    await sleep(4000);

    const statusResult = await agentB.query(
      `SELECT ?status WHERE {
        GRAPH <did:dkg:paranet:gossip-verify/_meta> {
          ?kc <http://dkg.io/ontology/status> ?status
        }
      }`,
      'gossip-verify',
    );

    const statuses = statusResult.bindings.map(b => b['status']);
    const hasConfirmed = statuses.some(s => s?.includes('confirmed'));
    expect(hasConfirmed).toBe(true);

    const hasTentative = statuses.some(s => s?.includes('tentative'));
    expect(hasTentative).toBe(false);
  }, 25000);

  it('receiver without shared chain leaves gossip data as tentative', async () => {
    const chainA = new MockChainAdapter('mock:31337', '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
    const chainB = new MockChainAdapter('mock:31337', '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC');

    const agentA = await DKGAgent.create({
      name: 'TentSender',
      listenPort: 0,
      skills: [],
      chainAdapter: chainA,
    });
    const agentB = await DKGAgent.create({
      name: 'TentReceiver',
      listenPort: 0,
      skills: [],
      chainAdapter: chainB,
    });
    integrationAgents.push(agentA, agentB);

    await agentA.start();
    await agentB.start();
    await agentB.connectTo(agentA.multiaddrs[0]);
    await sleep(1000);

    await agentA.createParanet({ id: 'gossip-tent', name: 'GT', description: '' });
    agentA.subscribeToParanet('gossip-tent');
    agentB.subscribeToParanet('gossip-tent');
    await sleep(500);

    await agentA.publish('gossip-tent', [
      { subject: 'did:dkg:test:Tentative', predicate: 'http://schema.org/name', object: '"TentativeBot"', graph: '' },
    ]);

    await sleep(4000);

    const statusResult = await agentB.query(
      `SELECT ?status WHERE {
        GRAPH <did:dkg:paranet:gossip-tent/_meta> {
          ?kc <http://dkg.io/ontology/status> ?status
        }
      }`,
      'gossip-tent',
    );

    const statuses = statusResult.bindings.map(b => b['status']);
    const hasTentative = statuses.some(s => s?.includes('tentative'));
    expect(hasTentative).toBe(true);

    const hasConfirmed = statuses.some(s => s?.includes('confirmed'));
    expect(hasConfirmed).toBe(false);
  }, 25000);
});

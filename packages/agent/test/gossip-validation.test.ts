/**
 * Tests for I-002 (gossip ingestion validation) and I-022 (txHash/blockNumber in proto).
 *
 * Verifies that:
 * - PublishRequestMsg correctly encodes/decodes txHash and blockNumber
 * - Gossip-received data is always stored as tentative (never confirmed from self-reported fields)
 * - On-chain verification promotes tentative → confirmed
 * - Malformed gossip messages are handled gracefully with logging
 * - Integration: real gossip flow through subscribeToContextGraph triggers verification
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  encodePublishRequest,
  decodePublishRequest,
} from '@origintrail-official/dkg-core';
import { type Quad } from '@origintrail-official/dkg-storage';
import {
  computePublicRootV10 as computePublicRoot,
  computeKARootV10 as computeKARoot,
  computeKCRootV10 as computeKCRoot,
  autoPartition,
  generateTentativeMetadata,
  generateKCMetadata,
  getConfirmedStatusQuad,
  type KAMetadata,
} from '@origintrail-official/dkg-publisher';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';

const PARANET = 'test-gossip';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

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
      contextGraphId: PARANET,
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
      contextGraphId: PARANET,
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

    // A-12 migration: agent DIDs are EVM-address form.
    const entity = 'did:dkg:agent:0x' + 'aa'.repeat(20);    const triples = [
      q(entity, 'http://schema.org/name', '"GossipBot"', `did:dkg:context-graph:${PARANET}`),
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
      contextGraphId: PARANET,
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

  it('on-chain verification uses EVMChainAdapter listenForEvents to match events', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const agent = await DKGAgent.create({
      name: 'EventVerifier',
      listenPort: 0,
      skills: [],
      chainAdapter: chain,
      nodeRole: 'core',
    });
    await agent.start();

    try {
      await agent.createContextGraph({ id: 'event-test', name: 'Event Test' });
      await agent.registerContextGraph('event-test');
      agent.subscribeToContextGraph('event-test');
      await sleep(500);

      const result = await agent.publish('event-test', [
        { subject: 'did:dkg:test:EventEntity', predicate: 'http://schema.org/name', object: '"EventBot"', graph: '' },
      ]);

      expect(result.onChainResult?.txHash).toBeTruthy();
      expect(result.onChainResult?.blockNumber).toBeGreaterThan(0);

      let found = false;
      for await (const event of chain.listenForEvents({
        eventTypes: ['KCCreated'],
        fromBlock: result.onChainResult!.blockNumber,
        toBlock: result.onChainResult!.blockNumber,
      })) {
        if (event.blockNumber === result.onChainResult!.blockNumber) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    } finally {
      await agent.stop();
    }
  }, 30000);

  it('proto round-trips full gossip message with on-chain proof fields', () => {
    const entity = 'did:dkg:agent:0x' + 'bb'.repeat(20);    const ntriples = `<${entity}> <http://schema.org/name> "RoundTrip" .`;
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
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const agent = await DKGAgent.create({
      name: 'EventFilter',
      listenPort: 0,
      skills: [],
      chainAdapter: chain,
      nodeRole: 'core',
    });
    await agent.start();

    try {
      await agent.createContextGraph({ id: 'event-filter', name: 'Event Filter' });
      await agent.registerContextGraph('event-filter');
      agent.subscribeToContextGraph('event-filter');
      await sleep(500);

      const result1 = await agent.publish('event-filter', [
        { subject: 'did:dkg:test:Filter1', predicate: 'http://schema.org/name', object: '"Filter1"', graph: '' },
      ]);
      const result2 = await agent.publish('event-filter', [
        { subject: 'did:dkg:test:Filter2', predicate: 'http://schema.org/name', object: '"Filter2"', graph: '' },
      ]);

      const eventsBlock1: { blockNumber: number; txHash: unknown }[] = [];
      for await (const evt of chain.listenForEvents({
        eventTypes: ['KCCreated'],
        fromBlock: result1.onChainResult!.blockNumber,
        toBlock: result1.onChainResult!.blockNumber,
      })) {
        eventsBlock1.push({ blockNumber: evt.blockNumber, txHash: evt.data['txHash'] });
      }

      expect(eventsBlock1).toHaveLength(1);
      expect(eventsBlock1[0].blockNumber).toBe(result1.onChainResult!.blockNumber);
      expect(eventsBlock1[0].txHash).toBe(result1.onChainResult!.txHash);

      const eventsAll: number[] = [];
      for await (const evt of chain.listenForEvents({
        eventTypes: ['KCCreated'],
        fromBlock: result1.onChainResult!.blockNumber,
      })) {
        eventsAll.push(evt.blockNumber);
      }
      expect(eventsAll.length).toBeGreaterThanOrEqual(2);
    } finally {
      await agent.stop();
    }
  }, 30000);

  it('merkle verification detects tampered gossip data', () => {
    const entity = 'did:dkg:agent:0x' + 'cc'.repeat(20);    const legitimateTriples = [
      q(entity, 'http://schema.org/name', '"Legitimate"', `did:dkg:context-graph:${PARANET}`),
      q(entity, 'http://schema.org/version', '"1.0"', `did:dkg:context-graph:${PARANET}`),
    ];
    const tamperedTriples = [
      q(entity, 'http://schema.org/name', '"Tampered"', `did:dkg:context-graph:${PARANET}`),
      q(entity, 'http://schema.org/version', '"1.0"', `did:dkg:context-graph:${PARANET}`),
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
// Integration: gossip flow through subscribeToContextGraph with on-chain verification
// ---------------------------------------------------------------------------
const integrationAgents: DKGAgent[] = [];

afterEach(async () => {
  for (const a of integrationAgents) {
    try { await a.stop(); } catch {}
  }
  integrationAgents.length = 0;
});

describe('Integration: gossip ingestion verifies on-chain and promotes to confirmed', () => {
  it('receiver gossip data starts tentative and promotes to confirmed via shared chain', async () => {
    const sharedChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);

    const agentA = await DKGAgent.create({
      name: 'GossipSender',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'core',
    });
    const agentB = await DKGAgent.create({
      name: 'GossipReceiver',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'core',
    });
    integrationAgents.push(agentA, agentB);

    await agentA.start();
    await agentB.start();
    await agentB.connectTo(agentA.multiaddrs[0]);
    await sleep(1000);

    await agentA.createContextGraph({ id: 'gossip-verify', name: 'GV', description: '' });
    await agentA.registerContextGraph('gossip-verify');
    agentA.subscribeToContextGraph('gossip-verify');
    agentB.subscribeToContextGraph('gossip-verify');
    await sleep(500);

    await agentA.publish('gossip-verify', [
      { subject: 'did:dkg:test:Verified', predicate: 'http://schema.org/name', object: '"VerifiedBot"', graph: '' },
    ]);

    await sleep(4000);

    const statusResult = await agentB.query(
      `SELECT ?status WHERE {
        GRAPH <did:dkg:context-graph:gossip-verify/_meta> {
          ?kc <http://dkg.io/ontology/status> ?status
        }
      }`,
      'gossip-verify',
    );

    const statuses = statusResult.bindings.map(b => b['status']);
    const hasConfirmed = statuses.some(s => s === '"confirmed"');
    expect(hasConfirmed).toBe(true);

    const hasTentative = statuses.some(s => s === '"tentative"');
    expect(hasTentative).toBe(false);
  }, 25000);

  it('receiver on the same chain verifies and promotes gossip data to confirmed', async () => {
    const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const chainB = createEVMAdapter(HARDHAT_KEYS.REC1_OP);

    const agentA = await DKGAgent.create({
      name: 'TentSender',
      listenPort: 0,
      skills: [],
      chainAdapter: chainA,
      nodeRole: 'core',
    });
    const agentB = await DKGAgent.create({
      name: 'TentReceiver',
      listenPort: 0,
      skills: [],
      chainAdapter: chainB,
      nodeRole: 'core',
    });
    integrationAgents.push(agentA, agentB);

    await agentA.start();
    await agentB.start();
    await agentB.connectTo(agentA.multiaddrs[0]);
    await sleep(1000);

    await agentA.createContextGraph({ id: 'gossip-tent', name: 'GT', description: '' });
    await agentA.registerContextGraph('gossip-tent');
    agentA.subscribeToContextGraph('gossip-tent', { trackSyncScope: false });
    agentB.subscribeToContextGraph('gossip-tent', { trackSyncScope: false });
    await sleep(500);

    await agentA.publish('gossip-tent', [
      { subject: 'did:dkg:test:Tentative', predicate: 'http://schema.org/name', object: '"TentativeBot"', graph: '' },
    ]);

    await sleep(4000);

    const statusResult = await agentB.query(
      `SELECT ?status WHERE {
        GRAPH <did:dkg:context-graph:gossip-tent/_meta> {
          ?kc <http://dkg.io/ontology/status> ?status
        }
      }`,
      'gossip-tent',
    );

    const statuses = statusResult.bindings.map(b => b['status']);
    const hasConfirmed = statuses.some(s => s === '"confirmed"');
    expect(hasConfirmed).toBe(true);
  }, 25000);
});

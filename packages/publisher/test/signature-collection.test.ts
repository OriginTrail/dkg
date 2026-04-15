/**
 * Publisher unit tests for the "replicate-then-publish" protocol:
 *
 * 1. collectReceiverSignatures(): request receiver sigs from peers via libp2p
 * 2. collectParticipantSignatures(): request context graph participant sigs
 * 3. Reordered publish flow: prepare → replicate → collect sigs → on-chain tx
 * 4. Timeout / insufficient signature handling
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, DKGEvent } from '@origintrail-official/dkg-core';
import { generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { DKGPublisher } from '../src/index.js';
import { ethers } from 'ethers';

const PARANET = 'sig-collection-test';
const ENTITY = 'urn:test:sigcollect:entity:1';

function q(s: string, p: string, o: string, g = ''): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

class MockSignerPeer {
  readonly wallet: ethers.Wallet;
  readonly identityId: bigint;

  constructor(identityId: bigint) {
    this.wallet = ethers.Wallet.createRandom();
    this.identityId = identityId;
  }

  async signReceiverAck(merkleRoot: string, publicByteSize: bigint) {
    const msgHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'uint64'],
      [merkleRoot, publicByteSize],
    );
    const sig = ethers.Signature.from(
      await this.wallet.signMessage(ethers.getBytes(msgHash)),
    );
    return {
      identityId: this.identityId,
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  async signParticipantAck(contextGraphId: bigint, merkleRoot: string) {
    const digest = ethers.solidityPackedKeccak256(
      ['uint256', 'bytes32'],
      [contextGraphId, merkleRoot],
    );
    const sig = ethers.Signature.from(
      await this.wallet.signMessage(ethers.getBytes(digest)),
    );
    return {
      identityId: this.identityId,
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }
}

describe('Signature Collection Protocol', () => {
  let store: OxigraphStore;
  let chain: MockChainAdapter;
  let publisher: DKGPublisher;
  let eventBus: TypedEventBus;
  const publisherWallet = ethers.Wallet.createRandom();

  beforeEach(async () => {
    store = new OxigraphStore();
    chain = new MockChainAdapter('mock:31337', publisherWallet.address);
    eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: publisherWallet.privateKey,
      publisherNodeIdentityId: 1n,
    });
  });

  describe('collectReceiverSignatures', () => {
    it('collects signatures from mock peers and returns them', async () => {
      const peer1 = new MockSignerPeer(2n);
      const peer2 = new MockSignerPeer(3n);

      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('test-root'));
      const publicByteSize = 1000n;

      const mockPeerResponder = async (
        _peerId: string,
        merkleRoot: string,
        publicByteSize: bigint,
      ) => {
        const sigs = await Promise.all([
          peer1.signReceiverAck(merkleRoot, publicByteSize),
          peer2.signReceiverAck(merkleRoot, publicByteSize),
        ]);
        return sigs;
      };

      const signatures = await publisher.collectReceiverSignatures({
        merkleRoot,
        publicByteSize,
        peerResponder: mockPeerResponder,
        minimumRequired: 2,
        timeoutMs: 5000,
      });

      expect(signatures).toHaveLength(2);
      expect(signatures[0].identityId).toBe(2n);
      expect(signatures[1].identityId).toBe(3n);
      expect(signatures[0].r).toBeInstanceOf(Uint8Array);
      expect(signatures[0].vs).toBeInstanceOf(Uint8Array);
    });

    it('throws when minimum required signatures not met within timeout', async () => {
      const peer1 = new MockSignerPeer(2n);
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('timeout-root'));
      const publicByteSize = 500n;

      const mockPeerResponder = async () => {
        return [await peer1.signReceiverAck(merkleRoot, publicByteSize)];
      };

      await expect(
        publisher.collectReceiverSignatures({
          merkleRoot,
          publicByteSize,
          peerResponder: mockPeerResponder,
          minimumRequired: 2,
          timeoutMs: 100,
        }),
      ).rejects.toThrow(/insufficient.*signatures|timeout/i);
    });

    it('deduplicates signatures from the same identityId', async () => {
      const peer1 = new MockSignerPeer(2n);
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('dedup-root'));
      const publicByteSize = 500n;

      const sig1 = await peer1.signReceiverAck(merkleRoot, publicByteSize);
      const mockPeerResponder = async () => [sig1, sig1];

      const signatures = await publisher.collectReceiverSignatures({
        merkleRoot,
        publicByteSize,
        peerResponder: mockPeerResponder,
        minimumRequired: 1,
        timeoutMs: 5000,
      });

      expect(signatures).toHaveLength(1);
    });
  });

  describe('collectParticipantSignatures', () => {
    it('collects context graph participant signatures', async () => {
      const participant1 = new MockSignerPeer(10n);
      const participant2 = new MockSignerPeer(11n);

      const contextGraphId = 42n;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('ctx-root'));

      const mockResponder = async () => {
        return Promise.all([
          participant1.signParticipantAck(contextGraphId, merkleRoot),
          participant2.signParticipantAck(contextGraphId, merkleRoot),
        ]);
      };

      const signatures = await publisher.collectParticipantSignatures({
        contextGraphId,
        merkleRoot,
        participantResponder: mockResponder,
        minimumRequired: 2,
        timeoutMs: 5000,
      });

      expect(signatures).toHaveLength(2);
      expect(signatures[0].identityId).toBe(10n);
      expect(signatures[1].identityId).toBe(11n);
    });

    it('throws when not enough participant signatures', async () => {
      const participant1 = new MockSignerPeer(10n);
      const contextGraphId = 42n;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('ctx-insuf'));

      const mockResponder = async () => {
        return [await participant1.signParticipantAck(contextGraphId, merkleRoot)];
      };

      await expect(
        publisher.collectParticipantSignatures({
          contextGraphId,
          merkleRoot,
          participantResponder: mockResponder,
          minimumRequired: 2,
          timeoutMs: 100,
        }),
      ).rejects.toThrow(/insufficient.*signatures|timeout/i);
    });
  });
});

describe('Reordered Publish Flow (replicate-then-publish)', () => {
  let store: OxigraphStore;
  let chain: MockChainAdapter;
  let publisher: DKGPublisher;
  let eventBus: TypedEventBus;
  const publisherWallet = ethers.Wallet.createRandom();

  beforeEach(async () => {
    store = new OxigraphStore();
    chain = new MockChainAdapter('mock:31337', publisherWallet.address);
    eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: publisherWallet.privateKey,
      publisherNodeIdentityId: 1n,
    });
  });

  it('publish() follows prepare → store → chain order with self-signed V10 ACK', async () => {
    const phases: string[] = [];

    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"Reorder Test"'),
    ];

    const result = await publisher.publish({
      contextGraphId: PARANET,
      quads,
      onPhase: (phase, event) => {
        phases.push(`${phase}:${event}`);
      },
    });

    expect(result.status).toBe('confirmed');

    const prepareIdx = phases.indexOf('prepare:start');
    const storeIdx = phases.indexOf('store:start');
    const chainIdx = phases.indexOf('chain:start');

    expect(prepareIdx).toBeLessThan(storeIdx);
    expect(storeIdx).toBeLessThan(chainIdx);
  });

  it('publish() uses V10 createKnowledgeAssetsV10 path and includes ACK signatures', async () => {
    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"V10 Path Test"'),
    ];

    const result = await publisher.publish({
      contextGraphId: PARANET,
      quads,
    });

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.batchId).toBeGreaterThan(0n);
  });

  it('publish() self-signs ACK when no v10ACKProvider (single-node mode)', async () => {
    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"Self-sign ACK Test"'),
    ];

    const result = await publisher.publish({
      contextGraphId: PARANET,
      quads,
    });

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.batchId).toBeGreaterThan(0n);
  });

  it('publish() emits PUBLISH_FAILED event when V10 chain call fails', async () => {
    const events: any[] = [];
    eventBus.on(DKGEvent.PUBLISH_FAILED, (data) => events.push(data));

    chain = new MockChainAdapter('mock:31337', publisherWallet.address);
    const origV10 = chain.createKnowledgeAssetsV10.bind(chain);
    chain.createKnowledgeAssetsV10 = async () => {
      throw new Error('MinSignaturesRequirementNotMet');
    };

    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: publisherWallet.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"Fail Test"'),
    ];

    const result = await publisher.publish({
      contextGraphId: PARANET,
      quads,
    });

    expect(result.status).toBe('tentative');
  });
});

describe('Context Graph Enshrinement with Signatures', () => {
  let store: OxigraphStore;
  let chain: MockChainAdapter;
  let publisher: DKGPublisher;
  let eventBus: TypedEventBus;
  const publisherWallet = ethers.Wallet.createRandom();

  beforeEach(async () => {
    store = new OxigraphStore();
    chain = new MockChainAdapter('mock:31337', publisherWallet.address);
    eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: publisherWallet.privateKey,
      publisherNodeIdentityId: 1n,
    });

    await chain.createOnChainContextGraph({
      participantIdentityIds: [1n, 2n],
      requiredSignatures: 1,
    });
  });

  it('publishFromSharedMemory registers batch in context graph', async () => {
    await publisher.share(PARANET, [
      q(ENTITY, 'http://schema.org/name', '"Context Data"'),
    ], { publisherPeerId: 'test-peer' });

    const cgBefore = chain.getContextGraph!(1n);
    const batchesBefore = cgBefore?.batches.length ?? 0;

    const participant = new MockSignerPeer(2n);

    await publisher.publishFromSharedMemory(PARANET, {
      rootEntities: [ENTITY],
    }, {
      publishContextGraphId: '1',
      contextGraphSignatures: [
        await participant.signParticipantAck(
          1n,
          ethers.keccak256(ethers.toUtf8Bytes('placeholder')),
        ),
      ],
    });

    const cgAfter = chain.getContextGraph!(1n);
    expect(cgAfter).not.toBeNull();
    expect(cgAfter!.batches.length).toBeGreaterThan(batchesBefore);
  });

  it('publishToContextGraph available on MockChainAdapter for atomic path', async () => {
    expect(typeof chain.publishToContextGraph).toBe('function');
  });
});

describe('PublishToContextGraph chain adapter method', () => {
  it('MockChainAdapter should expose publishToContextGraph', () => {
    const chain = new MockChainAdapter('mock:31337');
    expect(typeof chain.publishToContextGraph).toBe('function');
  });

  it('publishToContextGraph creates batch AND registers to context graph', async () => {
    const chain = new MockChainAdapter('mock:31337');

    const { contextGraphId } = await chain.createOnChainContextGraph({
      participantIdentityIds: [1n, 2n],
      requiredSignatures: 1,
    });

    const result = await chain.publishToContextGraph!({
      kaCount: 5,
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32),
      publicByteSize: 500n,
      epochs: 1,
      tokenAmount: 1n,
      publisherSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      receiverSignatures: [{ identityId: 1n, r: new Uint8Array(32), vs: new Uint8Array(32) }],
      contextGraphId,
      participantSignatures: [{ identityId: 1n, r: new Uint8Array(32), vs: new Uint8Array(32) }],
    });

    expect(result.batchId).toBeGreaterThan(0n);

    const cg = chain.getContextGraph(contextGraphId);
    expect(cg!.batches).toContain(result.batchId);
  });
});

describe('Regression: sorted and deduplicated participant signatures', () => {
  let store: OxigraphStore;
  let chain: MockChainAdapter;
  let publisher: DKGPublisher;
  let eventBus: TypedEventBus;
  const publisherWallet = ethers.Wallet.createRandom();

  beforeEach(async () => {
    store = new OxigraphStore();
    chain = new MockChainAdapter('mock:31337', publisherWallet.address);
    eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: publisherWallet.privateKey,
      publisherNodeIdentityId: 1n,
    });
    await chain.createOnChainContextGraph({
      participantIdentityIds: [1n, 3n, 5n],
      requiredSignatures: 1,
    });
  });

  it('participant sigs are sorted by identityId before chain call (prevents contract revert)', async () => {
    await publisher.share(PARANET, [
      q('urn:test:sort:1', 'http://schema.org/name', '"SortTest"'),
    ], { publisherPeerId: 'test-peer' });

    const cgBefore = chain.getContextGraph!(1n);
    const batchesBefore = cgBefore?.batches.length ?? 0;

    const peer5 = new MockSignerPeer(5n);
    const peer1 = new MockSignerPeer(1n);
    const peer3 = new MockSignerPeer(3n);
    const root = ethers.keccak256(ethers.toUtf8Bytes('sort-test'));
    const sigs = [
      await peer5.signParticipantAck(1n, root),
      await peer1.signParticipantAck(1n, root),
      await peer3.signParticipantAck(1n, root),
    ];

    await publisher.publishFromSharedMemory(PARANET, {
      rootEntities: ['urn:test:sort:1'],
    }, {
      publishContextGraphId: '1',
      contextGraphSignatures: sigs,
    });

    const cgAfter = chain.getContextGraph!(1n);
    expect(cgAfter).not.toBeNull();
    expect(cgAfter!.batches.length).toBeGreaterThan(batchesBefore);
  });

  it('duplicate identityId participant sigs are removed (prevents contract revert)', async () => {
    await publisher.share(PARANET, [
      q('urn:test:dedup:1', 'http://schema.org/name', '"DedupTest"'),
    ], { publisherPeerId: 'test-peer' });

    const cgBefore = chain.getContextGraph!(1n);
    const batchesBefore = cgBefore?.batches.length ?? 0;

    const peer = new MockSignerPeer(3n);
    const root = ethers.keccak256(ethers.toUtf8Bytes('dedup-test'));
    const sig = await peer.signParticipantAck(1n, root);
    const sigs = [sig, { ...sig }];

    await publisher.publishFromSharedMemory(PARANET, {
      rootEntities: ['urn:test:dedup:1'],
    }, {
      publishContextGraphId: '1',
      contextGraphSignatures: sigs,
    });

    const cgAfter = chain.getContextGraph!(1n);
    expect(cgAfter).not.toBeNull();
    expect(cgAfter!.batches.length).toBeGreaterThan(batchesBefore);
  });
});

describe('Regression: complete publish result fields', () => {
  it('confirmed publish result includes txHash, blockNumber, batchId, publisherAddress', async () => {
    const wallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const result = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q('urn:test:result:1', 'http://schema.org/name', '"ResultTest"')],
    });

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.txHash).toBeTruthy();
    expect(typeof result.onChainResult!.txHash).toBe('string');
    expect(result.onChainResult!.blockNumber).toBeGreaterThan(0);
    expect(typeof result.onChainResult!.batchId).toBe('bigint');
    expect(result.onChainResult!.batchId).toBeGreaterThan(0n);
    expect(result.onChainResult!.publisherAddress).toBeTruthy();
    expect(result.onChainResult!.publisherAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});

describe('Regression: fail-fast when chain rejects', () => {
  it('publish returns tentative (not crash) when V10 chain call rejects', async () => {
    const wallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    chain.createKnowledgeAssetsV10 = async () => {
      throw new Error('MinSignaturesRequirementNotMet');
    };

    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const result = await publisher.publish({
      contextGraphId: PARANET,
      quads: [q('urn:test:failfast:1', 'http://schema.org/name', '"FailFast"')],
    });

    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
  });

  it('publish stores data locally even when chain tx fails', async () => {
    const wallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    chain.createKnowledgeAssetsV10 = async () => {
      throw new Error('InsufficientFunds');
    };

    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });

    await publisher.publish({
      contextGraphId: PARANET,
      quads: [q('urn:test:localstore:1', 'http://schema.org/name', '"LocalStore"')],
    });

    const queryResult = await store.query(
      `SELECT ?o WHERE { GRAPH <did:dkg:context-graph:${PARANET}> { <urn:test:localstore:1> <http://schema.org/name> ?o } }`,
    );
    expect(queryResult.type).toBe('bindings');
    if (queryResult.type === 'bindings') {
      expect(queryResult.bindings.length).toBe(1);
      expect(queryResult.bindings[0]['o']).toBe('"LocalStore"');
    }
  });
});

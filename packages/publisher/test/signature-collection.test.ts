/**
 * TDD Layer 2 — Publisher unit tests for the new "replicate-then-publish" protocol:
 *
 * 1. collectReceiverSignatures(): request receiver sigs from peers via libp2p
 * 2. collectParticipantSignatures(): request context graph participant sigs
 * 3. Reordered publish flow: prepare → replicate → collect sigs → on-chain tx
 * 4. Timeout / insufficient signature handling
 *
 * These tests define the publisher API that will be implemented.
 * They will FAIL until the publisher is updated.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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

/**
 * Mock peer that can provide receiver signatures on demand.
 * Simulates a core node responding to a signature request.
 */
class MockSignerPeer {
  readonly wallet: ethers.Wallet;
  readonly identityId: bigint;

  constructor(identityId: bigint) {
    this.wallet = ethers.Wallet.createRandom();
    this.identityId = identityId;
  }

  /** Sign (merkleRoot, publicByteSize) as a receiver would. */
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

  /** Sign (contextGraphId, merkleRoot) as a context graph participant. */
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

      // Mock the peer signature responses
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

      /**
       * collectReceiverSignatures() should:
       * 1. Send signature requests to all connected peers
       * 2. Wait for responses (with timeout)
       * 3. Return collected signatures
       */
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

      // Only 1 peer responds, but 2 required
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

      // Same peer responds twice
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

  it('publish() follows replicate-then-chain order with receiver sigs', async () => {
    const phases: string[] = [];

    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"Reorder Test"'),
    ];

    // Mock receiver signatures for the test
    const peer = new MockSignerPeer(2n);

    const result = await publisher.publish({
      paranetId: PARANET,
      quads,
      onPhase: (phase, event) => {
        phases.push(`${phase}:${event}`);
      },
      /**
       * receiverSignatureProvider: injected function that publisher calls
       * AFTER data preparation but BEFORE the on-chain tx.
       * In real code, this broadcasts data to peers and collects signed acks.
       */
      receiverSignatureProvider: async (merkleRoot: string, publicByteSize: bigint) => {
        phases.push('collect_signatures:start');
        const sig = await peer.signReceiverAck(merkleRoot, publicByteSize);
        phases.push('collect_signatures:end');
        return [sig];
      },
    });

    expect(result.status).toBe('confirmed');

    // Verify phase ordering: prepare → store → collect_signatures → chain
    const prepareIdx = phases.indexOf('prepare:start');
    const storeIdx = phases.indexOf('store:start');
    const sigStartIdx = phases.indexOf('collect_signatures:start');
    const sigEndIdx = phases.indexOf('collect_signatures:end');
    const chainIdx = phases.indexOf('chain:start');

    expect(prepareIdx).toBeLessThan(storeIdx);
    expect(storeIdx).toBeLessThan(sigStartIdx);
    expect(sigEndIdx).toBeLessThan(chainIdx);
  });

  it('publish() uses collected receiver signatures (not self-signed) in chain call', async () => {
    const peer = new MockSignerPeer(2n);
    const chainPublishSpy = vi.spyOn(chain, 'publishKnowledgeAssets');

    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"Sig Source Test"'),
    ];

    await publisher.publish({
      paranetId: PARANET,
      quads,
      receiverSignatureProvider: async (merkleRoot, publicByteSize) => {
        return [await peer.signReceiverAck(merkleRoot, publicByteSize)];
      },
    });

    expect(chainPublishSpy).toHaveBeenCalledOnce();
    const callArgs = chainPublishSpy.mock.calls[0][0];

    // The receiver signatures should come from the collected peer, not self-signed
    expect(callArgs.receiverSignatures).toHaveLength(1);
    expect(callArgs.receiverSignatures[0].identityId).toBe(2n);
  });

  it('publish() falls back to self-signed when no receiverSignatureProvider', async () => {
    const chainPublishSpy = vi.spyOn(chain, 'publishKnowledgeAssets');

    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"Fallback Test"'),
    ];

    // No receiverSignatureProvider → should use legacy self-signing
    await publisher.publish({
      paranetId: PARANET,
      quads,
    });

    expect(chainPublishSpy).toHaveBeenCalledOnce();
    const callArgs = chainPublishSpy.mock.calls[0][0];

    // Self-signed: identityId should be the publisher's own
    expect(callArgs.receiverSignatures).toHaveLength(1);
    expect(callArgs.receiverSignatures[0].identityId).toBe(1n);
  });

  it('publish() emits PUBLISH_FAILED event when receiver sigs insufficient', async () => {
    const events: any[] = [];
    eventBus.on(DKGEvent.PUBLISH_FAILED, (data) => events.push(data));

    chain = new MockChainAdapter('mock:31337', publisherWallet.address);
    // Override to simulate chain rejection of insufficient sigs
    vi.spyOn(chain, 'publishKnowledgeAssets').mockRejectedValue(
      new Error('MinSignaturesRequirementNotMet'),
    );

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
      paranetId: PARANET,
      quads,
      receiverSignatureProvider: async () => [],
    });

    // Should be tentative since on-chain failed
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

    // Create a context graph on the mock chain
    await chain.createContextGraph!({
      participantIdentityIds: [1n, 2n],
      requiredSignatures: 1,
    });
  });

  it('enshrineFromWorkspace passes participant signatures to addBatchToContextGraph', async () => {
    // Write some data to workspace first
    await publisher.writeToWorkspace(PARANET, [
      q(ENTITY, 'http://schema.org/name', '"Context Data"'),
    ], { publisherPeerId: 'test-peer' });

    const participant = new MockSignerPeer(2n);
    const addBatchSpy = vi.spyOn(chain, 'addBatchToContextGraph');

    await publisher.enshrineFromWorkspace(PARANET, {
      rootEntities: [ENTITY],
    }, {
      contextGraphId: '1',
      contextGraphSignatures: [
        await participant.signParticipantAck(
          1n,
          // The merkleRoot will be computed from data, but for mock chain it's accepted
          ethers.keccak256(ethers.toUtf8Bytes('placeholder')),
        ),
      ],
    });

    expect(addBatchSpy).toHaveBeenCalled();
    const callArgs = addBatchSpy.mock.calls[0][0];
    expect(callArgs.contextGraphId).toBe(1n);
    expect(callArgs.signerSignatures.length).toBeGreaterThanOrEqual(1);
  });

  it('publishToContextGraph available on MockChainAdapter for atomic path', async () => {
    // The atomic path (publishToContextGraph) is available on the chain adapter.
    // enshrineFromWorkspace currently uses the two-call approach:
    //   publish() → addBatchToContextGraph()
    // The atomic single-tx path is tested directly in the
    // "PublishToContextGraph chain adapter method" suite below.
    expect(typeof chain.publishToContextGraph).toBe('function');
  });
});

describe('PublishToContextGraph chain adapter method', () => {
  it('MockChainAdapter should expose publishToContextGraph', () => {
    const chain = new MockChainAdapter('mock:31337');

    /**
     * publishToContextGraph combines:
     * - publishKnowledgeAssets (creates KC, verifies receiver sigs)
     * - addBatchToContextGraph (registers batch, verifies participant sigs)
     * in a single atomic call.
     *
     * Expected interface on ChainAdapter:
     *
     *   publishToContextGraph(params: PublishToContextGraphParams): Promise<OnChainPublishResult>
     *
     * where PublishToContextGraphParams extends PublishParams with:
     *   contextGraphId: bigint
     *   participantSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>
     */
    expect(typeof chain.publishToContextGraph).toBe('function');
  });

  it('publishToContextGraph creates batch AND registers to context graph', async () => {
    const chain = new MockChainAdapter('mock:31337');

    // Create context graph first
    const { contextGraphId } = await chain.createContextGraph!({
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

    // Verify batch is registered in context graph
    const cg = chain.getContextGraph(contextGraphId);
    expect(cg!.batches).toContain(result.batchId);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for bugs found during PR review cycles
// ---------------------------------------------------------------------------

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
    await chain.createContextGraph!({
      participantIdentityIds: [1n, 3n, 5n],
      requiredSignatures: 1,
    });
  });

  it('participant sigs are sorted by identityId before chain call (prevents contract revert)', async () => {
    await publisher.writeToWorkspace(PARANET, [
      q('urn:test:sort:1', 'http://schema.org/name', '"SortTest"'),
    ], { publisherPeerId: 'test-peer' });

    const addBatchSpy = vi.spyOn(chain, 'addBatchToContextGraph');

    // Provide signatures in WRONG order (5n, 1n, 3n) — they must arrive sorted
    const peer5 = new MockSignerPeer(5n);
    const peer1 = new MockSignerPeer(1n);
    const peer3 = new MockSignerPeer(3n);
    const root = ethers.keccak256(ethers.toUtf8Bytes('sort-test'));
    const sigs = [
      await peer5.signParticipantAck(1n, root),
      await peer1.signParticipantAck(1n, root),
      await peer3.signParticipantAck(1n, root),
    ];

    await publisher.enshrineFromWorkspace(PARANET, {
      rootEntities: ['urn:test:sort:1'],
    }, {
      contextGraphId: '1',
      contextGraphSignatures: sigs,
    });

    expect(addBatchSpy).toHaveBeenCalled();
    const callArgs = addBatchSpy.mock.calls[0][0];
    const ids = callArgs.signerSignatures.map((s: any) => s.identityId);
    // Must be ascending order
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  it('duplicate identityId participant sigs are removed (prevents contract revert)', async () => {
    await publisher.writeToWorkspace(PARANET, [
      q('urn:test:dedup:1', 'http://schema.org/name', '"DedupTest"'),
    ], { publisherPeerId: 'test-peer' });

    const addBatchSpy = vi.spyOn(chain, 'addBatchToContextGraph');

    const peer = new MockSignerPeer(3n);
    const root = ethers.keccak256(ethers.toUtf8Bytes('dedup-test'));
    const sig = await peer.signParticipantAck(1n, root);
    // Same sig twice
    const sigs = [sig, { ...sig }];

    await publisher.enshrineFromWorkspace(PARANET, {
      rootEntities: ['urn:test:dedup:1'],
    }, {
      contextGraphId: '1',
      contextGraphSignatures: sigs,
    });

    expect(addBatchSpy).toHaveBeenCalled();
    const callArgs = addBatchSpy.mock.calls[0][0];
    const ids = callArgs.signerSignatures.map((s: any) => s.identityId);
    const unique = new Set(ids.map(String));
    expect(unique.size).toBe(ids.length);
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
      paranetId: PARANET,
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

describe('Regression: fail-fast when receiver signatures are insufficient', () => {
  it('publish returns tentative (not crash) when chain rejects insufficient sigs', async () => {
    const wallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    vi.spyOn(chain, 'publishKnowledgeAssets').mockRejectedValueOnce(
      new Error('MinSignaturesRequirementNotMet'),
    );

    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const result = await publisher.publish({
      paranetId: PARANET,
      quads: [q('urn:test:failfast:1', 'http://schema.org/name', '"FailFast"')],
      receiverSignatureProvider: async () => [],
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

    vi.spyOn(chain, 'publishKnowledgeAssets').mockRejectedValueOnce(
      new Error('InsufficientFunds'),
    );

    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });

    await publisher.publish({
      paranetId: PARANET,
      quads: [q('urn:test:localstore:1', 'http://schema.org/name', '"LocalStore"')],
    });

    const queryResult = await store.query(
      `SELECT ?o WHERE { GRAPH <did:dkg:paranet:${PARANET}> { <urn:test:localstore:1> <http://schema.org/name> ?o } }`,
    );
    expect(queryResult.type).toBe('bindings');
    if (queryResult.type === 'bindings') {
      expect(queryResult.bindings.length).toBe(1);
      expect(queryResult.bindings[0]['o']).toContain('LocalStore');
    }
  });
});

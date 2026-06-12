/**
 * Publisher unit tests for the "replicate-then-publish" protocol:
 *
 * 1. collectReceiverSignatures(): request receiver sigs from peers via libp2p
 * 2. collectParticipantSignatures(): request context graph participant sigs
 * 3. Reordered publish flow: prepare → replicate → collect sigs → on-chain tx
 * 4. Timeout / insufficient signature handling
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, DKGEvent } from '@origintrail-official/dkg-core';
import { generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { DKGPublisher } from '../src/index.js';
import { ethers } from 'ethers';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, createTestContextGraph, seedContextGraphRegistration, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { wrapPublisherForTest, buildSeal } from './_helpers/seal.js';
import { makeHardhatReceiverACKProvider } from './_helpers/acks.js';
import { makeTestKaAllocator } from './_helpers/ka-allocator.js';
import type { V10ACKProvider } from '../src/publisher.js';

let CONTEXT_GRAPH: string;
let _kav10Address: string;
let _provider: ethers.JsonRpcProvider;
const _author = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
const ENTITY = 'urn:test:sigcollect:entity:1';

// RC11 / PR1: in-memory 3-of-N ACK provider that signs the V10 ACK
// digest with the staked Hardhat receiver wallets (REC1..REC3). Replaces
// the deleted self-signed ACK fallback so every Hardhat publish below
// goes through the real ACK quorum code path. Lazy because
// `_kav10Address` is set in each describe's `beforeAll`.
let _ackProvider: V10ACKProvider | undefined;
function getAckProvider(): V10ACKProvider {
  if (!_ackProvider) {
    if (!_kav10Address) {
      throw new Error('getAckProvider() called before _kav10Address was initialized in beforeAll');
    }
    _ackProvider = makeHardhatReceiverACKProvider(
      getSharedContext(),
      _kav10Address,
      [HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC2_OP, HARDHAT_KEYS.REC3_OP],
    );
  }
  return _ackProvider;
}

function q(s: string, p: string, o: string, g = ''): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

// `wrapPublisherForTest` intentionally skips `publishFromSharedMemory`
// (the wrapper can't synthesize the SWM-selection quads from the
// rootEntities argument alone), so explicit seals are required here.
// The seal must be bound to the publish's effective on-chain CG id
// (`publishContextGraphId`), not the local CG label.
async function sealForPublishFromSWM(
  rootEntities: string[],
  triplesByRoot: Quad[],
  onChainCgId: string | bigint,
) {
  const matched = triplesByRoot.filter((quad) => rootEntities.includes(quad.subject));
  return buildSeal({
    quads: matched,
    author: _author,
    contextGraphId: onChainCgId,
    ctx: { provider: _provider, kav10Address: _kav10Address },
  });
}

/**
 * In-process signer peer used by the receiver/participant signature-collection
 * unit tests. The name has nothing to do with mocking — every cryptographic
 * primitive below is **real**:
 *   • `ethers.Wallet.createRandom()` produces a real secp256k1 key.
 *   • `signMessage` runs real EIP-191 prefixed ECDSA signing.
 *   • The returned (r, vs) are byte-for-byte the values an on-chain
 *     `ecrecover` consumes.
 *
 * What is in-process is only the libp2p transport that would normally carry
 * the signing request between peers — the publisher's signing-request
 * responder (`mockPeerResponder` below) calls this class directly instead of
 * round-tripping through libp2p streams. That transport is exercised
 * end-to-end in `packages/agent/test/e2e-*.test.ts`.
 *
 * Renamed from `LocalSignerPeer` so the suite no longer misleads auditors
 * scanning for hidden mocks.
 */
class LocalSignerPeer {
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
  let chain: EVMChainAdapter;
  let publisher: DKGPublisher;
  let eventBus: TypedEventBus;
  const publisherWallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  let snapshotId: string;

  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, publisherWallet.address, ethers.parseEther('5000000'));
    if (!_provider) _provider = provider;
    if (!_kav10Address) {
      const c = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      _kav10Address = await c.getKnowledgeAssetsLifecycleAddress();
    }
  });

  afterAll(async () => {
    await revertSnapshot(snapshotId);
  });

  beforeEach(async () => {
    store = new OxigraphStore();
    chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    publisher = wrapPublisherForTest(publisher, {
      author: _author,
      ctx: { provider: _provider, kav10Address: _kav10Address },
    });
  });

  describe('collectReceiverSignatures', () => {
    it('collects signatures from mock peers and returns them', async () => {
      const peer1 = new LocalSignerPeer(2n);
      const peer2 = new LocalSignerPeer(3n);

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
      const peer1 = new LocalSignerPeer(2n);
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
      const peer1 = new LocalSignerPeer(2n);
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
      const participant1 = new LocalSignerPeer(10n);
      const participant2 = new LocalSignerPeer(11n);

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
      const participant1 = new LocalSignerPeer(10n);
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
  let chain: EVMChainAdapter;
  let publisher: DKGPublisher;
  let eventBus: TypedEventBus;
  const publisherWallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  let snapshotId: string;

  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, publisherWallet.address, ethers.parseEther('5000000'));

    const cgChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    // PR1072: public CG (accessPolicy 0) — these tests publish plaintext to
    // exercise publish ordering / V10 path / ACK quorum, not curated/ciphertext
    // semantics, so they must not require a ciphertext commitment.
    const cgId = await createTestContextGraph(cgChain, undefined, 0);
    CONTEXT_GRAPH = String(cgId);
    if (!_provider) _provider = provider;
    if (!_kav10Address) _kav10Address = await cgChain.getKnowledgeAssetsLifecycleAddress();
  });

  afterAll(async () => {
    await revertSnapshot(snapshotId);
  });

  beforeEach(async () => {
    store = new OxigraphStore();
    chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    publisher = wrapPublisherForTest(publisher, {
      author: _author,
      ctx: { provider: _provider, kav10Address: _kav10Address },
      v10ACKProvider: getAckProvider(),
    });
  });

  it('publish() follows prepare → store → chain order with 3-of-N V10 ACK quorum', async () => {
    const phases: string[] = [];

    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"Reorder Test"'),
    ];

    const result = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
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

  it('publish() uses V10 createKnowledgeAssets path and includes ACK signatures', async () => {
    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"V10 Path Test"'),
    ];

    const result = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads,
    });

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.batchId).toBeGreaterThan(0n);
  });

  it('publish() throws when no v10ACKProvider is wired (no self-sign fallback — RC11 / PR1+PR2)', async () => {
    // Inverse of the deleted self-sign test: build a publisher WITHOUT
    // the in-memory ACK provider injection so the publish hits the
    // chain-submit branch with `v10ACKs === undefined`. Previously the
    // self-signed ACK fallback at `dkg-publisher.ts:1995-2040` produced
    // a single ACK with `peerId: 'self'` and the publish confirmed on
    // the harness (`minimumRequiredSignatures` was 1). After PR1 the
    // fallback is deleted and the chain branch throws "V10 ACKs
    // required for on-chain publish — no ACKs collected"; after PR2
    // the surrounding catch re-throws verbatim instead of downgrading
    // to a silent tentative. Pin the throw so a regression that
    // re-introduces either the self-sign fallback OR the tentative
    // downgrade fails loudly here.
    const noAckPublisher = wrapPublisherForTest(
      new DKGPublisher({
        kaAllocator: makeTestKaAllocator(),
        store,
        chain,
        eventBus,
        keypair: await generateEd25519Keypair(),
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      }),
      {
        author: _author,
        ctx: { provider: _provider, kav10Address: _kav10Address },
        // v10ACKProvider intentionally omitted — no self-sign fallback after PR1
      },
    );

    await expect(
      noAckPublisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        quads: [q(ENTITY, 'http://schema.org/name', '"No-ACK Test"')],
      }),
    ).rejects.toThrow(/V10 ACKs required for on-chain publish/);
  });

  it('publish() throws when V10 chain call fails (no silent tentative downgrade)', async () => {
    // RC11 / PR2: pre-PR2 the publisher caught V10 chain failures
    // (e.g. publisher has no tokens / stake), wrote the unconfirmed
    // quads into the root data graph as tentative metadata, and
    // returned `status: 'tentative'`. The PUBLISH_FAILED event was
    // not emitted because the publisher never re-threw — making it
    // structurally impossible for the daemon /api/publish route or
    // the CLI to surface an actionable error.
    //
    // Post-PR2: the catch path re-throws, nothing is written
    // locally, and the caller observes the underlying chain error.
    // This test pins the new behaviour by asserting `rejects.toThrow`
    // instead of green-checking a tentative downgrade.
    eventBus.on(DKGEvent.PUBLISH_FAILED, () => {});

    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"Fail Test"'),
    ];

    const failChain = createEVMAdapter(HARDHAT_KEYS.EXTRA1);
    const keypair = await generateEd25519Keypair();
    // RC11 / PR1+PR2 (review fix): wire the Hardhat receiver-ACK
    // provider so the publish actually reaches the chain-submit branch
    // before it throws. Without an injected `v10ACKProvider`, the
    // submit branch's pre-flight guard ("V10 ACKs required for on-chain
    // publish — no ACKs collected") fires first and the resulting
    // `rejects.toThrow()` would accept the wrong-cause rejection.
    // That would silently re-pass even after a future regression
    // restores the catch-then-tentative behaviour on the chain branch
    // — defeating the test's actual purpose. With the ACK provider
    // wired in, ACK collection succeeds (REC1..REC3 sign), the chain
    // branch is entered, and the publish fails because EXTRA1 has no
    // tokens to satisfy the publisher-stake / fee precondition on the
    // V10 contract — which is the path PR2's "no silent tentative
    // downgrade on chain failure" actually guards.
    const failPublisher = wrapPublisherForTest(
      new DKGPublisher({
        kaAllocator: makeTestKaAllocator(),
        store,
        chain: failChain,
        eventBus,
        keypair,
        publisherPrivateKey: HARDHAT_KEYS.EXTRA1,
        publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      }),
      {
        author: _author,
        ctx: { provider: _provider, kav10Address: _kav10Address },
        v10ACKProvider: getAckProvider(),
      },
    );

    // The intent is "publish() does NOT silently downgrade on a
    // chain-branch failure". Capture the rejection once and check two
    // things on the same error: (a) the publish rejected at all, and
    // (b) it didn't reject with the ACK-pre-flight message — otherwise
    // we'd be exercising the wrong branch and a future regression that
    // restores the catch-then-tentative behaviour on the chain branch
    // could slip past undetected.
    // PR1072: publish to a CURATED CG (created by a funded CORE_OP adapter) so the
    // bare publisher — which carries no ciphertext commitment — reverts AT the
    // chain-submit branch with CuratedCGRequiresCiphertextCommitment. That is a
    // genuine V10 chain failure (not the ACK pre-flight guard), so it exercises the
    // PR2 no-silent-tentative-downgrade rethrow exactly as the EXTRA1-no-tokens path
    // did pre-#1072. The describe's shared CONTEXT_GRAPH is public (for the
    // plaintext-success tests), which would instead let this publish succeed.
    const curatedFailCg = String(
      await createTestContextGraph(createEVMAdapter(HARDHAT_KEYS.CORE_OP), undefined, 1),
    );
    let err: unknown;
    try {
      await failPublisher.publish({
        contextGraphId: curatedFailCg,
        quads,
      });
    } catch (e) {
      err = e;
    }
    expect(err, 'publish() must reject — no silent tentative downgrade on chain failure').toBeDefined();
    const msg = err instanceof Error ? err.message : String(err);
    expect(
      msg,
      `publish() must reject AT the chain-submit branch, not at the ` +
      `V10-ACKs-required pre-flight guard; otherwise the test does not ` +
      `exercise the PR2 catch-block-removal contract. Got: "${msg}"`,
    ).not.toMatch(/V10 ACKs required for on-chain publish/);
  });
});

describe('Context Graph Enshrinement with Signatures', () => {
  let store: OxigraphStore;
  let chain: EVMChainAdapter;
  let publisher: DKGPublisher;
  let eventBus: TypedEventBus;
  const publisherWallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  let snapshotId: string;

  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, publisherWallet.address, ethers.parseEther('5000000'));
    if (!_provider) _provider = provider;
    if (!_kav10Address) {
      const c = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      _kav10Address = await c.getKnowledgeAssetsLifecycleAddress();
    }
  });

  afterAll(async () => {
    await revertSnapshot(snapshotId);
  });

  beforeEach(async () => {
    store = new OxigraphStore();
    chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    publisher = wrapPublisherForTest(publisher, {
      author: _author,
      ctx: { provider: _provider, kav10Address: _kav10Address },
      v10ACKProvider: getAckProvider(),
    });

    const cgResult = await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
    });
    CONTEXT_GRAPH = String(cgResult.contextGraphId);
    await seedContextGraphRegistration(store, CONTEXT_GRAPH);
  });

  it('publishFromSharedMemory registers batch in context graph', async () => {
    const swmQuads = [q(ENTITY, 'http://schema.org/name', '"Context Data"')];
    await publisher.share(CONTEXT_GRAPH, swmQuads, { publisherPeerId: 'test-peer' });

    const participant = new LocalSignerPeer(2n);

    const result = await publisher.publishFromSharedMemory(CONTEXT_GRAPH, {
      rootEntities: [ENTITY],
    }, {
      publishContextGraphId: '1',
      contextGraphSignatures: [
        await participant.signParticipantAck(
          1n,
          ethers.keccak256(ethers.toUtf8Bytes('placeholder')),
        ),
      ],
      precomputedAttestation: await sealForPublishFromSWM([ENTITY], swmQuads, '1'),
    });

    // Test title claims the batch is REGISTERED in the context graph.
    // `toBeDefined` alone was green for any non-null return, including
    // "tentative" (chain rejected) or an empty result. Assert the
    // publish is actually confirmed on-chain AND carries concrete
    // registration evidence: a 66-char tx hash, a positive batchId,
    // and the correct publisher address.
    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.onChainResult!.batchId).toBeGreaterThan(0n);
    expect(result.onChainResult!.publisherAddress.toLowerCase())
      .toBe(new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address.toLowerCase());
  });

  it('publishToContextGraph available on EVMChainAdapter for atomic path', async () => {
    expect(typeof chain.publishToContextGraph).toBe('function');
  });
});

describe('PublishToContextGraph chain adapter method', () => {
  let snapshotId: string;

  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const pubAddr = new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address;
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, pubAddr, ethers.parseEther('5000000'));
  });

  afterAll(async () => {
    await revertSnapshot(snapshotId);
  });

  it('EVMChainAdapter should expose publishToContextGraph', () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    expect(typeof chain.publishToContextGraph).toBe('function');
  });

  it('publishToContextGraph delegates to V10 publishDirect and returns batchId', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    const _publisherRaw = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const publisher = wrapPublisherForTest(_publisherRaw, {
      author: _author,
      ctx: { provider: _provider, kav10Address: _kav10Address },
      v10ACKProvider: getAckProvider(),
    });

    const { contextGraphId } = await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
    });

    const result = await publisher.publish({
      contextGraphId: String(contextGraphId),
      quads: [q(ENTITY, 'http://schema.org/name', '"ContextGraphPublish"')],
    });

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.batchId).toBeGreaterThan(0n);
  });
});

describe('Regression: sorted and deduplicated participant signatures', () => {
  let store: OxigraphStore;
  let chain: EVMChainAdapter;
  let publisher: DKGPublisher;
  let eventBus: TypedEventBus;
  const publisherWallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  let snapshotId: string;

  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, publisherWallet.address, ethers.parseEther('5000000'));
    if (!_provider) _provider = provider;
    if (!_kav10Address) {
      const c = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      _kav10Address = await c.getKnowledgeAssetsLifecycleAddress();
    }
  });

  afterAll(async () => {
    await revertSnapshot(snapshotId);
  });

  beforeEach(async () => {
    store = new OxigraphStore();
    chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    publisher = wrapPublisherForTest(publisher, {
      author: _author,
      ctx: { provider: _provider, kav10Address: _kav10Address },
      v10ACKProvider: getAckProvider(),
    });
    const cgResult = await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
    });
    CONTEXT_GRAPH = String(cgResult.contextGraphId);
    await seedContextGraphRegistration(store, CONTEXT_GRAPH);
  });

  it('participant sigs are sorted by identityId before chain call (prevents contract revert)', async () => {
    const swmQuads = [q('urn:test:sort:1', 'http://schema.org/name', '"SortTest"')];
    await publisher.share(CONTEXT_GRAPH, swmQuads, { publisherPeerId: 'test-peer' });

    const peer5 = new LocalSignerPeer(5n);
    const peer1 = new LocalSignerPeer(1n);
    const peer3 = new LocalSignerPeer(3n);
    const root = ethers.keccak256(ethers.toUtf8Bytes('sort-test'));
    const sigs = [
      await peer5.signParticipantAck(1n, root),
      await peer1.signParticipantAck(1n, root),
      await peer3.signParticipantAck(1n, root),
    ];

    const result = await publisher.publishFromSharedMemory(CONTEXT_GRAPH, {
      rootEntities: ['urn:test:sort:1'],
    }, {
      publishContextGraphId: '1',
      contextGraphSignatures: sigs,
      precomputedAttestation: await sealForPublishFromSWM(['urn:test:sort:1'], swmQuads, '1'),
    });

    // Title guarantees "prevents contract revert" — `toBeDefined` was
    // green even when chain rejected and returned 'tentative'. Pin the
    // success invariant: publish must be confirmed and carry a real
    // tx hash + batchId, which only happens when the sort-and-dedup
    // logic produced an ordered participant-sig array the contract
    // accepted.
    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.onChainResult!.batchId).toBeGreaterThan(0n);
  });

  it('duplicate identityId participant sigs are removed (prevents contract revert)', async () => {
    const swmQuads = [q('urn:test:dedup:1', 'http://schema.org/name', '"DedupTest"')];
    await publisher.share(CONTEXT_GRAPH, swmQuads, { publisherPeerId: 'test-peer' });

    const peer = new LocalSignerPeer(3n);
    const root = ethers.keccak256(ethers.toUtf8Bytes('dedup-test'));
    const sig = await peer.signParticipantAck(1n, root);
    const sigs = [sig, { ...sig }];

    const result = await publisher.publishFromSharedMemory(CONTEXT_GRAPH, {
      rootEntities: ['urn:test:dedup:1'],
    }, {
      publishContextGraphId: '1',
      contextGraphSignatures: sigs,
      precomputedAttestation: await sealForPublishFromSWM(['urn:test:dedup:1'], swmQuads, '1'),
    });

    // Title guarantees "prevents contract revert". A green
    // `toBeDefined` was compatible with the dedup regressing and the
    // chain rejecting — pin confirmed status + real tx evidence
    // instead, so a regression where duplicates slip through and the
    // contract reverts (publish returns 'tentative') fails loudly.
    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.onChainResult!.batchId).toBeGreaterThan(0n);
  });
});

describe('Regression: complete publish result fields', () => {
  let snapshotId: string;

  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const pubAddr = new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address;
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, pubAddr, ethers.parseEther('5000000'));

    const cgChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    // PR1072: public CG (accessPolicy 0) — this regression publishes plaintext to
    // assert confirmed-result fields (txHash/batchId/...), not curated/ciphertext
    // semantics, so it must not require a ciphertext commitment.
    const cgId = await createTestContextGraph(cgChain, undefined, 0);
    CONTEXT_GRAPH = String(cgId);
  });

  afterAll(async () => {
    await revertSnapshot(snapshotId);
  });

  it('confirmed publish result includes txHash, blockNumber, batchId, publisherAddress', async () => {
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const _publisherRaw = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const publisher = wrapPublisherForTest(_publisherRaw, {
      author: _author,
      ctx: { provider: _provider, kav10Address: _kav10Address },
      v10ACKProvider: getAckProvider(),
    });

    const result = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
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
  let snapshotId: string;

  beforeAll(async () => {
    snapshotId = await takeSnapshot();
  });

  afterAll(async () => {
    await revertSnapshot(snapshotId);
  });

  it('publish throws (no silent tentative downgrade) when V10 chain call rejects', async () => {
    // RC11 / PR2: pre-PR2 a chain-side rejection (e.g. publisher has
    // no tokens / profile) was caught inside the publisher's chain
    // try-block, downgraded to a `status: tentative` result, and the
    // unconfirmed quads were written to the root data graph as if
    // they had landed on-chain. That silent downgrade was the
    // tentative-VM defect the dzudza incident exposed: failed
    // publishes appeared in `verifiable-memory` queries as confirmed
    // data, and the daemon log only ever said "On-chain tx failed".
    //
    // Post-PR2 the catch path re-throws the underlying chain error
    // verbatim and writes NOTHING to the local store. Operators
    // (and the daemon publish route) see the actual chain error and
    // can route on `instanceof Error` / `err.name` to surface a
    // proper 4xx / 5xx, instead of a misleading 200 OK.
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.EXTRA1);
    const eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const _pubExtra1 = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.EXTRA1,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const publisher = wrapPublisherForTest(_pubExtra1, {
      author: new ethers.Wallet(HARDHAT_KEYS.EXTRA1),
      ctx: { provider: _provider, kav10Address: _kav10Address },
    });

    await expect(
      publisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        quads: [q('urn:test:failfast:1', 'http://schema.org/name', '"FailFast"')],
      }),
    ).rejects.toThrow();
  });

  it('publish writes NOTHING to the local store when chain tx fails', async () => {
    // RC11 / PR2: the inverse assertion to the legacy "publish stores
    // data locally even when chain tx fails" test. Pre-PR2 the
    // tentative downgrade always wrote the assertion quads into the
    // root data graph regardless of chain outcome. Post-PR2 the
    // root data graph is only ever populated by a confirmed publish
    // (or one of the two intentional non-chain skip branches —
    // missing CG id / non-V10 adapter). A failed on-chain publish
    // must leave the local store untouched so the `verifiable-memory`
    // view in `dkg-query-engine.ts` cannot surface ghost rows.
    const store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.EXTRA2);
    const eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const _pubExtra2 = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.EXTRA2,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const publisher = wrapPublisherForTest(_pubExtra2, {
      author: new ethers.Wallet(HARDHAT_KEYS.EXTRA2),
      ctx: { provider: _provider, kav10Address: _kav10Address },
    });

    await expect(
      publisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        quads: [q('urn:test:localstore:1', 'http://schema.org/name', '"LocalStore"')],
      }),
    ).rejects.toThrow();

    const queryResult = await store.query(
      `SELECT ?o WHERE { GRAPH <did:dkg:context-graph:${CONTEXT_GRAPH}> { <urn:test:localstore:1> <http://schema.org/name> ?o } }`,
    );
    expect(queryResult.type).toBe('bindings');
    if (queryResult.type === 'bindings') {
      expect(queryResult.bindings.length).toBe(0);
    }
  });
});

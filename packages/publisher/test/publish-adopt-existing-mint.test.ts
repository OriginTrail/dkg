/**
 * Adopt-existing-mint interception (dkg-publisher `adoptExistingMintOrRethrow`).
 *
 * A transient error during confirm-wait can land the mint on-chain while the
 * publisher records failure; every retry then reverts `KaIdAlreadyMinted`
 * forever. When that revert decodes to OUR reserved kaId on a sealed
 * graph-scoped publish, the publisher must verify chain truth + recover the
 * original mint's provenance via `ChainAdapter.getMintedKnowledgeAssetProvenance`
 * and fall through the UNCHANGED confirmed-publish path. Anything not provably
 * ours — a different kaId, or unrecoverable provenance (`null`) — must rethrow
 * the ORIGINAL error object verbatim: the publisher must never synthesize a
 * txHash (finalization-handler invariant).
 *
 * Integration-shaped: these tests drive the real `publish()` graph-scoped
 * path end to end (seal preflight, ACK collection, chain submit, VM storage)
 * against a `MockChainAdapter` subclass whose `createKnowledgeAssets` throws
 * an ethers-style CALL_EXCEPTION already stamped with the structured
 * `revert = { name: 'KaIdAlreadyMinted', args: [kaId] }` shape that
 * `enrichEvmError` produces (with `revert` pre-stamped and no raw revert-data
 * fields, the classifier's defensive re-enrich is a no-op). The decode of raw
 * revert data into that shape is covered separately in
 * `packages/chain/test/enrich-evm-error-extra.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  TypedEventBus,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { MockChainAdapter, type OnChainPublishResult } from '@origintrail-official/dkg-chain';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { buildSeal, mockSealCtx } from './_helpers/seal.js';
import { mockChainStubACKProvider } from './_helpers/acks.js';

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const CONTEXT_GRAPH_ID = '1';
const ADOPTED_TX_HASH = `0x${'abc1'.repeat(16)}`;

/**
 * Mirrors `AdapterSigningChain` from publisher-no-random-wallet.test.ts
 * (adapter-backed signer bound to a real wallet) plus the two hooks this
 * suite exercises: a configurable `createKnowledgeAssets` mint failure and a
 * recording `getMintedKnowledgeAssetProvenance` stub.
 */
class AdoptableMintChain extends MockChainAdapter {
  mintError?: unknown;
  createAttempts = 0;
  provenanceCalls: Array<{
    kaId: bigint;
    expectedMerkleRoot: Uint8Array;
    expectedContextGraphId: bigint;
  }> = [];
  provenanceResult: OnChainPublishResult | null = null;

  constructor(private readonly wallet: ethers.Wallet) {
    super('mock:31337', wallet.address);
    this.seedIdentity(wallet.address, 1n);
    this.minimumRequiredSignatures = 1;
  }

  override async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(await this.wallet.signMessage(messageHash));
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.wallet.signTypedData(domain, types, value);
  }

  override async createKnowledgeAssets(
    params: Parameters<MockChainAdapter['createKnowledgeAssets']>[0],
  ): Promise<OnChainPublishResult> {
    this.createAttempts += 1;
    if (this.mintError !== undefined) throw this.mintError;
    return super.createKnowledgeAssets(params);
  }

  async getMintedKnowledgeAssetProvenance(
    kaId: bigint,
    expectedMerkleRoot: Uint8Array,
    expectedContextGraphId: bigint,
  ): Promise<OnChainPublishResult | null> {
    this.provenanceCalls.push({ kaId, expectedMerkleRoot, expectedContextGraphId });
    return this.provenanceResult;
  }
}

/**
 * Ethers-style CALL_EXCEPTION carrying the structured revert that
 * `enrichEvmError` stamps after decoding a `KaIdAlreadyMinted(uint256)`
 * custom-error revert (see the classifier tests in the chain package for
 * the raw-data → structured-shape decode itself).
 */
function kaIdAlreadyMintedRevert(kaId: bigint): Error {
  return Object.assign(
    new Error(`execution reverted (custom error): KaIdAlreadyMinted(${kaId})`),
    {
      code: 'CALL_EXCEPTION',
      revert: { name: 'KaIdAlreadyMinted', args: [kaId] },
    },
  );
}

/**
 * Build a sealed graph-scoped publish argument bag against a fresh
 * publisher + AdoptableMintChain. Mirrors the graph-scoped publish setup in
 * publisher-no-random-wallet.test.ts: the seal allocates the packed
 * reservedKaId, and the kaUal must derive exactly that id.
 */
async function setupSealedGraphPublish() {
  const wallet = new ethers.Wallet(TEST_KEY);
  const chain = new AdoptableMintChain(wallet);
  const publisher = new DKGPublisher({
    store: new OxigraphStore(),
    chain,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    publisherNodeIdentityId: 1n,
  });
  const publishQuad: Quad = {
    subject: 'urn:test:adopt-existing-mint',
    predicate: 'http://schema.org/name',
    object: '"adopted"',
    graph: '',
  };
  const seal = await buildSeal({
    quads: [publishQuad],
    author: wallet,
    contextGraphId: CONTEXT_GRAPH_ID,
    ctx: mockSealCtx(),
  });
  const reservedKaId = seal.reservedKaId;
  const kaNumber = reservedKaId & ((1n << 96n) - 1n);
  // Bare EIP-155 label targets the adapter's `mock:31337` via numeric alias;
  // lowercase author address = the canonical scope UAL the publisher returns.
  const ual = `did:dkg:31337/${wallet.address.toLowerCase()}/${kaNumber}`;
  const publishOptions = {
    contextGraphId: CONTEXT_GRAPH_ID,
    quads: [publishQuad],
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: ual,
    assertionVersion: 1,
    publicTripleCount: 1,
    privateTripleCount: 0,
    precomputedAttestation: seal,
    v10ACKProvider: mockChainStubACKProvider(),
  };
  return { wallet, chain, publisher, seal, reservedKaId, ual, publishOptions };
}

describe('publish adopt-existing-mint interception (KaIdAlreadyMinted)', () => {
  it('adopts OUR already-minted kaId: synthesized provenance flows through the confirmed path', async () => {
    const s = await setupSealedGraphPublish();
    s.chain.mintError = kaIdAlreadyMintedRevert(s.reservedKaId);
    s.chain.provenanceResult = {
      batchId: s.reservedKaId,
      kaId: s.reservedKaId,
      startKAId: s.reservedKaId,
      endKAId: s.reservedKaId,
      merkleRoot: s.seal.expectedMerkleRoot,
      knowledgeAssetsContract: (await s.chain.getDKGKnowledgeAssetsAddress()).toLowerCase(),
      txHash: ADOPTED_TX_HASH,
      blockNumber: 4242,
      txIndex: 0,
      blockTimestamp: 1_753_000_000,
      publisherAddress: s.wallet.address,
      authorAddress: s.wallet.address,
    };

    const result = await s.publisher.publish(s.publishOptions);

    expect(result.status).toBe('confirmed');
    expect(result.ual).toBe(s.ual);
    // The synthesized provenance IS the on-chain result of this publish.
    expect(result.onChainResult?.txHash).toBe(ADOPTED_TX_HASH);
    expect(result.onChainResult?.blockNumber).toBe(4242);
    expect(s.chain.createAttempts).toBe(1);
    // Chain truth was verified with exactly (reservedKaId, sealedRoot, cgId).
    expect(s.chain.provenanceCalls).toHaveLength(1);
    const call = s.chain.provenanceCalls[0];
    expect(call.kaId).toBe(s.reservedKaId);
    expect(ethers.hexlify(call.expectedMerkleRoot)).toBe(
      ethers.hexlify(s.seal.expectedMerkleRoot),
    );
    expect(call.expectedContextGraphId).toBe(BigInt(CONTEXT_GRAPH_ID));
  });

  it('rethrows the ORIGINAL error for someone else\'s kaId — no provenance lookup', async () => {
    const s = await setupSealedGraphPublish();
    const original = kaIdAlreadyMintedRevert(s.reservedKaId + 1n);
    s.chain.mintError = original;

    const caught = await s.publisher.publish(s.publishOptions).then(
      () => null,
      (err: unknown) => err,
    );

    // Verbatim rethrow of the original error object, still carrying the
    // structured revert — downstream classifiers must keep working.
    expect(caught).toBe(original);
    expect((caught as { revert?: { name?: string } }).revert?.name).toBe('KaIdAlreadyMinted');
    // A foreign kaId must never trigger a chain-truth probe.
    expect(s.chain.provenanceCalls).toHaveLength(0);
  });

  it('rethrows the ORIGINAL error when provenance is unrecoverable (null) — never synthesizes a txHash', async () => {
    const s = await setupSealedGraphPublish();
    const original = kaIdAlreadyMintedRevert(s.reservedKaId);
    s.chain.mintError = original;
    s.chain.provenanceResult = null;

    const caught = await s.publisher.publish(s.publishOptions).then(
      () => null,
      (err: unknown) => err,
    );

    expect(caught).toBe(original);
    expect((caught as { revert?: { name?: string } }).revert?.name).toBe('KaIdAlreadyMinted');
    // The adoption path DID consult chain truth for our kaId before giving up.
    expect(s.chain.provenanceCalls).toHaveLength(1);
    expect(s.chain.provenanceCalls[0].kaId).toBe(s.reservedKaId);
  });
});

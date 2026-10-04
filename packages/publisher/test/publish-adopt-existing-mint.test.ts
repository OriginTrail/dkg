/**
 * Adopt-existing-mint interception (`createKnowledgeAssetsWithMintAdoption`).
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
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  TypedEventBus,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  createOperationContext,
  Logger,
  generateEd25519Keypair,
  ed25519Sign, encodeAccessRequest, decodeAccessResponse,
} from '@origintrail-official/dkg-core';
import { MockChainAdapter, type OnChainPublishResult, type AdoptedMintPublishResult } from '@origintrail-official/dkg-chain';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { createKnowledgeAssetsWithMintAdoption } from '../src/adopt-existing-mint.js';
import { computePrivateRootV10 } from '../src/merkle.js';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { AccessHandler } from '../src/access-handler.js';
import { buildSeal, buildUpdateSeal, mockSealCtx } from './_helpers/seal.js';
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
  provenanceResult: AdoptedMintPublishResult | null = null;

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
  ): Promise<AdoptedMintPublishResult | null> {
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
async function setupSealedGraphPublish(privateQuads: Quad[] = []) {
  const wallet = new ethers.Wallet(TEST_KEY);
  const chain = new AdoptableMintChain(wallet);
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
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
    privateQuads,
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
    privateQuads,
    publisherPeerId: 'adoption-publisher',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: ual,
    assertionVersion: 1,
    publicTripleCount: 1,
    privateTripleCount: privateQuads.length,
    ...(privateQuads.length ? { privateMerkleRoot: computePrivateRootV10(privateQuads)! } : {}),
    precomputedAttestation: seal,
    v10ACKProvider: mockChainStubACKProvider(),
  };
  return { wallet, chain, publisher, store, seal, reservedKaId, ual, publishOptions };
}

describe('publish adopt-existing-mint interception (KaIdAlreadyMinted)', () => {
  it.each(['allowList', 'ownerOnly'] as const)('converges equal-version adoption metadata after revoking peers to %s', async policy => {
    const privateQuads = [{ subject: 'urn:test:adopt-existing-mint', predicate: 'urn:test:secret', object: '"private value"', graph: '' }];
    const s = await setupSealedGraphPublish(privateQuads);
    try {
      // Real access reads require the registration owned by joined context graphs.
      await s.store.insert([{ subject: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://dkg.network/ontology#ContextGraph', graph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_meta` }]);
      const original = await s.publisher.publish({ ...s.publishOptions, accessPolicy: 'allowList', allowedPeers: ['Alice', 'Bob'] });
      expect(original.status).toBe('confirmed');
      const handler = new AccessHandler(s.store, new TypedEventBus());
      const key = await generateEd25519Keypair();
      const request = encodeAccessRequest({ kaUal: s.ual, requesterPeerId: 'Bob', paymentProof: new Uint8Array(0),
        requesterSignature: await ed25519Sign(new TextEncoder().encode(s.ual), key.secretKey), requesterPublicKey: key.publicKey });
      async function access(peer: string) { return decodeAccessResponse(await handler.handler(request, peer as never)); }
      expect(await access('Bob')).toMatchObject({ granted: true, rejectionReason: '' });
      s.chain.mintError = kaIdAlreadyMintedRevert(s.reservedKaId);
      s.chain.provenanceResult = await MockChainAdapter.prototype.getMintedKnowledgeAssetProvenance.call(
        s.chain, s.reservedKaId, original.merkleRoot, BigInt(CONTEXT_GRAPH_ID));
      const retry = await s.publisher.publish({ ...s.publishOptions, accessPolicy: policy,
        ...(policy === 'allowList' ? { allowedPeers: ['Alice'] } : {}) });
      expect(retry.status).toBe('confirmed');
      expect(retry.onChainResult?.txHash).toBe(original.onChainResult?.txHash);
      expect(s.chain.provenanceCalls).toHaveLength(1);
      const meta = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_meta`;
      expect(await s.store.query(`SELECT ?policy WHERE { GRAPH <${meta}> { <${s.ual}> <http://dkg.io/ontology/accessPolicy> ?policy } }`))
        .toMatchObject({ bindings: [{ policy: JSON.stringify(policy) }] });
      const peers = await s.store.query(`SELECT ?peer WHERE { GRAPH <${meta}> { <${s.ual}> <http://dkg.io/ontology/allowedPeer> ?peer } }`);
      expect(peers).toMatchObject({ bindings: policy === 'allowList' ? [{ peer: '"Alice"' }] : [] });
      expect(await access('Bob')).toMatchObject({ granted: false });
      const permitted = await access(policy === 'allowList' ? 'Alice' : 'adoption-publisher');
      expect(permitted.granted).toBe(true);
      expect(new TextDecoder().decode(permitted.nquads)).toContain('private value');
    } finally { await s.store.close(); }
  });

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
      blockHash: `0x${'ef'.repeat(32)}`,
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
  it('does not attempt adoption for an ordinary transport failure', async () => {
    const s = await setupSealedGraphPublish();
    const original = new Error('RPC unavailable');
    s.chain.mintError = original;
    await expect(s.publisher.publish(s.publishOptions)).rejects.toBe(original);
    expect(s.chain.provenanceCalls).toHaveLength(0);
  });

  it('preserves a typed collision refusal from the chain proof', async () => {
    const s = await setupSealedGraphPublish();
    s.chain.mintError = kaIdAlreadyMintedRevert(s.reservedKaId);
    const collision = Object.assign(new Error('the existing root differs'), { code: 'KA_ID_COLLISION' });
    vi.spyOn(s.chain, 'getMintedKnowledgeAssetProvenance').mockRejectedValue(collision);
    await expect(s.publisher.publish(s.publishOptions)).rejects.toBe(collision);
  });

  it.each(['public', 'private', 'metadata'] as const)('retains newer %s while the old mint provenance is held', async slice => {
    const subject = 'urn:test:adopt-existing-mint';
    const oldPrivate = [{ subject, predicate: 'urn:test:secret', object: '"old private"', graph: '' }];
    const s = await setupSealedGraphPublish(oldPrivate);
    try {
      const initial = await s.publisher.publish(s.publishOptions);
      expect(initial.status).toBe('confirmed');
      s.chain.mintError = kaIdAlreadyMintedRevert(s.reservedKaId);
      let release!: () => void;
      let entered!: () => void;
      const enteredProof = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      vi.spyOn(s.chain, 'getMintedKnowledgeAssetProvenance').mockImplementation(async () => {
        entered();
        await held;
        return initial.onChainResult!;
      });
      const retry = s.publisher.publish(s.publishOptions);
      await enteredProof;
      const quads = [{ ...s.publishOptions.quads[0], object: '"new public"' }];
      const privateQuads = [{ ...oldPrivate[0], object: '"new private"' }];
      const updateSeal = await buildUpdateSeal({ kaId: initial.kaId, quads, privateQuads,
        author: s.wallet, ctx: mockSealCtx() });
      const updated = await s.publisher.update(initial.kaId, {
        contextGraphId: CONTEXT_GRAPH_ID, quads, privateQuads,
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION, kaUal: s.ual,
        assertionVersion: 2, publicTripleCount: 1, privateTripleCount: 1,
        privateMerkleRoot: computePrivateRootV10(privateQuads)!,
        precomputedUpdateAttestation: updateSeal, v10ACKProvider: mockChainStubACKProvider(),
      });
      expect(updated.status).toBe('confirmed');
      const scope = createGraphKnowledgeAssetScope(s.ual, 2);
      const vmGraph = knowledgeAssetLayerGraphUri(CONTEXT_GRAPH_ID, MemoryLayer.VerifiableMemory, scope);
      const metaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_meta`;
      const readMetadata = () => s.store.query(`CONSTRUCT { <${s.ual}> ?p ?o } WHERE {
        GRAPH <${metaGraph}> { <${s.ual}> ?p ?o } }`);
      const currentMetadata = await readMetadata();
      const privateStore = Reflect.get(s.publisher, 'privateStore');
      const privateWrites = vi.spyOn(privateStore, 'replaceKnowledgeAssetPrivateTriples');
      const scopedPromotion = vi.spyOn(s.publisher as unknown as {
        promoteConfirmedKCToScopedGraph: (...args: unknown[]) => Promise<void>;
      }, 'promoteConfirmedKCToScopedGraph');
      release();
      expect((await retry).status).toBe('confirmed');
      if (slice === 'public') await expect(s.store.query(`SELECT ?o WHERE { GRAPH <${vmGraph}> {
        <${subject}> <http://schema.org/name> ?o } }`))
        .resolves.toMatchObject({ type: 'bindings', bindings: [{ o: '"new public"' }] });
      if (slice === 'private') {
        await expect(privateStore.getKnowledgeAssetPrivateTriples(CONTEXT_GRAPH_ID, scope))
          .resolves.toEqual(privateQuads);
        expect(privateWrites).not.toHaveBeenCalled();
      }
      if (slice === 'metadata') {
        expect(await readMetadata()).toEqual(currentMetadata);
        expect(scopedPromotion).not.toHaveBeenCalled();
      }
    } finally {
      await s.store.close();
    }
  });

  it('keeps an otherwise adoptable unsealed submission ineligible', async () => {
    const s = await setupSealedGraphPublish();
    try {
      const submitted = vi.spyOn(s.chain, 'createKnowledgeAssets');
      const initial = await s.publisher.publish(s.publishOptions);
      // Capture the actual V10 envelope instead of maintaining a duplicate fixture.
      const params = submitted.mock.calls[0][0];
      const original = kaIdAlreadyMintedRevert(s.reservedKaId);
      s.chain.mintError = original;
      s.chain.provenanceResult = await MockChainAdapter.prototype.getMintedKnowledgeAssetProvenance.call(
        s.chain, s.reservedKaId, initial.merkleRoot, BigInt(CONTEXT_GRAPH_ID));
      await expect(createKnowledgeAssetsWithMintAdoption(s.chain, params, false,
        createOperationContext('test'), new Logger('test'))).rejects.toBe(original);
      expect(s.chain.provenanceCalls).toHaveLength(0);
    } finally { await s.store.close(); }
  });

  it('preserves ordinary successful mint behavior without a provenance lookup', async () => {
    const s = await setupSealedGraphPublish();
    try {
      const result = await s.publisher.publish({ contextGraphId: CONTEXT_GRAPH_ID,
        quads: s.publishOptions.quads, precomputedAttestation: s.seal,
        v10ACKProvider: mockChainStubACKProvider() });
      expect(result.status).toBe('confirmed');
      expect(result.onChainResult?.batchId).toBe(s.reservedKaId);
      expect(s.chain.createAttempts).toBe(1);
      expect(s.chain.provenanceCalls).toHaveLength(0);
      const graph = knowledgeAssetLayerGraphUri(CONTEXT_GRAPH_ID, MemoryLayer.VerifiableMemory,
        createGraphKnowledgeAssetScope(s.ual, 1));
      await expect(s.store.query(`ASK { GRAPH <${graph}> {
        <urn:test:adopt-existing-mint> <http://schema.org/name> "adopted" } }`))
        .resolves.toMatchObject({ type: 'boolean', value: true });
    } finally { await s.store.close(); }
  });

  it('keeps an otherwise adoptable ordinary non-graph publish ineligible', async () => {
    const s = await setupSealedGraphPublish();
    try {
      const initial = await s.publisher.publish(s.publishOptions);
      s.chain.provenanceResult = await MockChainAdapter.prototype.getMintedKnowledgeAssetProvenance.call(
        s.chain, s.reservedKaId, initial.merkleRoot, BigInt(CONTEXT_GRAPH_ID));
      const original = kaIdAlreadyMintedRevert(s.reservedKaId);
      s.chain.mintError = original;
      await expect(s.publisher.publish({ contextGraphId: CONTEXT_GRAPH_ID,
        quads: s.publishOptions.quads, precomputedAttestation: s.seal,
        v10ACKProvider: mockChainStubACKProvider() })).rejects.toBe(original);
      expect(s.chain.provenanceCalls).toHaveLength(0);
    } finally { await s.store.close(); }
  });

});

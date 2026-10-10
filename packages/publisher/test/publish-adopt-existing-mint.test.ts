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
import { setImmediate } from 'node:timers/promises';
import { generatedPrivateCatalogTripleKeys, generatedPrivateCatalogFloorQuads } from '../src/catalog-trust.js';
import {
  overlayLocallyTrustedKnowledgeAssetControls, readLocallyTrustedKnowledgeAssetControlEnvelope,
  readMaterializedVersion, withMaterializationLock,
} from '../src/metadata.js';
import { computePrivateRootV10 } from '../src/merkle.js';
import type { UpdateOptions } from '../src/publisher.js';
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

/** A confirmed retry uses the same chain evidence while the local write is repaired. */
async function sealedUpdateFixture() {
  const s = await setupSealedGraphPublish();
  const initial = await s.publisher.publish(s.publishOptions);
  expect(initial.status).toBe('confirmed');
  const meta = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_meta`;
  const prior = await readMaterializedVersion(s.store, meta, s.ual);
  if (!prior) throw new Error('Initial publish must persist its ordering fence');
  const version = { blockNumber: prior.blockNumber + 1, txIndex: 0 };
  vi.spyOn(s.chain, 'updateKnowledgeCollectionV10').mockResolvedValue({
    success: true, hash: `0x${'de'.repeat(32)}`, ...version,
  });
  vi.spyOn(s.chain, 'getContextGraphFinalizedCreation').mockResolvedValue({
    nameHash: ethers.ZeroHash, accessPolicy: 1,
  });
  const quads = [{ ...s.publishOptions.quads[0], object: '"new public"' }];
  const privateQuads = [{ ...quads[0], predicate: 'urn:test:secret', object: '"new private"' }];
  const precomputedUpdateAttestation = await buildUpdateSeal({ kaId: s.reservedKaId,
    quads, privateQuads, author: s.wallet, ctx: mockSealCtx() });
  const options = { contextGraphId: CONTEXT_GRAPH_ID, onChainContextGraphId: 1n,
    quads, privateQuads, contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: s.ual, assertionVersion: 2, publicTripleCount: 1, privateTripleCount: 1,
    privateMerkleRoot: computePrivateRootV10(privateQuads)!, precomputedUpdateAttestation,
    trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CONTEXT_GRAPH_ID),
    encryptInlinePayload: async (plaintext: Uint8Array) => plaintext,
  } satisfies UpdateOptions;
  return { ...s, meta, prior, version, options };
}

describe('publish adopt-existing-mint interception (KaIdAlreadyMinted)', () => {
  it.each(['identity moved', 'revoked access'] as const)(
    'prepares fresh %s metadata only after the shared confirmed KA lock is acquired', async change => {
      const s = await sealedUpdateFixture();
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const holder = withMaterializationLock(s.meta, s.ual, async () => { entered(); await gate; });
      await ready;
      const identity = vi.spyOn(s.publisher as unknown as {
        readGraphKnowledgeAssetIdentity: (meta: string, ual: string) => Promise<unknown>;
      }, 'readGraphKnowledgeAssetIdentity');
      const compound = vi.spyOn(s.store, 'replaceGraphAndSubject');
      const update = s.publisher.update(s.reservedKaId, s.options);
      // Install a rejection observer before releasing the held writer.
      const outcome = update.then(result => ({ result }), error => ({ error }));
      try {
        await vi.waitFor(() => expect(s.chain.updateKnowledgeCollectionV10).toHaveBeenCalledOnce());
        await setImmediate();
        expect(identity).not.toHaveBeenCalled();
        expect(compound).not.toHaveBeenCalled();
        if (change === 'identity moved') {
          await s.store.insert([{ subject: s.ual, predicate: 'http://dkg.io/ontology/subGraphName',
            object: '"moved"', graph: s.meta }]);
        } else {
          await s.store.deleteByPattern({ subject: s.ual, graph: s.meta, predicate: 'http://dkg.io/ontology/accessPolicy' });
          await s.store.insert([{ subject: s.ual, predicate: 'http://dkg.io/ontology/accessPolicy',
            object: '"ownerOnly"', graph: s.meta }]);
        }
        release(); await holder;
        const settled = await outcome;
        expect(identity).toHaveBeenCalledOnce();
        if (change === 'identity moved') {
          expect(settled).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining('cannot move') }) });
          expect(compound).not.toHaveBeenCalled();
          expect(await readMaterializedVersion(s.store, s.meta, s.ual)).toEqual(s.prior);
          expect(await s.store.countQuads(`did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_catalog`)).toBe(0);
        } else {
          expect(settled).toMatchObject({ result: { status: 'confirmed' } });
          expect(compound).toHaveBeenCalledOnce();
          expect(await s.store.query(`SELECT ?policy WHERE { GRAPH <${s.meta}> {
            <${s.ual}> <http://dkg.io/ontology/accessPolicy> ?policy } }`))
            .toMatchObject({ bindings: [{ policy: '"ownerOnly"' }] });
        }
      } finally { release(); await Promise.allSettled([holder, outcome]); await s.store.close(); }
    });

  it.each(['private', 'metadata', 'catalog'] as const)(
    'retains the previous update fence after a committed %s failure and repairs the equal-version retry', async slice => {
      const s = await sealedUpdateFixture();
      const catalog = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_catalog`;
      try {
        if (slice === 'private') {
          const privateStore = Reflect.get(s.publisher, 'privateStore');
          const replace = privateStore.replaceKnowledgeAssetPrivateTriples.bind(privateStore);
          vi.spyOn(privateStore, 'replaceKnowledgeAssetPrivateTriples')
            .mockImplementationOnce(async (...args) => {
              await replace(...args);
              throw new Error('committed slice failed');
            });
        } else if (slice === 'metadata') {
          const original = s.store.replaceGraphAndSubject.bind(s.store);
          vi.spyOn(s.store, 'replaceGraphAndSubject').mockImplementationOnce(async (...args) => {
            await original(...args);
            throw new Error('committed slice failed');
          });
        } else {
          const original = s.store.insert.bind(s.store);
          let fail = true;
          vi.spyOn(s.store, 'insert').mockImplementation(async rows => {
            await original(rows);
            if (fail && rows.some(row => row.graph === catalog)) {
              fail = false;
              throw new Error('committed slice failed');
            }
          });
        }
        await expect(s.publisher.update(s.reservedKaId, s.options)).rejects.toThrow('committed slice failed');
        expect(await readMaterializedVersion(s.store, s.meta, s.ual)).toEqual(s.prior);
        expect((await s.publisher.update(s.reservedKaId, s.options)).status).toBe('confirmed');
        expect(await readMaterializedVersion(s.store, s.meta, s.ual)).toEqual(s.version);
        const scope = createGraphKnowledgeAssetScope(s.ual, 2);
        const vm = knowledgeAssetLayerGraphUri(CONTEXT_GRAPH_ID, MemoryLayer.VerifiableMemory, scope);
        expect(await s.store.query(`ASK { GRAPH <${vm}> { <${s.options.quads[0].subject}> <http://schema.org/name> "new public" } }`))
          .toMatchObject({ value: true });
        expect(await Reflect.get(s.publisher, 'privateStore').getKnowledgeAssetPrivateTriples(CONTEXT_GRAPH_ID, scope))
          .toEqual(s.options.privateQuads);
        expect(await s.store.countQuads(catalog)).toBe(generatedPrivateCatalogFloorQuads(CONTEXT_GRAPH_ID).length);
        if (slice === 'catalog') {
          const sentinel = { subject: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`,
            predicate: 'urn:catalog-current', object: '"keep"', graph: catalog };
          await s.store.insert([sentinel]);
          vi.mocked(s.chain.updateKnowledgeCollectionV10).mockResolvedValue({
            success: true, hash: `0x${'de'.repeat(32)}`, ...s.prior,
          });
          expect((await s.publisher.update(s.reservedKaId, s.options)).status).toBe('confirmed');
          expect(await s.store.query(`ASK { GRAPH <${catalog}> {
            <${sentinel.subject}> <${sentinel.predicate}> ${sentinel.object} } }`))
            .toMatchObject({ value: true });
          expect(await readMaterializedVersion(s.store, s.meta, s.ual)).toEqual(s.version);
        }
      } finally { await s.store.close(); }
    });

  it('holds the KA lock and previous fence through a catalog commit before admitting an older mint retry', async () => {
    const s = await sealedUpdateFixture();
    s.chain.mintError = kaIdAlreadyMintedRevert(s.reservedKaId);
    s.chain.provenanceResult = await MockChainAdapter.prototype.getMintedKnowledgeAssetProvenance.call(
      s.chain, s.reservedKaId, s.seal.expectedMerkleRoot, BigInt(CONTEXT_GRAPH_ID));
    const catalog = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_catalog`;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = s.store.insert.bind(s.store);
    vi.spyOn(s.store, 'insert').mockImplementation(async rows => {
      if (rows.some(row => row.graph === catalog)) { entered(); await gate; }
      return original(rows);
    });
    const update = s.publisher.update(s.reservedKaId, s.options);
    let retry: Promise<unknown> | undefined;
    try {
      await ready;
      expect(await readMaterializedVersion(s.store, s.meta, s.ual)).toEqual(s.prior);
      let completed = false;
      retry = s.publisher.publish(s.publishOptions).then(result => { completed = true; return result; });
      await vi.waitFor(() => expect(s.chain.provenanceCalls).toHaveLength(1));
      await setImmediate();
      expect(completed).toBe(false);
      release();
      expect((await update).status).toBe('confirmed');
      await retry;
      expect(await readMaterializedVersion(s.store, s.meta, s.ual)).toEqual(s.version);
      const vm = knowledgeAssetLayerGraphUri(CONTEXT_GRAPH_ID, MemoryLayer.VerifiableMemory,
        createGraphKnowledgeAssetScope(s.ual, 2));
      expect(await s.store.query(`ASK { GRAPH <${vm}> { <${s.options.quads[0].subject}> <http://schema.org/name> "new public" } }`))
        .toMatchObject({ value: true });
    } finally { release(); await Promise.allSettled([update, ...(retry ? [retry] : [])]); await s.store.close(); }
  });

  it.each(['allowList', 'ownerOnly'] as const)('converges equal-version adoption metadata and trusted controls after revoking peers to %s', async policy => {
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
      // A peer that synced the original grant can replay these rows through durable sync.
      const meta = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_meta`;
      const snapshot = await s.store.query(`CONSTRUCT { <${s.ual}> ?p ?o } WHERE { GRAPH <${meta}> { <${s.ual}> ?p ?o } }`);
      if (snapshot.type !== 'quads') throw new Error('The original publish must leave visible KA metadata');
      const replayed = snapshot.quads.map(quad => ({ ...quad, graph: meta }));
      s.chain.mintError = kaIdAlreadyMintedRevert(s.reservedKaId);
      s.chain.provenanceResult = await MockChainAdapter.prototype.getMintedKnowledgeAssetProvenance.call(
        s.chain, s.reservedKaId, original.merkleRoot, BigInt(CONTEXT_GRAPH_ID));
      const retry = await s.publisher.publish({ ...s.publishOptions, accessPolicy: policy,
        ...(policy === 'allowList' ? { allowedPeers: ['Alice'] } : {}) });
      expect(retry.status).toBe('confirmed');
      expect(retry.onChainResult?.txHash).toBe(original.onChainResult?.txHash);
      expect(s.chain.provenanceCalls).toHaveLength(1);
      // The trusted sidecar, not the replayed rows, decides the controls durable sync commits.
      const trusted = { accessPolicy: policy, allowedPeers: policy === 'allowList' ? ['Alice'] : [],
        publisherPeerId: 'adoption-publisher' };
      await expect(readLocallyTrustedKnowledgeAssetControlEnvelope(s.store, meta, s.ual, replayed)).resolves.toEqual(trusted);
      const overlaid = await overlayLocallyTrustedKnowledgeAssetControls(s.store, meta, s.ual, replayed);
      const controls = (name: string) => overlaid.filter(quad => quad.predicate === `http://dkg.io/ontology/${name}`)
        .map(quad => quad.object);
      expect(controls('accessPolicy')).toEqual([JSON.stringify(policy)]);
      expect(controls('allowedPeer')).toEqual(trusted.allowedPeers.map(peer => JSON.stringify(peer)));
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

  it('reports the original mint cost after a retry receives a different quote', async () => {
    const s = await setupSealedGraphPublish();
    const quote = vi.fn(async () => 100n);
    Object.assign(s.chain, { getRequiredPublishTokenAmount: quote });
    const messages: string[] = [];
    Logger.setSink(entry => messages.push(entry.message));
    try {
      const original = await s.publisher.publish(s.publishOptions);
      expect(original.onChainResult?.tokenAmount).toBe(100n);
      const provenance = await MockChainAdapter.prototype.getMintedKnowledgeAssetProvenance.call(
        s.chain, s.reservedKaId, original.merkleRoot, BigInt(CONTEXT_GRAPH_ID));
      if (!provenance) throw new Error('Expected the original mint provenance');
      s.chain.provenanceResult = { ...provenance, tokenAmount: original.onChainResult!.tokenAmount! };
      s.chain.mintError = kaIdAlreadyMintedRevert(s.reservedKaId);
      quote.mockResolvedValue(200n);
      messages.length = 0;

      const retry = await s.publisher.publish(s.publishOptions);
      expect(quote).toHaveBeenCalledTimes(2);
      expect(retry.status).toBe('confirmed');
      expect(retry.onChainResult).toMatchObject({ txHash: original.onChainResult!.txHash, tokenAmount: 100n });
      expect(s.chain.createAttempts).toBe(2);
      expect(messages.find(message => message.includes('stage=chain event=confirm'))).toContain('tokenAmount=100');
      expect(messages.find(message => message.includes('stage=chain event=submit'))).toContain('tokenAmount=200');
    } finally { Logger.setSink(null); await s.store.close(); }
  });

  it.each([undefined, -1n, '100'])('keeps the original error when a custom reader supplies an invalid cost (%s)', async cost => {
    const s = await setupSealedGraphPublish();
    try {
      const original = await s.publisher.publish(s.publishOptions);
      s.chain.provenanceResult = await MockChainAdapter.prototype.getMintedKnowledgeAssetProvenance.call(
        s.chain, s.reservedKaId, original.merkleRoot, BigInt(CONTEXT_GRAPH_ID));
      if (!s.chain.provenanceResult) throw new Error('Expected original mint provenance');
      Reflect.set(s.chain.provenanceResult, 'tokenAmount', cost);
      const error = kaIdAlreadyMintedRevert(s.reservedKaId);
      s.chain.mintError = error;
      await expect(s.publisher.publish(s.publishOptions)).rejects.toBe(error);
    } finally { await s.store.close(); }
  });

  it('keeps the submission quote for a fresh mint with a legacy optional-cost result', async () => {
    const s = await setupSealedGraphPublish();
    Object.assign(s.chain, { getRequiredPublishTokenAmount: async () => 200n });
    vi.spyOn(s.chain, 'createKnowledgeAssets').mockImplementation(async params => {
      const result = await MockChainAdapter.prototype.createKnowledgeAssets.call(s.chain, params);
      return { ...result, tokenAmount: undefined };
    });
    try {
      const result = await s.publisher.publish(s.publishOptions);
      expect(result.status).toBe('confirmed');
      expect(result.onChainResult?.tokenAmount).toBe(200n);
      expect(s.chain.provenanceCalls).toHaveLength(0);
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
      tokenAmount: 100n,
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
      const mintProof = await MockChainAdapter.prototype.getMintedKnowledgeAssetProvenance.call(
        s.chain, s.reservedKaId, initial.merkleRoot, BigInt(CONTEXT_GRAPH_ID));
      if (!mintProof) throw new Error('Expected original mint provenance');
      vi.spyOn(s.chain, 'getMintedKnowledgeAssetProvenance').mockImplementation(async () => {
        entered();
        await held;
        return mintProof;
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
        precomputedUpdateAttestation: updateSeal,
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
        createOperationContext('publish'), new Logger('test'))).rejects.toBe(original);
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

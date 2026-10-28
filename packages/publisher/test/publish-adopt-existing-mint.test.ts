import { withAssertionLifecycleWriteLease, assertionLifecycleWriteLockKey } from '../src/store-write-locks.js';
// SPDX-License-Identifier: Apache-2.0

/**
 * A sealed named-asset publish whose transaction mined after the node stopped
 * waiting for it. The retry reverts `KaIdAlreadyMinted` (the seal pins the
 * reserved id), and the synchronous shared-memory publish path either adopts
 * that mint or refuses with a typed error. Reconcile records the mint without
 * sending anything. Backed by an in-memory store and the mock chain, whose
 * re-mint guard and mint lookup mirror the contract and the EVM adapter.
 */
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  kaIdAlreadyMintedFromError,
  kaIdAlreadyMintedRevert,
  type ChainAdapter,
  type KnowledgeAssetMintEvidence,
  type KnowledgeAssetMintLookupOptions,
  type KnowledgeAssetMintResolution,
  type OnChainPublishResult,
  type PublisherPublishPlanRequest,
  type V10PublishParams,
} from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  createGraphKnowledgeAssetScope,
  generateEd25519Keypair,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';
import {
  MintAdoptionRefusedError,
  adoptExistingMint,
  generateGraphKnowledgeAssetMetadata,
  generatedPrivateCatalogTripleKeys,
  mintOrAdoptKnowledgeAssets,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
} from '../src/index.js';
import { sealedMintAdoption, type SealedMintAdoption, prepareMintAdoption, withPreparedMintAdoption, adoptMintForRecording } from '../src/adopt-existing-mint.js';
import { PublisherPlanner } from '../src/publisher-planning.js';
import { buildSeal, mockSealCtx } from './_helpers/seal.js';
import { mockChainStubACKProvider } from './_helpers/acks.js';

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const CONTEXT_GRAPH = '1';
const DKG = 'http://dkg.io/ontology/';
const LOT: Quad = { subject: 'urn:lot:2026-08-12', predicate: 'http://schema.org/name', object: '"Lot 12"', graph: '' };

/** The mock chain plus the two things a stranded publish needs: a lost receipt and a hidden one. */
class LateMintChain extends MockChainAdapter {
  loseNextReceipt = false;
  hideMintReceipt = false;
  hideVersionView = false;
  createCalls = 0;
  broadcasts = 0;
  planCalls = 0;
  /** Each attempt quotes a different price, so an adopted cost is visibly the original's. */
  nextQuote = 100n;
  readonly mintTxHashes: string[] = [];

  constructor(private readonly wallet: ethers.Wallet) {
    super('mock:31337', wallet.address);
    this.seedIdentity(wallet.address, 1n);
    this.minimumRequiredSignatures = 1;
  }

  override async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const signature = ethers.Signature.from(await this.wallet.signMessage(messageHash));
    return { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) };
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.wallet.signTypedData(domain, types, value);
  }

  async getContextGraphAccessPolicy(): Promise<number> {
    return 1;
  }

  async resolvePublisherPublishPlan(request: PublisherPublishPlanRequest) {
    this.planCalls += 1;
    return {
      publisherAddress: this.wallet.address,
      publishEpochs: request.explicitPublishEpochs ?? request.defaultPublishEpochs,
      tokenAmount: this.nextQuote++,
    };
  }

  override async createKnowledgeAssets(params: V10PublishParams): Promise<OnChainPublishResult> {
    this.createCalls += 1;
    const result = await super.createKnowledgeAssets({
      ...params,
      onBroadcast: async (signal) => {
        this.broadcasts += 1;
        await params.onBroadcast?.(signal);
      },
    });
    this.mintTxHashes.push(result.txHash);
    if (this.loseNextReceipt) {
      this.loseNextReceipt = false;
      throw Object.assign(
        new Error(`V10 publish tx ${result.txHash} timed out waiting for a receipt after 600000ms`),
        { code: 'RPC_TIMEOUT' },
      );
    }
    return result;
  }

  override async resolveKnowledgeAssetMint(
    kaId: bigint,
    options?: KnowledgeAssetMintLookupOptions,
  ): Promise<KnowledgeAssetMintResolution> {
    return this.hideMintReceipt ? { status: 'not-found' } : super.resolveKnowledgeAssetMint(kaId, options);
  }

  override async readKnowledgeAssetVersionSnapshot(kaId: bigint) {
    return this.hideVersionView ? null : super.readKnowledgeAssetVersionSnapshot(kaId);
  }
}

async function strandedPublishFixture() {
  const wallet = new ethers.Wallet(TEST_KEY);
  const chain = new LateMintChain(wallet);
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    publisherNodeIdentityId: 1n,
  });
  const seal = await buildSeal({ quads: [LOT], author: wallet, contextGraphId: CONTEXT_GRAPH, ctx: mockSealCtx() });
  const kaId = seal.reservedKaId!;
  const kaNumber = kaId & ((1n << 96n) - 1n);
  const scope = createGraphKnowledgeAssetScope(`did:dkg:31337/${wallet.address}/${kaNumber}`, 1);
  const ual = scope.ual;
  const swmGraph = knowledgeAssetLayerGraphUri(CONTEXT_GRAPH, MemoryLayer.SharedWorkingMemory, scope);
  const vmGraph = knowledgeAssetLayerGraphUri(CONTEXT_GRAPH, MemoryLayer.VerifiableMemory, scope);
  await store.insert([{ ...LOT, graph: swmGraph }]);
  const acks = vi.fn(mockChainStubACKProvider());
  const encrypt = vi.fn(async (plaintext: Uint8Array) => plaintext);

  const publish = (adoptExistingMint?: { txHash?: string }) => publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all', {
    onChainContextGraphId: CONTEXT_GRAPH,
    sharedMemoryScope: { kind: 'named-lifecycle', identity: { agentAddress: wallet.address, kaNumber } },
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: ual,
    assertionVersion: 1,
    publicTripleCount: 1,
    privateTripleCount: 0,
    trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CONTEXT_GRAPH),
    publisherPeerId: 'late-mint-publisher-peer',
    precomputedAttestation: seal,
    encryptInlinePayload: encrypt,
    v10ACKProvider: acks,
    ...(adoptExistingMint ? { adoptExistingMint } : {}),
  });

  /** The node gave up on the first attempt's receipt, which then mined. */
  const strand = async () => {
    chain.loseNextReceipt = true;
    await expect(publish()).rejects.toThrow(/timed out waiting for a receipt/);
    const original = chain.getCollection(kaId);
    expect(original).toBeDefined();
    chain.createCalls = 0;
    chain.broadcasts = 0;
    chain.planCalls = 0;
    acks.mockClear();
    encrypt.mockClear();
    return { txHash: chain.mintTxHashes.at(-1)!, tokenAmount: 100n };
  };

  /** A mint of the same reserved id that this seal did not produce. */
  const mintForeign = async (overrides: Partial<V10PublishParams>) => {
    await MockChainAdapter.prototype.createKnowledgeAssets.call(chain, {
      publishOperationId: 'foreign',
      contextGraphId: BigInt(CONTEXT_GRAPH),
      publisherAddress: wallet.address,
      reservedKaId: kaId,
      merkleRoot: seal.expectedMerkleRoot,
      knowledgeAssetsAmount: 1,
      byteSize: 1n,
      epochs: 1,
      tokenAmount: 7n,
      isImmutable: false,
      author: { address: wallet.address, signature: { r: new Uint8Array(32), vs: new Uint8Array(32) }, schemeVersion: 1 },
      ackSignatures: [{ identityId: 1n, r: new Uint8Array(32), vs: new Uint8Array(32) }],
      ...overrides,
    });
  };

  const graphSize = async (graph: string) => {
    const result = await store.query(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
    return result.type === 'bindings' ? Number(String(result.bindings[0]?.['n']).replace(/^"(\d+)".*$/, '$1')) : -1;
  };
  /** How many values each metadata predicate of the asset's UAL holds. */
  const metadataValueCounts = async () => {
    const result = await store.query(
      `SELECT ?p (COUNT(?o) AS ?n) WHERE { GRAPH <did:dkg:context-graph:${CONTEXT_GRAPH}/_meta> { <${ual}> ?p ?o } } GROUP BY ?p`,
    );
    return result.type === 'bindings'
      ? Object.fromEntries(result.bindings.map((row) => [
        String(row['p']).replace(DKG, 'dkg:'), Number(String(row['n']).replace(/^"(\d+)".*$/, '$1')),
      ]))
      : {};
  };
  /** The confirmed record a node's chain reconcile writes for a mint it observed, as a receiver would. */
  const reconcileMaterialized = async (merkleRoot: Uint8Array = seal.expectedMerkleRoot) => {
    await store.insert([
      ...generateGraphKnowledgeAssetMetadata({
        ual, contextGraphId: CONTEXT_GRAPH, merkleRoot, publisherPeerId: 'chain-reconcile', accessPolicy: 'public',
        allowedPeers: [], timestamp: new Date(0), assertionVersion: 1, authorAddress: wallet.address,
        publicTripleCount: 1, privateTripleCount: 0, assertionGraph: vmGraph,
      }, { status: 'confirmed', confirmation: {
        kind: 'finalized-materialization', provenance: { batchId: kaId, materializedVersion: { blockNumber: 1, txIndex: 0 } },
      } }),
      { ...LOT, graph: vmGraph },
    ]);
  };
  const recordedTxHashes = async () => {
    const result = await store.query(
      `SELECT ?tx WHERE { GRAPH ?g { <${ual}> <${DKG}transactionHash> ?tx } }`,
    );
    return result.type === 'bindings' ? result.bindings.map((row) => String(row['tx']).replace(/^"|"$/g, '')) : [];
  };

  return {
    chain, store, publisher, publish, strand, mintForeign, reconcileMaterialized, kaId, ual, swmGraph, vmGraph, acks, encrypt,
    graphSize, recordedTxHashes, metadataValueCounts, sealedRoot: seal.expectedMerkleRoot,
  };
}

async function expectNothingRecorded(fixture: Awaited<ReturnType<typeof strandedPublishFixture>>) {
  expect(await fixture.graphSize(fixture.vmGraph)).toBe(0);
  expect(await fixture.graphSize(fixture.swmGraph)).toBe(1);
  expect(await fixture.recordedTxHashes()).toEqual([]);
}

describe('a sealed publish whose transaction mined after the node stopped waiting', () => {
  it('adopts the matching late mint on the vm/publish retry and keeps the original transaction and cost', async () => {
    const fixture = await strandedPublishFixture();
    const original = await fixture.strand();
    await expectNothingRecorded(fixture);

    const result = await fixture.publish();

    expect(result.status).toBe('confirmed');
    expect(result.ual).toBe(fixture.ual);
    expect(result.onChainResult).toMatchObject({
      kaId: fixture.kaId,
      txHash: original.txHash,
      tokenAmount: original.tokenAmount,
    });
    // The retry reverted at the re-mint guard before broadcasting anything.
    expect(fixture.chain.createCalls).toBe(1);
    expect(fixture.chain.broadcasts).toBe(0);
    expect(await fixture.graphSize(fixture.vmGraph)).toBe(1);
    expect(await fixture.graphSize(fixture.swmGraph)).toBe(0);
    expect(await fixture.recordedTxHashes()).toEqual([original.txHash]);
  });

  it('refuses when the reserved id was minted with a different root', async () => {
    const fixture = await strandedPublishFixture();
    await fixture.mintForeign({ merkleRoot: ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('other content'))) });

    const refusal = await fixture.publish().catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(MintAdoptionRefusedError);
    expect(refusal).toMatchObject({ code: 'KA_MINT_ADOPTION_REFUSED', reason: 'root-mismatch', retryable: false, kaId: fixture.kaId });
    expect(kaIdAlreadyMintedFromError((refusal as Error).cause)).toBe(fixture.kaId);
    await expectNothingRecorded(fixture);
  });

  it('refuses when the reserved id is minted but no receipt evidence can be recovered', async () => {
    const fixture = await strandedPublishFixture();
    await fixture.strand();
    fixture.chain.hideMintReceipt = true;

    const refusal = await fixture.publish().catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(MintAdoptionRefusedError);
    expect(refusal).toMatchObject({ reason: 'mint-receipt-missing', retryable: true, kaId: fixture.kaId });
    expect(kaIdAlreadyMintedFromError((refusal as Error).cause)).toBe(fixture.kaId);
    await expectNothingRecorded(fixture);
  });

  it('refuses a mint of the reserved id into another context graph', async () => {
    const fixture = await strandedPublishFixture();
    await fixture.mintForeign({ contextGraphId: 2n });

    await expect(fixture.publish()).rejects.toMatchObject({ reason: 'context-graph-mismatch' });
    await expectNothingRecorded(fixture);
  });

  it('refuses while the mint has not reached the finality depth, then adopts it', async () => {
    const fixture = await strandedPublishFixture();
    const original = await fixture.strand();
    fixture.chain.__setTransactionUnfinalized(original.txHash);

    await expect(fixture.publish()).rejects.toMatchObject({ reason: 'mint-not-final', retryable: true });
    await expectNothingRecorded(fixture);

    fixture.chain.__setTransactionUnfinalized(original.txHash, false);
    await expect(fixture.publish()).resolves.toMatchObject({ status: 'confirmed' });
  });

  it('reconcile records the late mint without a funding plan, ACK round, member ciphertext or transaction', async () => {
    const fixture = await strandedPublishFixture();
    const original = await fixture.strand();

    const result = await fixture.publish({});

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toMatchObject({ txHash: original.txHash, tokenAmount: original.tokenAmount });
    expect(fixture.chain.createCalls).toBe(0);
    expect(fixture.chain.planCalls).toBe(0);
    expect(fixture.acks).not.toHaveBeenCalled();
    expect(fixture.encrypt).not.toHaveBeenCalled();
    expect(await fixture.graphSize(fixture.vmGraph)).toBe(1);
    expect(await fixture.recordedTxHashes()).toEqual([original.txHash]);
  });

  it('records over what a failed run left without adding a second set of metadata', async () => {
    const fixture = await strandedPublishFixture();
    const original = await fixture.strand();
    // As on terminus: the run recorded VM content and metadata, then failed in the shared-memory cleanup.
    const cleanup = vi.spyOn(fixture.publisher, 'clearPublishedKnowledgeAssetSwm')
      .mockRejectedValueOnce(new Error('Triple-store response exceeds byte limit: found 8396603, limit 8388608'));
    await expect(fixture.publish({})).rejects.toThrow(/exceeds byte limit/);
    expect(await fixture.recordedTxHashes()).toEqual([original.txHash]);
    const recorded = await fixture.metadataValueCounts();
    cleanup.mockRestore();

    await expect(fixture.publish({})).resolves.toMatchObject({ status: 'confirmed', onChainResult: { txHash: original.txHash } });

    expect(await fixture.metadataValueCounts()).toEqual(recorded);
    expect(recorded).toMatchObject({ 'dkg:publishedAt': 1, 'dkg:status': 1, 'dkg:transactionHash': 1, 'dkg:confirmationKind': 1 });
    expect(await readConfirmedGraphKnowledgeAssetMetadataEnvelope(fixture.store, { contextGraphId: CONTEXT_GRAPH, ual: fixture.ual }))
      .toMatchObject({ state: 'confirmed', envelope: { transactionHash: original.txHash } });
    expect(await fixture.graphSize(fixture.swmGraph)).toBe(0);
  });

  it('keeps the record chain reconcile materialized for the late mint', async () => {
    const fixture = await strandedPublishFixture();
    const original = await fixture.strand();
    await fixture.reconcileMaterialized();
    const materialized = await fixture.metadataValueCounts();

    await expect(fixture.publish({})).resolves.toMatchObject({ status: 'confirmed', onChainResult: { txHash: original.txHash } });

    expect(await fixture.metadataValueCounts()).toEqual(materialized);
    expect(await readConfirmedGraphKnowledgeAssetMetadataEnvelope(fixture.store, { contextGraphId: CONTEXT_GRAPH, ual: fixture.ual }))
      .toMatchObject({ state: 'confirmed' });
    expect(await fixture.graphSize(fixture.vmGraph)).toBe(1);
  });

  it('refuses before writing when the existing record describes other content', async () => {
    const fixture = await strandedPublishFixture();
    await fixture.strand();
    await fixture.reconcileMaterialized(ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('other content'))));
    await fixture.store.deleteByPattern({ graph: fixture.vmGraph });
    const before = await fixture.metadataValueCounts();

    await expect(fixture.publish({})).rejects.toMatchObject({ reason: 'existing-record-conflict', retryable: false });

    expect(await fixture.metadataValueCounts()).toEqual(before);
    expect(await fixture.graphSize(fixture.vmGraph)).toBe(0);
    expect(await fixture.graphSize(fixture.swmGraph)).toBe(1);
  });

  it.each([
    ['to other content', ['updated content']],
    // The latest root equals the seal again, so only the version count shows the mint is not current.
    ['to other content and back (A → B → A)', ['updated content', 'sealed']],
  ] as const)('refuses a late mint that later updates superseded %s, on retry and reconcile alike', async (_case, history) => {
    const fixture = await strandedPublishFixture();
    await fixture.strand();
    // While this node was away, the author updated the asset through another node.
    for (const content of history) {
      const update = await fixture.chain.updateKnowledgeCollectionV10({
        kaId: fixture.kaId,
        newMerkleRoot: content === 'sealed' ? fixture.sealedRoot : ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(content))),
        newByteSize: 1n,
        newMerkleLeafCount: 1,
        authorAddress: ethers.ZeroAddress,
        authorR: new Uint8Array(32),
        authorVS: new Uint8Array(32),
      });
      expect(update.success).toBe(true);
    }

    for (const adoptExistingMint of [undefined, {}]) {
      await expect(fixture.publish(adoptExistingMint)).rejects.toMatchObject({ reason: 'superseded', retryable: false });
      await expectNothingRecorded(fixture);
    }
  });

  it('waits for a current-version view that shows the mint before adopting it', async () => {
    const fixture = await strandedPublishFixture();
    const original = await fixture.strand();
    fixture.chain.hideVersionView = true;

    await expect(fixture.publish({})).rejects.toMatchObject({ reason: 'version-view-unavailable', retryable: true });
    await expectNothingRecorded(fixture);

    fixture.chain.hideVersionView = false;
    await expect(fixture.publish({})).resolves.toMatchObject({ status: 'confirmed', onChainResult: { txHash: original.txHash } });
  });

  it('reconcile of an unminted reservation refuses as not minted and sends nothing', async () => {
    const fixture = await strandedPublishFixture();

    await expect(fixture.publish({})).rejects.toMatchObject({ reason: 'not-minted', retryable: false });
    expect(fixture.chain.createCalls).toBe(0);
    expect(fixture.acks).not.toHaveBeenCalled();
    await expectNothingRecorded(fixture);
  });
});

describe('adoption refuses what the chain cannot prove', () => {
  const author = ethers.getAddress(`0x${'ab'.repeat(20)}`);
  const kaId = (BigInt(author) << 96n) | 7n;
  const merkleRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('sealed content')));
  const expected = { kaId, merkleRoot, contextGraphId: 1n, authorAddress: author };
  const mint = (overrides: Partial<KnowledgeAssetMintEvidence> = {}): KnowledgeAssetMintEvidence => ({
    kaId, merkleRoot, contextGraphId: 1n, authorAddress: author, publisherAddress: author, tokenAmount: 5n,
    knowledgeAssetsContract: ethers.getAddress(`0x${'11'.repeat(20)}`), txHash: `0x${'aa'.repeat(32)}`,
    blockNumber: 100, blockHash: `0x${'bb'.repeat(32)}`, txIndex: 0, blockTimestamp: 0, ...overrides,
  });
  const chainAnswering = (resolution: KnowledgeAssetMintResolution) => ({
    resolveKnowledgeAssetMint: async () => resolution,
    readKnowledgeAssetVersionSnapshot: async () => null,
  }) as unknown as ChainAdapter;

  it('refuses on an adapter that cannot look up mints and current versions', async () => {
    await expect(adoptExistingMint({} as ChainAdapter, expected))
      .rejects.toMatchObject({ reason: 'lookup-unsupported', retryable: false });
  });

  it.each([
    ['a rejected receipt', { status: 'rejected', reason: 'transaction 0xaa reverted' }, 'mint-receipt-invalid'],
    ['a receipt for another id', { status: 'confirmed', mint: mint({ kaId: kaId + 1n }) }, 'mint-receipt-invalid'],
    ['another author', { status: 'confirmed', mint: mint({ authorAddress: ethers.getAddress(`0x${'cd'.repeat(20)}`) }) }, 'author-mismatch'],
  ] as const)('refuses %s', async (_case, resolution, reason) => {
    await expect(adoptExistingMint(chainAnswering(resolution as KnowledgeAssetMintResolution), expected))
      .rejects.toMatchObject({ reason, retryable: false });
  });

  it('refuses a KaIdAlreadyMinted revert that names another id than the reservation', async () => {
    const chain = { createKnowledgeAssets: async () => { throw kaIdAlreadyMintedRevert(kaId + 1n); } } as unknown as ChainAdapter;
    const params = { reservedKaId: kaId, merkleRoot, contextGraphId: 1n, author: { address: author } } as unknown as V10PublishParams;

    const refusal = await mintOrAdoptKnowledgeAssets(chain, params, {} as SealedMintAdoption).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: 'reserved-id-mismatch', retryable: false, kaId });
    expect(kaIdAlreadyMintedFromError((refusal as Error).cause)).toBe(kaId + 1n);
  });

  it('does not create an adoption context for an unsealed publish', async () => {
    const store = new OxigraphStore();
    expect(sealedMintAdoption(store, undefined, { contextGraphId: CONTEXT_GRAPH, log: () => {} })).toBeUndefined();
    await store.close();
  });

  it('admits receipt adoption only for an on-chain context graph on a V10-ready chain', async () => {
    const planner = new PublisherPlanner({
      chain: { chainId: 'none' } as ChainAdapter,
      resolvePublisherAddressSelection: vi.fn(),
      resolvePublisherSigner: vi.fn(),
      localTentativePublisherAddress: () => author,
      log: { info: () => {}, warn: () => {} },
    });

    await expect(planner.requireMintAdoptionTarget(1n)).rejects.toThrow(/on-chain context graph id and a V10-ready chain/);
    await expect(planner.requireMintAdoptionTarget(undefined)).rejects.toThrow(/on-chain context graph id and a V10-ready chain/);
  });
});

it('prepared receipt evidence is adapter/reservation-bound and avoids a second slow lookup', async () => {
  const f = await strandedPublishFixture();
  try {
    const original = await f.strand();
    const scope = createGraphKnowledgeAssetScope(f.ual, 1);
    const expected = { kaId: f.kaId, merkleRoot: f.sealedRoot, contextGraphId: 1n, authorAddress: scope.agentAddress };
    const lookup = vi.spyOn(f.chain, 'resolveKnowledgeAssetMint');
    const evidence = await prepareMintAdoption(f.chain, expected, original.txHash);
    const options = withPreparedMintAdoption({}, evidence);
    const sealed = sealedMintAdoption(f.store, { scope, publicTripleCount: 1, privateTripleCount: 0 },
      { contextGraphId: CONTEXT_GRAPH, log() {} })!;
    await expect(adoptMintForRecording(f.chain, expected, sealed, original.txHash, options))
      .resolves.toMatchObject({ result: { txHash: original.txHash }, recording: { adopted: true } });
    expect(lookup).toHaveBeenCalledOnce();
    await expect(adoptMintForRecording(f.chain, { ...expected, kaId: f.kaId + 1n }, sealed, original.txHash, options))
      .rejects.toThrow(/does not match/);
    await expect(adoptMintForRecording(new MockChainAdapter(), expected, sealed, original.txHash, options))
      .rejects.toThrow(/does not match/);
    expect(() => withPreparedMintAdoption({}, {} as never)).toThrow(/Invalid prepared mint evidence/);
    expect(lookup).toHaveBeenCalledOnce();
  } finally { await f.store.close(); }
});

it('nested share cleanup requires the current lease for its exact lifecycle and store', async () => {
  const f = await strandedPublishFixture();
  const author = createGraphKnowledgeAssetScope(f.ual, 1).agentAddress;
  const key = assertionLifecycleWriteLockKey(CONTEXT_GRAPH, 'lease-asset', author);
  let expired: Parameters<typeof f.publisher.clearSwmShareComplete>[4];
  try {
    await withAssertionLifecycleWriteLease(f.publisher.writeLocks, key, async lease => {
      expired = lease;
      await expect(f.publisher.clearSwmShareComplete(CONTEXT_GRAPH, 'lease-asset', author, undefined, lease)).resolves.toBeUndefined();
      await expect(f.publisher.clearSwmShareComplete(CONTEXT_GRAPH, 'other-asset', author, undefined, lease))
        .rejects.toThrow(/lease is not current/);
    });
    await expect(f.publisher.clearSwmShareComplete(CONTEXT_GRAPH, 'lease-asset', author, undefined, expired))
      .rejects.toThrow(/lease is not current/);
  } finally { await f.store.close(); }
});

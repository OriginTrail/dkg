import * as adoptedRecord from '../src/adopted-mint-record.js';
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
  withMaterializationLock,
  writeMaterializedVersion,
  computeFlatKCRootV10,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
} from '../src/index.js';
import { prepareMintAdoption, adoptMintForRecording } from '../src/adopt-existing-mint.js';
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

  const publishOptions = {
    onChainContextGraphId: CONTEXT_GRAPH,
    sharedMemoryScope: { kind: 'named-lifecycle' as const, identity: { agentAddress: wallet.address, kaNumber } },
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: ual,
    assertionVersion: 1,
    publicTripleCount: 1,
    privateTripleCount: 0,
    trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CONTEXT_GRAPH),
    publisherPeerId: 'late-mint-publisher-peer',
    precomputedAttestation: seal,
    reservedKaId: kaId,
    encryptInlinePayload: encrypt,
    v10ACKProvider: acks,
  };
  const publish = (request?: { txHash?: string }, onPublishConfirmed?: (input: { txHash: string }) => void | Promise<void>) => request === undefined
    ? publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all', { ...publishOptions, onPublishConfirmed })
    : publisher.recordExistingMintFromSharedMemory(CONTEXT_GRAPH, 'all', request, { ...publishOptions, onPublishConfirmed });

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
    chain, store, publisher, publish, publishOptions, seal, strand, mintForeign, reconcileMaterialized, kaId, ual, swmGraph, vmGraph, acks, encrypt,
    graphSize, recordedTxHashes, metadataValueCounts, sealedRoot: seal.expectedMerkleRoot,
  };
}

async function expectNothingRecorded(fixture: Awaited<ReturnType<typeof strandedPublishFixture>>) {
  expect(await fixture.graphSize(fixture.vmGraph)).toBe(0);
  expect(await fixture.graphSize(fixture.swmGraph)).toBe(1);
  expect(await fixture.recordedTxHashes()).toEqual([]);
}

describe('a sealed publish whose transaction mined after the node stopped waiting', () => {
  it.each(['1', ' 1 ', '+1', '0x1'])('keeps graph ID %j consistent through planning, ACKs and submission', async (representation) => {
    const fixture = await strandedPublishFixture();
    const planning = vi.spyOn(fixture.chain, 'resolvePublisherPublishPlan');
    const submission = vi.spyOn(fixture.chain, 'createKnowledgeAssets');
    const result = await fixture.publisher.publish({ contextGraphId: CONTEXT_GRAPH, quads: [LOT],
      onChainContextGraphId: representation, precomputedAttestation: fixture.seal,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION, kaUal: fixture.ual,
      assertionVersion: 1, publicTripleCount: 1, privateTripleCount: 0, v10ACKProvider: fixture.acks });
    expect(result.status).toBe('confirmed');
    expect(planning).toHaveBeenCalled();
    expect(planning.mock.calls[0]![0].contextGraphId).toBe(1n);
    expect(fixture.acks).toHaveBeenCalledOnce();
    expect(BigInt(fixture.acks.mock.calls[0]![0].contextGraphId)).toBe(1n);
    expect(submission).toHaveBeenCalledOnce();
    expect(submission.mock.calls[0]![0].contextGraphId).toBe(1n);
  });

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

    const refusal = await mintOrAdoptKnowledgeAssets(chain, params, true).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: 'reserved-id-mismatch', retryable: false, kaId });
    expect(kaIdAlreadyMintedFromError((refusal as Error).cause)).toBe(kaId + 1n);
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
    const request = { kind: 'prepared' as const, evidence };
    await expect(adoptMintForRecording(f.chain, expected, request))
      .resolves.toMatchObject({ result: { txHash: original.txHash }, adopted: true });
    expect(lookup).toHaveBeenCalledOnce();
    await expect(adoptMintForRecording(f.chain, { ...expected, kaId: f.kaId + 1n }, request))
      .rejects.toThrow(/does not match/);
    await expect(adoptMintForRecording(new MockChainAdapter(), expected, request))
      .rejects.toThrow(/does not match/);
    await expect(adoptMintForRecording(f.chain, expected, { kind: 'prepared', evidence: {} as never })).rejects.toThrow(/does not match/);
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


it.each(['superseded', 'reorged'] as const)('revalidates prepared mint evidence after it becomes %s', async stale => {
  const f = await strandedPublishFixture();
  try {
    const original = await f.strand();
    const scope = createGraphKnowledgeAssetScope(f.ual, 1);
    const expected = { kaId: f.kaId, merkleRoot: f.sealedRoot, contextGraphId: 1n, authorAddress: scope.agentAddress };
    const lookup = vi.spyOn(f.chain, 'resolveKnowledgeAssetMint');
    const evidence = await prepareMintAdoption(f.chain, expected, original.txHash);
    if (stale === 'superseded') {
      await f.chain.updateKnowledgeCollectionV10({ kaId: f.kaId, newMerkleRoot: new Uint8Array(32).fill(9),
        newByteSize: 1n, newMerkleLeafCount: 1, authorAddress: ethers.ZeroAddress,
        authorR: new Uint8Array(32), authorVS: new Uint8Array(32) });
    } else vi.spyOn(f.chain, 'isReceiptBlockFinalAndCanonical').mockResolvedValue(false);
    await expect(adoptMintForRecording(f.chain, expected, { kind: 'prepared', evidence }))
      .rejects.toMatchObject({ reason: stale === 'superseded' ? 'superseded' : 'mint-not-final' });
    expect(lookup).toHaveBeenCalledOnce();
    await expectNothingRecorded(f);
  } finally { await f.store.close(); }
});


it.each(['unresolved-graph', 'non-v10-adapter'] as const)('balances local publication chain callbacks for %s', async kind => {
  const store = new OxigraphStore(), chain = new MockChainAdapter();
  if (kind === 'non-v10-adapter') vi.spyOn(chain, 'isV10Ready').mockReturnValue(false);
  const create = vi.spyOn(chain, 'createKnowledgeAssets');
  const phases: [string, string][] = [];
  const publisher = new DKGPublisher({ store, chain, eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
  try {
    const result = await publisher.publish({ contextGraphId: kind === 'unresolved-graph' ? 'local-graph' : '1',
      quads: [LOT], onPhase: (phase, state) => { phases.push([phase, state]); } });
    expect(result.status).toBe('tentative'); expect(result.onChainResult).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(phases.filter(([phase]) => phase === 'chain')).toEqual([['chain', 'start'], ['chain', 'end']]);
    expect((await store.listGraphs()).length).toBeGreaterThan(0);
  } finally { await store.close(); }
});


function newerMaterialization(f: Awaited<ReturnType<typeof strandedPublishFixture>>) {
  const metaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
  const quad = { ...LOT, object: '"Version two"', graph: f.vmGraph };
  const root = computeFlatKCRootV10([{ ...quad, graph: '' }], []);
  const metadata = generateGraphKnowledgeAssetMetadata({
    ual: f.ual, contextGraphId: CONTEXT_GRAPH, merkleRoot: root,
    publisherPeerId: 'chain-reconcile-v2', accessPolicy: 'public', allowedPeers: [], timestamp: new Date(0),
    assertionVersion: 2, authorAddress: createGraphKnowledgeAssetScope(f.ual, 2).agentAddress,
    publicTripleCount: 1, privateTripleCount: 0, assertionGraph: f.vmGraph,
  }, { status: 'confirmed', confirmation: { kind: 'finalized-materialization',
    provenance: { batchId: f.kaId, materializedVersion: { blockNumber: 200, txIndex: 0 } } } });
  const write = async () => {
    await f.store.deleteByPattern({ graph: f.vmGraph });
    await f.store.deleteByPattern({ graph: metaGraph, subject: f.ual });
    await f.store.insert([quad, ...metadata]);
    await writeMaterializedVersion(f.store, metaGraph, f.ual, { blockNumber: 200, txIndex: 0 });
  };
  return { metaGraph, quad, root, write };
}

it('serializes adoption record checking and writes with a competing newer materializer', async () => {
  const f = await strandedPublishFixture();
  await f.strand();
  const newer = newerMaterialization(f);
  let entered!: () => void, resume!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const continued = new Promise<void>(resolve => { resume = resolve; });
  const check = adoptedRecord.classifyMintRecord;
  const spy = vi.spyOn(adoptedRecord, 'classifyMintRecord').mockImplementation(async (...args) => {
    const accepted = await check(...args); entered(); await continued; return accepted;
  });
  const adoption = f.publish({});
  let update: Promise<void> | undefined;
  try {
    await Promise.race([checking, adoption.then(() => { throw new Error('adoption bypassed its record check'); })]);
    let materializerEntered = false;
    update = withMaterializationLock(newer.metaGraph, f.ual, async () => { materializerEntered = true; await newer.write(); });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(materializerEntered, 'the competing materializer must wait for the complete adoption write').toBe(false);
    resume();
    await expect(adoption).resolves.toMatchObject({ status: 'confirmed' });
    await update;
    expect(await readConfirmedGraphKnowledgeAssetMetadataEnvelope(f.store, { contextGraphId: CONTEXT_GRAPH, ual: f.ual }))
      .toMatchObject({ state: 'confirmed', envelope: { assertionVersion: '2', merkleRoot: newer.root } });
    const data = await f.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${f.vmGraph}> { ?s ?p ?o } }`);
    expect(data.type === 'quads' && data.quads.map(q => q.object)).toEqual(['"Version two"']);
  } finally { resume(); await Promise.allSettled([adoption, ...(update ? [update] : [])]); spy.mockRestore(); await f.store.close(); }
});

it('refuses adopted-mint writes when a newer version already owns the materialized record', async () => {
  const f = await strandedPublishFixture();
  try {
    await f.strand();
    const newer = newerMaterialization(f);
    await withMaterializationLock(newer.metaGraph, f.ual, newer.write);
    await expect(f.publish({})).rejects.toMatchObject({ reason: 'existing-record-conflict' });
    expect(await readConfirmedGraphKnowledgeAssetMetadataEnvelope(f.store, { contextGraphId: CONTEXT_GRAPH, ual: f.ual }))
      .toMatchObject({ state: 'confirmed', envelope: { assertionVersion: '2', merkleRoot: newer.root } });
    const data = await f.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${f.vmGraph}> { ?s ?p ?o } }`);
    expect(data.type === 'quads' && data.quads.map(q => q.object)).toEqual(['"Version two"']);
  } finally { await f.store.close(); }
});


it('keeps the adopted mint metadata when the delayed original publish receives its receipt', async () => {
  const f = await strandedPublishFixture();
  let entered!: () => void; let release!: () => void;
  const mined = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const create = f.chain.createKnowledgeAssets.bind(f.chain);
  vi.spyOn(f.chain, 'createKnowledgeAssets').mockImplementationOnce(async params => {
    const result = await create(params); entered(); await held; return result;
  });
  const original = f.publish();
  try {
    await mined;
    const adopted = await f.publish({});
    expect(adopted.status).toBe('confirmed');
    const before = await f.metadataValueCounts();
    expect(before).toMatchObject({ 'dkg:publishedAt': 1, 'dkg:status': 1, 'dkg:transactionHash': 1, 'dkg:confirmationKind': 1 });
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    await expect(original).resolves.toMatchObject({ status: 'confirmed', onChainResult: { txHash: adopted.onChainResult!.txHash } });
    expect(await f.metadataValueCounts()).toEqual(before);
    expect(await f.graphSize(f.vmGraph)).toBe(1);
  } finally { release(); await original; }
});


it.each(['reservation', 'attestation', 'private-count'] as const)('rejects an untyped recording without its required %s before chain lookup', async missing => {
  const f = await strandedPublishFixture();
  try {
    const lookup = vi.spyOn(f.chain, 'resolveKnowledgeAssetMint');
    const options = { contextGraphId: CONTEXT_GRAPH, quads: [LOT], contentScopeVersion: 2 as const,
      kaUal: f.ual, assertionVersion: 1, publicTripleCount: 1, privateTripleCount: 0,
      reservedKaId: f.kaId, precomputedAttestation: f.seal };
    const malformed = { ...options, ...(missing === 'reservation' ? { reservedKaId: undefined }
      : missing === 'attestation' ? { precomputedAttestation: undefined } : { privateTripleCount: undefined }) };
    await expect(f.publisher.recordExistingMint(malformed as unknown as Parameters<DKGPublisher['recordExistingMint']>[0], {}))
      .rejects.toThrow('complete sealed graph reservation');
    expect(lookup).not.toHaveBeenCalled();
    expect(f.chain.createCalls).toBe(0);
    expect(f.chain.planCalls).toBe(0);
    await expectNothingRecorded(f);
  } finally { await f.store.close(); }
});


for (const lane of ['live', 'record-only'] as const) {
  it.each(['lock', 'blocked-read', 'failed-read'] as const)(`${lane} confirms exactly once before local %s`, async blocked => {
    const f = await strandedPublishFixture();
    if (lane === 'record-only') await f.strand();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const metaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
    const query = f.store.query.bind(f.store);
    const read = vi.spyOn(f.store, 'query').mockImplementation(async (sparql, options) => {
      if (blocked !== 'lock' && sparql.includes('SELECT ?predicate ?object') && sparql.includes(`<${f.ual}>`)) {
        entered();
        if (blocked === 'failed-read') throw new Error('injected confirmed metadata read failure');
        await held;
      }
      return query(sparql, options);
    });
    const locking = blocked === 'lock' ? withMaterializationLock(metaGraph, f.ual, async () => { entered(); await held; }) : undefined;
    if (locking) await acquired;
    const confirmed = vi.fn(async () => { throw new Error('observer failure must remain best-effort'); });
    const pending = f.publish(lane === 'record-only' ? {} : undefined, confirmed)
      .then(value => ({ value }), error => ({ error }));
    try {
      if (blocked !== 'lock') await acquired;
      await vi.waitFor(() => expect(confirmed).toHaveBeenCalledExactlyOnceWith({ txHash: f.chain.mintTxHashes.at(-1)! }));
      if (blocked === 'failed-read') expect(await pending).toMatchObject({ error: { message: 'injected confirmed metadata read failure' } });
      else { release(); expect(await pending).toMatchObject({ value: { status: 'confirmed' } }); }
      expect(confirmed).toHaveBeenCalledOnce();
    } finally { release(); await Promise.allSettled([pending, ...(locking ? [locking] : [])]); read.mockRestore(); await f.store.close(); }
  });
}

it.each(['live', 'adopted', 'unresolved-graph'] as const)('confirms exact tentative publication metadata via %s', async mode => {
  const f = await strandedPublishFixture();
  const contextGraphId = mode === 'unresolved-graph' ? 'unregistered-local-graph' : CONTEXT_GRAPH;
  const ready = vi.spyOn(f.chain, 'isV10Ready');
  try {
    if (mode !== 'unresolved-graph') ready.mockReturnValue(false);
    const options = { ...f.publishOptions, trustedNonManifestCatalogTriples: mode === 'unresolved-graph' ? undefined : generatedPrivateCatalogTripleKeys(contextGraphId) };
    const local = await f.publisher.publish({ ...options, contextGraphId, quads: [LOT],
      onChainContextGraphId: mode === 'unresolved-graph' ? undefined : CONTEXT_GRAPH });
    expect(local.status).toBe('tentative');
    expect(f.chain.createCalls).toBe(0);
    const before = await f.store.query(`SELECT ?s WHERE { GRAPH <did:dkg:context-graph:${contextGraphId}/_meta> { <${f.ual}> <${DKG}status> ?s } }`);
    expect(before.type === 'bindings' && before.bindings.map(row => row.s)).toEqual(['"tentative"']);
    ready.mockRestore();
    const publish = () => f.publisher.publish({ ...options, contextGraphId, quads: [LOT], onChainContextGraphId: CONTEXT_GRAPH });
    let confirmed;
    if (mode === 'adopted') {
      f.chain.loseNextReceipt = true;
      await expect(publish()).rejects.toThrow('timed out waiting for a receipt');
      confirmed = await f.publish({});
    } else confirmed = await publish();
    expect(confirmed.status).toBe('confirmed');
    expect(f.chain.createCalls).toBe(1);
    expect(await readConfirmedGraphKnowledgeAssetMetadataEnvelope(f.store, { contextGraphId, ual: f.ual }))
      .toMatchObject({ state: 'confirmed', envelope: { assertionVersion: '1', merkleRoot: f.sealedRoot,
        transactionHash: f.chain.mintTxHashes[0], batchId: f.kaId } });
    const rows = await f.store.query(`SELECT ?p (COUNT(?o) AS ?n) WHERE { GRAPH <did:dkg:context-graph:${contextGraphId}/_meta> { <${f.ual}> ?p ?o } } GROUP BY ?p`);
    expect(rows.type === 'bindings' && rows.bindings.every(row => Number(String(row.n).replace(/^"(\d+)".*$/, '$1')) === 1)).toBe(true);
  } finally { ready.mockRestore(); await f.store.close(); }
});

it.each(['root', 'version'] as const)('refuses a conflicting tentative %s without replacing it', async conflict => {
  const f = await strandedPublishFixture();
  try {
    const ready = vi.spyOn(f.chain, 'isV10Ready').mockReturnValue(false);
    await f.publisher.publish({ ...f.publishOptions, contextGraphId: CONTEXT_GRAPH, quads: [LOT] });
    ready.mockRestore();
    const graph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
    const predicate = `${DKG}${conflict === 'root' ? 'merkleRoot' : 'assertionVersion'}`;
    await f.store.deleteByPattern({ graph, subject: f.ual, predicate });
    const object = conflict === 'root' ? `"${'aa'.repeat(32)}"` : '"2"^^<http://www.w3.org/2001/XMLSchema#integer>';
    await f.store.insert([{ graph, subject: f.ual, predicate, object }]);
    await expect(f.publisher.publish({ ...f.publishOptions, contextGraphId: CONTEXT_GRAPH, quads: [LOT] }))
      .rejects.toMatchObject({ reason: 'existing-record-conflict' });
    const status = await f.store.query(`SELECT ?s WHERE { GRAPH <${graph}> { <${f.ual}> <${DKG}status> ?s } }`);
    expect(status.type === 'bindings' && status.bindings.map(row => row.s)).toEqual(['"tentative"']);
  } finally { await f.store.close(); }
});


it.each(['explicit', 'duplicate-mint'] as const)('refuses a noninitial assertion version before %s recording changes VM or SWM', async mode => {
  const f = await strandedPublishFixture();
  try {
    await f.strand();
    const options = { ...f.publishOptions, assertionVersion: 2 };
    const before = await f.store.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }');
    const operation = mode === 'explicit'
      ? f.publisher.recordExistingMintFromSharedMemory(CONTEXT_GRAPH, 'all', {}, options)
      : f.publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all', options);
    await expect(operation).rejects.toMatchObject({ code: 'KA_MINT_ADOPTION_REFUSED', reason: 'assertion-version-mismatch', retryable: false });
    const after = await f.store.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }');
    expect(after).toEqual(before);
    expect(await f.graphSize(f.vmGraph)).toBe(0);
    expect(await f.graphSize(f.swmGraph)).toBe(1);
    expect(f.chain.broadcasts).toBe(0);
  } finally { await f.store.close(); }
});


it('rejects changed sealed content before local staging when chain identity is unavailable', async () => {
  const f = await strandedPublishFixture();
  vi.spyOn(f.chain, 'isV10Ready').mockReturnValue(false);
  vi.spyOn(f.chain, 'getEvmChainId').mockRejectedValue(new Error('No chain configured'));
  await f.store.replaceGraph(f.swmGraph, [{ ...LOT, object: '"Changed after finalization"', graph: f.swmGraph }]);
  await expect(f.publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all', {
    ...f.publishOptions, trustedNonManifestCatalogTriples: undefined,
  })).rejects.toThrow(/expectedMerkleRoot mismatch/);
  expect(f.encrypt).not.toHaveBeenCalled(); expect(f.acks).not.toHaveBeenCalled();
  expect(f.chain.createCalls).toBe(0);
  await expectNothingRecorded(f);
});

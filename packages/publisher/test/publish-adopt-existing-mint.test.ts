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
import { MintAdoptionRefusedError, generatedPrivateCatalogTripleKeys } from '../src/index.js';
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
  const recordedTxHashes = async () => {
    const result = await store.query(
      `SELECT ?tx WHERE { GRAPH ?g { <${ual}> <${DKG}transactionHash> ?tx } }`,
    );
    return result.type === 'bindings' ? result.bindings.map((row) => String(row['tx']).replace(/^"|"$/g, '')) : [];
  };

  return { chain, store, publish, strand, mintForeign, kaId, ual, swmGraph, vmGraph, acks, encrypt, graphSize, recordedTxHashes };
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

  it('reconcile of an unminted reservation refuses as not minted and sends nothing', async () => {
    const fixture = await strandedPublishFixture();

    await expect(fixture.publish({})).rejects.toMatchObject({ reason: 'not-minted', retryable: false });
    expect(fixture.chain.createCalls).toBe(0);
    expect(fixture.acks).not.toHaveBeenCalled();
    await expectNothingRecorded(fixture);
  });
});

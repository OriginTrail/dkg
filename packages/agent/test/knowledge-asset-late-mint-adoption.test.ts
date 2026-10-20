/**
 * A named asset whose publish transaction mined after the node stopped
 * waiting, through the agent's real named-asset lifecycle: create, write,
 * finalize, share, then the lost mint lands on chain while the node still
 * reads `swm-shared`. Both the synchronous `vm/publish` retry (which reverts
 * `KaIdAlreadyMinted`) and the operator reconcile record that mint, and the
 * lifecycle ends `vm-confirmed` with the reserved UAL as its published UAL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { buildAuthorAttestationTypedData } from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
  type DKGPublisher,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent, reconcileKnowledgeAssetMint } from '../src/index.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';

const wallet = new ethers.Wallet(`0x${'35'.repeat(32)}`);
const AUTHOR = wallet.address;
const CONTEXT_GRAPH = 'late-mint-cg';
const ON_CHAIN_CONTEXT_GRAPH = 1n;
const NAME = 'lots-2026-08-12';
const RESERVED_KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const QUADS = [{ subject: 'urn:lot:2026-08-12', predicate: 'http://schema.org/name', object: '"Lot 12"', graph: '' }];
const MERKLE_ROOT = computeFlatKCRootV10(QUADS, []);
const ZERO = new Uint8Array(32);

/** The mock chain with a real publish wallet, which the vm/publish path needs to sign. */
class WalletMockChain extends MockChainAdapter {
  constructor() {
    super('mock:31337', wallet.address);
  }

  override async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const signature = ethers.Signature.from(await wallet.signMessage(messageHash));
    return { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) };
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return wallet.signTypedData(domain, types, value);
  }
}

describe('a named asset whose publish mined after the node stopped waiting', () => {
  let agent: DKGAgent | undefined;
  afterEach(async () => {
    await agent?.stop().catch(() => {});
    agent = undefined;
    vi.restoreAllMocks();
  });

  /**
   * A finalized, fully shared asset whose own mint already landed on chain
   * unobserved. `publisherAddress` gives the node a wallet to publish with.
   */
  async function strandedAsset(chain: MockChainAdapter, publisherAddress?: string) {
    const store = new OxigraphStore();
    agent = await DKGAgent.create({
      name: 'LateMintNode', listenPort: 0, listenHost: '127.0.0.1', store,
      chainAdapter: chain, nodeRole: 'core', skills: [], kaNumberAllocator: makeTestKaNumberAllocator(),
      ...(publisherAddress ? { publisherAddress } : {}),
    });
    await agent.start();
    vi.spyOn(agent, 'getContextGraphOnChainId').mockResolvedValue(ON_CHAIN_CONTEXT_GRAPH.toString());
    // A public graph: no member ciphertext (as in the other named-publish agent tests).
    vi.spyOn(agent as unknown as { _resolveInlineEncryption(): Promise<object> }, '_resolveInlineEncryption')
      .mockResolvedValue({});

    const typedData = buildAuthorAttestationTypedData({
      chainId: await chain.getEvmChainId(),
      kav10Address: await chain.getKnowledgeAssetsLifecycleAddress(),
      authorAddress: AUTHOR, merkleRoot: MERKLE_ROOT, reservedKaId: RESERVED_KA_ID, schemeVersion: 1,
    });
    const signed = ethers.Signature.from(await wallet.signTypedData(typedData.domain, typedData.types, typedData.message));
    const signature = { r: ethers.getBytes(signed.r), vs: ethers.getBytes(signed.yParityAndS) };
    const preSignedAuthorAttestation = { address: AUTHOR, reservedKaId: RESERVED_KA_ID, signature };
    await agent.assertion.create(CONTEXT_GRAPH, NAME, { agentAddress: AUTHOR, reservedKaId: RESERVED_KA_ID });
    await agent.assertion.write(CONTEXT_GRAPH, NAME, QUADS, { agentAddress: AUTHOR });
    const sealed = await agent.assertion.finalize(CONTEXT_GRAPH, NAME, { agentAddress: AUTHOR, preSignedAuthorAttestation });
    await agent.assertion.promote(CONTEXT_GRAPH, NAME, { agentAddress: AUTHOR, preSignedAuthorAttestation, entities: 'all' });

    // The first publish attempt's transaction, which mined after the node gave up on its receipt.
    const lostMint = await chain.createKnowledgeAssets({
      publishOperationId: 'lost-attempt',
      contextGraphId: ON_CHAIN_CONTEXT_GRAPH,
      publisherAddress: chain.signerAddress,
      reservedKaId: RESERVED_KA_ID,
      merkleRoot: MERKLE_ROOT,
      knowledgeAssetsAmount: 1,
      byteSize: 1n,
      epochs: 1,
      tokenAmount: 5n,
      isImmutable: false,
      author: { address: AUTHOR, signature, schemeVersion: 1 },
      ackSignatures: [{ identityId: 1n, r: ZERO, vs: ZERO }],
    });
    const history = () => agent!.assertion.history(CONTEXT_GRAPH, NAME, { agentAddress: AUTHOR });
    expect(await history()).toMatchObject({ status: 'swm-shared', reservedUal: sealed.kaUal });
    const createKnowledgeAssets = vi.spyOn(chain, 'createKnowledgeAssets');
    return { agent, store, sealed, lostMint, history, createKnowledgeAssets };
  }

  it('records the late mint on the vm/publish retry that reverts KaIdAlreadyMinted', async () => {
    const { agent, sealed, lostMint, history, createKnowledgeAssets } = await strandedAsset(new WalletMockChain(), wallet.address);
    vi.spyOn(agent as unknown as { createV10ACKProvider(cg: string): unknown }, 'createV10ACKProvider')
      .mockReturnValue(async () => [{ peerId: 'stub-core', signatureR: ZERO, signatureVS: ZERO, nodeIdentityId: 1n }]);

    const published = await agent.publishFromFinalizedAssertion(CONTEXT_GRAPH, NAME, { agentAddress: AUTHOR });

    expect(createKnowledgeAssets).toHaveBeenCalledOnce();
    expect(published).toMatchObject({ status: 'confirmed', ual: sealed.kaUal });
    expect(published.onChainResult).toMatchObject({ txHash: lostMint.txHash, tokenAmount: 5n });
    expect(await history()).toMatchObject({ status: 'vm-confirmed', publishedUal: sealed.kaUal });
  });

  it('reconcile records the late mint without a publish wallet or chain write, and is idempotent', async () => {
    const { agent, sealed, lostMint, history, createKnowledgeAssets } = await strandedAsset(new MockChainAdapter());

    const reconciled = await reconcileKnowledgeAssetMint(agent, { contextGraphId: CONTEXT_GRAPH, name: NAME });

    expect(reconciled).toEqual({
      status: 'adopted', ual: sealed.kaUal, kaId: RESERVED_KA_ID.toString(),
      txHash: lostMint.txHash, blockNumber: lostMint.blockNumber, tokenAmount: '5',
    });
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
    expect(await history()).toMatchObject({ status: 'vm-confirmed', publishedUal: sealed.kaUal });
    await expect(reconcileKnowledgeAssetMint(agent, { contextGraphId: CONTEXT_GRAPH, name: NAME }))
      .resolves.toEqual({ status: 'already-published', ual: sealed.kaUal });
  });

  it('reconcile completes after a run that recorded the mint but failed before the lifecycle stamp', async () => {
    const { agent, store, sealed, lostMint, history } = await strandedAsset(new MockChainAdapter());
    const input = { contextGraphId: CONTEXT_GRAPH, name: NAME };
    // The terminus failure: VM content and metadata recorded, then the shared-memory cleanup throws.
    const publisher = (agent as unknown as { publisher: DKGPublisher }).publisher;
    const cleanup = vi.spyOn(publisher, 'clearPublishedKnowledgeAssetSwm')
      .mockRejectedValueOnce(new Error('Triple-store response exceeds byte limit: found 8396603, limit 8388608'));
    await expect(reconcileKnowledgeAssetMint(agent, input)).rejects.toThrow(/exceeds byte limit/);
    expect(await history()).toMatchObject({ status: 'swm-shared' });
    cleanup.mockRestore();

    await expect(reconcileKnowledgeAssetMint(agent, input))
      .resolves.toMatchObject({ status: 'adopted', ual: sealed.kaUal, txHash: lostMint.txHash });
    await expect(reconcileKnowledgeAssetMint(agent, input))
      .resolves.toEqual({ status: 'already-published', ual: sealed.kaUal });

    expect(await history()).toMatchObject({ status: 'vm-confirmed', publishedUal: sealed.kaUal });
    expect(await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, { contextGraphId: CONTEXT_GRAPH, ual: sealed.kaUal }))
      .toMatchObject({ state: 'confirmed', envelope: { transactionHash: lostMint.txHash } });
    const publishedAt = await store.query(
      `SELECT ?at WHERE { GRAPH <did:dkg:context-graph:${CONTEXT_GRAPH}/_meta> { <${sealed.kaUal}> <http://dkg.io/ontology/publishedAt> ?at } }`,
    );
    expect(publishedAt.type === 'bindings' && publishedAt.bindings).toHaveLength(1);
  });
});

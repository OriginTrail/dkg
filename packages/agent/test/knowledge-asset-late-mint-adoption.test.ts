/**
 * A named asset whose publish transaction mined after the node stopped
 * waiting, through the agent's real named-asset lifecycle: create, write,
 * finalize, share, then the lost mint lands on chain while the node still
 * reads `swm-shared`. Both the synchronous `vm/publish` retry (which reverts
 * `KaIdAlreadyMinted`) and the operator reconcile record that mint, and the
 * lifecycle ends `vm-confirmed` with the reserved UAL as its published UAL.
 * A reconcile interrupted after the share was consumed resumes from the
 * verified VM record.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  assertionLifecycleUri,
  buildAuthorAttestationTypedData,
  contextGraphCatalogUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import {
  VM_CURRENT_ASSERTION_PRED,
  computeFlatKCRootV10,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent, KA_MINT_RECONCILE_INCOMPLETE_CODE, KA_MINT_RECONCILE_REFUSED_CODE } from '../src/index.js';
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
const PUBLISHED_UAL_PRED = 'http://dkg.io/ontology/publishedUal';
const SWM_SHARE_COMPLETE_PRED = 'http://dkg.io/ontology/swmShareComplete';
const LIFECYCLE = assertionLifecycleUri(CONTEXT_GRAPH, AUTHOR, NAME);
const META_GRAPH = contextGraphMetaUri(CONTEXT_GRAPH);
const RECONCILE = { contextGraphId: CONTEXT_GRAPH, name: NAME };

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
    const accessPolicy = vi.spyOn(agent, 'resolveOnChainAccessPolicyState').mockResolvedValue(0);

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
    const updateKnowledgeCollection = vi.spyOn(chain, 'updateKnowledgeCollectionV10');
    return { agent, store, sealed, lostMint, history, createKnowledgeAssets, updateKnowledgeCollection, accessPolicy };
  }

  /** Make the next lifecycle write of `predicate` fail, as a transient store failure would. */
  function failNextLifecycleWrite(target: DKGAgent, store: OxigraphStore, predicate: string) {
    let failed = false;
    const fail = () => {
      if (failed) return false;
      failed = true;
      return true;
    };
    const stampPointer = target._stampPointer.bind(target);
    vi.spyOn(target, '_stampPointer').mockImplementation(async (subject, pred, ...rest) => {
      if (pred === predicate && fail()) throw new Error(`store write of ${predicate} failed`);
      return stampPointer(subject, pred, ...rest);
    });
    const insert = store.insert.bind(store);
    vi.spyOn(store, 'insert').mockImplementation(async (quads: Quad[]) => {
      if (quads.some((quad) => quad.predicate === predicate) && fail()) throw new Error(`store write of ${predicate} failed`);
      return insert(quads);
    });
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

    const reconciled = await agent.reconcileKnowledgeAssetMint(RECONCILE);

    expect(reconciled).toEqual({
      status: 'adopted', ual: sealed.kaUal, kaId: RESERVED_KA_ID.toString(),
      txHash: lostMint.txHash, blockNumber: lostMint.blockNumber, tokenAmount: '5',
    });
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
    expect(await history()).toMatchObject({ status: 'vm-confirmed', publishedUal: sealed.kaUal });
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .resolves.toEqual({ status: 'already-published', ual: sealed.kaUal });
  });

  it('reconcile completes after a run that recorded the mint but failed before the lifecycle stamp', async () => {
    const { agent, store, sealed, lostMint, history } = await strandedAsset(new MockChainAdapter());
    // The terminus failure: VM content and metadata recorded, then the shared-memory cleanup throws.
    const cleanup = vi.spyOn(agent.publisher, 'clearPublishedKnowledgeAssetSwm')
      .mockRejectedValueOnce(new Error('Triple-store response exceeds byte limit: found 8396603, limit 8388608'));
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toThrow(/exceeds byte limit/);
    expect(await history()).toMatchObject({ status: 'swm-shared' });
    cleanup.mockRestore();

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .resolves.toMatchObject({ status: 'adopted', ual: sealed.kaUal, txHash: lostMint.txHash });
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .resolves.toEqual({ status: 'already-published', ual: sealed.kaUal });

    expect(await history()).toMatchObject({ status: 'vm-confirmed', publishedUal: sealed.kaUal });
    expect(await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, { contextGraphId: CONTEXT_GRAPH, ual: sealed.kaUal }))
      .toMatchObject({ state: 'confirmed', envelope: { transactionHash: lostMint.txHash } });
    const publishedAt = await store.query(
      `SELECT ?at WHERE { GRAPH <did:dkg:context-graph:${CONTEXT_GRAPH}/_meta> { <${sealed.kaUal}> <http://dkg.io/ontology/publishedAt> ?at } }`,
    );
    expect(publishedAt.type === 'bindings' && publishedAt.bindings).toHaveLength(1);
  });

  it.each([
    ['the VM pointer', VM_CURRENT_ASSERTION_PRED],
    ['the published UAL', PUBLISHED_UAL_PRED],
  ])('a retry completes the lifecycle after the write of %s failed, from the verified record', async (_label, predicate) => {
    const { agent, store, sealed, lostMint, history, createKnowledgeAssets, updateKnowledgeCollection } =
      await strandedAsset(new MockChainAdapter());
    failNextLifecycleWrite(agent, store, predicate);

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    // The attempt consumed the share, so the retry cannot publish from it.
    expect(await agent.publisher.hasSwmShareComplete(CONTEXT_GRAPH, NAME, AUTHOR)).toBe(false);
    const publishFromFinalizedAssertion = vi.spyOn(agent, 'publishFromFinalizedAssertion');

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).resolves.toEqual({
      status: 'adopted', ual: sealed.kaUal, kaId: RESERVED_KA_ID.toString(),
      txHash: lostMint.txHash, blockNumber: lostMint.blockNumber, tokenAmount: '5',
    });

    expect(publishFromFinalizedAssertion).not.toHaveBeenCalled();
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
    expect(updateKnowledgeCollection).not.toHaveBeenCalled();
    expect(await history()).toMatchObject({
      status: 'vm-confirmed', publishedUal: sealed.kaUal, vmCurrentAssertion: ethers.hexlify(MERKLE_ROOT).slice(2),
    });
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .resolves.toEqual({ status: 'already-published', ual: sealed.kaUal });
  });

  it('refuses to complete a lifecycle when the share is gone and no verified record exists', async () => {
    const { agent, history, createKnowledgeAssets } = await strandedAsset(new MockChainAdapter());
    await agent.publisher.clearSwmShareComplete(CONTEXT_GRAPH, NAME, AUTHOR);

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE, message: expect.stringMatching(/no verified record/) });
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
    expect(await history()).toMatchObject({ status: 'swm-shared' });
  });

  it('reconciles a curated asset from policy alone, without a signing key or sender-key setup', async () => {
    const chain = new MockChainAdapter();
    const { agent, store, sealed, lostMint, accessPolicy } = await strandedAsset(chain);
    accessPolicy.mockResolvedValue(1);
    vi.spyOn(chain, 'getContextGraphFinalizedCreation').mockResolvedValue({
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH)), accessPolicy: 1,
    });
    const keyed = agent as unknown as Record<string, (...args: unknown[]) => unknown>;
    vi.spyOn(agent, 'getLocalSigningAgentForAddress').mockReturnValue(null);
    const publishFromSharedMemory = vi.spyOn(agent.publisher, 'publishFromSharedMemory');
    const senderKeyWork = ['_resolveCuratedChainKeyContext', '_resolveInlineEncryption', 'loadSwmSenderKeyState', 'createV10ACKProvider']
      .map((method) => vi.spyOn(keyed, method));
    for (const spy of senderKeyWork) spy.mockClear();

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .resolves.toMatchObject({ status: 'adopted', ual: sealed.kaUal, txHash: lostMint.txHash });

    for (const spy of senderKeyWork) expect(spy).not.toHaveBeenCalled();
    // The curated catalog floor is recorded as the minting publish records it.
    const catalog = await store.query(`SELECT ?s WHERE { GRAPH <${contextGraphCatalogUri(CONTEXT_GRAPH)}> { ?s ?p ?o } }`);
    expect(catalog.type === 'bindings' && catalog.bindings.length).toBeGreaterThan(0);
    // The curated hook the publisher received refuses to encrypt anything.
    const encrypt = publishFromSharedMemory.mock.calls[0]?.[2]?.encryptInlinePayload;
    expect(encrypt).toBeTypeOf('function');
    await expect(encrypt!(new Uint8Array([1]))).rejects.toThrow(/never encrypts/);
  });

  it('never routes a record-only publish onto the update path', async () => {
    const { agent, store, updateKnowledgeCollection } = await strandedAsset(new MockChainAdapter());
    await agent.reconcileKnowledgeAssetMint(RECONCILE);
    // A new complete share of the published asset, as an edit cycle leaves it.
    await store.insert([{ subject: LIFECYCLE, predicate: SWM_SHARE_COMPLETE_PRED, object: '"true"', graph: META_GRAPH }]);

    await expect(agent.publishFromFinalizedAssertion(CONTEXT_GRAPH, NAME, { agentAddress: AUTHOR, adoptExistingMint: {} }))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE });
    expect(updateKnowledgeCollection).not.toHaveBeenCalled();
  });

  it('refuses when the lifecycle already records another VM version', async () => {
    const { agent, createKnowledgeAssets } = await strandedAsset(new MockChainAdapter());
    await agent._stampPointer(LIFECYCLE, VM_CURRENT_ASSERTION_PRED, 'ff'.repeat(32), META_GRAPH);

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE, message: expect.stringMatching(/already records VM version/) });
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
  });

  it('fails retryably when the record-only publish does not confirm', async () => {
    const { agent } = await strandedAsset(new MockChainAdapter());
    vi.spyOn(agent, 'publishFromFinalizedAssertion').mockResolvedValueOnce({ status: 'tentative' } as never);

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE, message: expect.stringMatching(/ended tentative/) });
  });

  it('refuses to complete a lifecycle without an on-chain context graph', async () => {
    const { agent } = await strandedAsset(new MockChainAdapter());
    await agent.publisher.clearSwmShareComplete(CONTEXT_GRAPH, NAME, AUTHOR);
    vi.mocked(agent.getContextGraphOnChainId).mockResolvedValue(null);

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE, message: expect.stringMatching(/has no on-chain id/) });
  });

  it('refuses to complete a lifecycle from a local record of another transaction', async () => {
    const chain = new MockChainAdapter();
    const { agent, store, history } = await strandedAsset(chain);
    failNextLifecycleWrite(agent, store, VM_CURRENT_ASSERTION_PRED);
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    const lookedUp = await chain.resolveKnowledgeAssetMint(RESERVED_KA_ID);
    if (lookedUp.status !== 'confirmed') throw new Error(`expected the lost mint to resolve, got ${lookedUp.status}`);
    vi.spyOn(chain, 'resolveKnowledgeAssetMint')
      .mockResolvedValue({ ...lookedUp, mint: { ...lookedUp.mint, txHash: `0x${'ee'.repeat(32)}` } });

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE, message: expect.stringMatching(/names transaction/) });
    expect((await history())?.vmCurrentAssertion).toBeUndefined();
  });
});

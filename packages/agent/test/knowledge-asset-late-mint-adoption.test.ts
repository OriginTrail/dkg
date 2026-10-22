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
  ASSERTION_PUBLISH_RECEIPT_PREDICATES,
  assertionLifecycleUri,
  buildAuthorAttestationTypedData,
  contextGraphAssertionUri,
  contextGraphCatalogUri,
  contextGraphFinalizationTopic,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import {
  VM_CURRENT_ASSERTION_PRED,
  computeFlatKCRootV10,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent, KA_MINT_RECONCILE_INCOMPLETE_CODE, KA_MINT_RECONCILE_REFUSED_CODE } from '../src/index.js';
import { sealChainTargetMismatch } from '../src/seal-chain-target.js';
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
const ASSERTION = contextGraphAssertionUri(CONTEXT_GRAPH, AUTHOR, NAME);
const PUBLISHED_AT_TX_PRED = ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_TX;
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
  async function strandedAsset(chain: MockChainAdapter, publisherAddress?: string, subGraphName?: string) {
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
    if (subGraphName) {
      await agent.createContextGraph({ id: CONTEXT_GRAPH, name: CONTEXT_GRAPH });
      await agent.createSubGraph(CONTEXT_GRAPH, subGraphName);
    }
    const { sealed, lostMint, history } = await strandAuthorAsset(chain, wallet, subGraphName);
    const createKnowledgeAssets = vi.spyOn(chain, 'createKnowledgeAssets');
    const updateKnowledgeCollection = vi.spyOn(chain, 'updateKnowledgeCollectionV10');
    return { agent, store, sealed, lostMint, history, createKnowledgeAssets, updateKnowledgeCollection, accessPolicy };
  }

  /** One author's finalized, shared asset named NAME on the running agent, whose mint landed unobserved. */
  async function strandAuthorAsset(chain: MockChainAdapter, author: ethers.Wallet, subGraphName?: string) {
    const reservedKaId = (BigInt(author.address) << 96n) | 7n;
    const typedData = buildAuthorAttestationTypedData({
      chainId: await chain.getEvmChainId(),
      kav10Address: await chain.getKnowledgeAssetsLifecycleAddress(),
      authorAddress: author.address, merkleRoot: MERKLE_ROOT, reservedKaId, schemeVersion: 1,
    });
    const signed = ethers.Signature.from(await author.signTypedData(typedData.domain, typedData.types, typedData.message));
    const signature = { r: ethers.getBytes(signed.r), vs: ethers.getBytes(signed.yParityAndS) };
    const preSignedAuthorAttestation = { address: author.address, reservedKaId, signature };
    const agentAddress = author.address;
    await agent!.assertion.create(CONTEXT_GRAPH, NAME, { agentAddress, reservedKaId, subGraphName });
    await agent!.assertion.write(CONTEXT_GRAPH, NAME, QUADS, { agentAddress, subGraphName });
    const sealed = await agent!.assertion.finalize(CONTEXT_GRAPH, NAME, { agentAddress, preSignedAuthorAttestation, subGraphName });
    await agent!.assertion.promote(CONTEXT_GRAPH, NAME, { agentAddress, preSignedAuthorAttestation, entities: 'all', subGraphName });

    // The first publish attempt's transaction, which mined after the node gave up on its receipt.
    const lostMint = await chain.createKnowledgeAssets({
      publishOperationId: 'lost-attempt',
      contextGraphId: ON_CHAIN_CONTEXT_GRAPH,
      publisherAddress: chain.signerAddress,
      reservedKaId,
      merkleRoot: MERKLE_ROOT,
      knowledgeAssetsAmount: 1,
      byteSize: 1n,
      epochs: 1,
      tokenAmount: 5n,
      isImmutable: false,
      author: { address: author.address, signature, schemeVersion: 1 },
      ackSignatures: [{ identityId: 1n, r: ZERO, vs: ZERO }],
    });
    const history = () => agent!.assertion.history(CONTEXT_GRAPH, NAME, { agentAddress, subGraphName });
    expect(await history()).toMatchObject({ status: 'swm-shared', reservedUal: sealed.kaUal });
    return { sealed, lostMint, history };
  }

  /** Fail chosen lifecycle writes once each, as transient store failures would. */
  function lifecycleWriteFailures(target: DKGAgent, store: OxigraphStore) {
    const pending = new Set<string>();
    const stampPointer = target._stampPointer.bind(target);
    vi.spyOn(target, '_stampPointer').mockImplementation(async (subject, pred, ...rest) => {
      if (pending.delete(pred)) throw new Error(`store write of ${pred} failed`);
      return stampPointer(subject, pred, ...rest);
    });
    const insert = store.insert.bind(store);
    vi.spyOn(store, 'insert').mockImplementation(async (quads: Quad[]) => {
      const failing = quads.find((quad) => pending.delete(quad.predicate));
      if (failing) throw new Error(`store write of ${failing.predicate} failed`);
      return insert(quads);
    });
    return { failNext: (predicate: string) => { pending.add(predicate); } };
  }

  function failNextLifecycleWrite(target: DKGAgent, store: OxigraphStore, predicate: string) {
    lifecycleWriteFailures(target, store).failNext(predicate);
  }

  async function receiptTxHashes(store: OxigraphStore): Promise<string[]> {
    const receipt = await store.query(`SELECT ?tx WHERE { GRAPH <${META_GRAPH}> { <${ASSERTION}> <${PUBLISHED_AT_TX_PRED}> ?tx } }`);
    return receipt.type === 'bindings' ? receipt.bindings.map((row) => String(row['tx']).replace(/^"|"$/g, '')) : [];
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

  it('records and resumes a late mint in a sub-graph, as the operator commands address it', async () => {
    const { agent, store, sealed, lostMint, history, createKnowledgeAssets } =
      await strandedAsset(new MockChainAdapter(), undefined, 'lots');
    const reconcile = { ...RECONCILE, subGraphName: 'lots' };
    failNextLifecycleWrite(agent, store, VM_CURRENT_ASSERTION_PRED);

    await expect(agent.reconcileKnowledgeAssetMint(reconcile)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    await expect(agent.reconcileKnowledgeAssetMint(reconcile))
      .resolves.toMatchObject({ status: 'adopted', ual: sealed.kaUal, txHash: lostMint.txHash });

    expect(createKnowledgeAssets).not.toHaveBeenCalled();
    expect(await history()).toMatchObject({ status: 'vm-confirmed', publishedUal: sealed.kaUal });
    await expect(agent.reconcileKnowledgeAssetMint(reconcile)).resolves.toEqual({ status: 'already-published', ual: sealed.kaUal });
  });

  it('refuses a share an interrupted publish consumed before its finalization gossip, instead of reporting success', async () => {
    const chain = new MockChainAdapter();
    const { agent, history, createKnowledgeAssets } = await strandedAsset(chain);
    // The publish records the VM content and drops the shared graph, then its cleanup throws before the gossip.
    const clearShare = agent.publisher.clearPublishedKnowledgeAssetSwm.bind(agent.publisher);
    vi.spyOn(agent.publisher, 'clearPublishedKnowledgeAssetSwm').mockImplementationOnce(async (...args) => {
      await clearShare(...args);
      throw new Error('cleanup failed after dropping the shared graph');
    });
    const gossip = vi.spyOn(agent.gossip, 'publish');
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toThrow(/cleanup failed/);
    const before = await history();
    const lookup = vi.spyOn(chain, 'resolveKnowledgeAssetMint');

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE, message: expect.stringMatching(/interrupted publish consumed the share/) });

    expect(await history()).toEqual(before);
    expect(before?.vmCurrentAssertion).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
    expect(gossip.mock.calls.filter(([topic]) => topic === contextGraphFinalizationTopic(CONTEXT_GRAPH))).toHaveLength(0);
  });

  it('writes the receipt before the lifecycle stamp, so a failed receipt write is retried', async () => {
    const { agent, store, lostMint, history } = await strandedAsset(new MockChainAdapter());
    const writes = lifecycleWriteFailures(agent, store);
    writes.failNext(VM_CURRENT_ASSERTION_PRED);
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    // From a verified record without a receipt, the receipt write fails once.
    await store.deleteByPattern({ subject: ASSERTION, predicate: PUBLISHED_AT_TX_PRED });
    writes.failNext(PUBLISHED_AT_TX_PRED);
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toThrow(/publishedAtTx failed/);
    expect((await history())?.publishedUal).toBeUndefined();

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).resolves.toMatchObject({ status: 'adopted', txHash: lostMint.txHash });
    expect(await receiptTxHashes(store)).toEqual([lostMint.txHash]);
  });

  it('completes a publish receipt the publish path failed to write, instead of reporting success without it', async () => {
    const { agent, store, sealed, lostMint, history } = await strandedAsset(new MockChainAdapter());
    failNextLifecycleWrite(agent, store, PUBLISHED_AT_TX_PRED);

    // The publish path swallows its receipt failure and stamps the lifecycle anyway.
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    expect(await history()).toMatchObject({ status: 'vm-confirmed', publishedUal: sealed.kaUal });
    expect(await receiptTxHashes(store)).toEqual([]);

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).resolves.toMatchObject({ status: 'adopted', txHash: lostMint.txHash });
    expect(await receiptTxHashes(store)).toEqual([lostMint.txHash]);
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).resolves.toEqual({ status: 'already-published', ual: sealed.kaUal });
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

  it.each([
    ['without a published UAL', false],
    ['even with the asset\'s UAL as published', true],
  ])('refuses when the lifecycle already records another VM version, %s', async (_case, withPublishedUal) => {
    const { agent, store, sealed, history, createKnowledgeAssets } = await strandedAsset(new MockChainAdapter());
    await agent._stampPointer(LIFECYCLE, VM_CURRENT_ASSERTION_PRED, 'ff'.repeat(32), META_GRAPH);
    if (withPublishedUal) {
      await store.insert([{ subject: LIFECYCLE, predicate: PUBLISHED_UAL_PRED, object: `"${sealed.kaUal}"`, graph: META_GRAPH }]);
    }
    const before = await history();

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE, message: expect.stringMatching(/already records VM version/) });
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
    expect(await history()).toEqual(before);
  });

  it.each([
    ['its seal', async (chain: MockChainAdapter) => {
      vi.spyOn(chain, 'getEvmChainId').mockResolvedValue((await chain.getEvmChainId()) + 1n);
    }, /seal binds chainId=/],
    ['its UAL', async (chain: MockChainAdapter) => {
      (chain as { chainId: string }).chainId = 'mock:1';
      vi.spyOn(chain, 'getEvmChainId').mockResolvedValue(1n);
    }, /belongs to chain mock:31337/],
  ] as const)('refuses a consumed-share record when %s names another chain than the node, before reading chain evidence',
    async (_case, repointNode, refusal) => {
      const chain = new MockChainAdapter();
      const { agent, store, history } = await strandedAsset(chain);
      failNextLifecycleWrite(agent, store, VM_CURRENT_ASSERTION_PRED);
      await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
      const before = await history();
      // The same author, KA number, content and graph number can exist on the other chain.
      await repointNode(chain);
      const lookup = vi.spyOn(chain, 'resolveKnowledgeAssetMint');

      await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
        .rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE, message: expect.stringMatching(refusal) });
      expect(lookup).not.toHaveBeenCalled();
      expect(await history()).toEqual(before);
    });

  it('accepts a UAL whose chain label is an EIP-155 alias of the node\'s chain, as the publish path does', async () => {
    const chain = new MockChainAdapter();
    const { agent, store, sealed, lostMint, history } = await strandedAsset(chain);
    failNextLifecycleWrite(agent, store, VM_CURRENT_ASSERTION_PRED);
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    // The UAL says mock:31337; the node now labels the same EIP-155 chain evm:31337.
    expect(sealed.kaUal).toMatch(/^did:dkg:mock:31337\//);
    (chain as { chainId: string }).chainId = 'evm:31337';

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .resolves.toMatchObject({ status: 'adopted', ual: sealed.kaUal, txHash: lostMint.txHash });
    expect(await history()).toMatchObject({ status: 'vm-confirmed', publishedUal: sealed.kaUal });
  });

  it('records the selected one of two same-named assets by different authors, and leaves the other alone', async () => {
    const chain = new MockChainAdapter();
    const first = await strandedAsset(chain);
    const otherAuthor = new ethers.Wallet(`0x${'36'.repeat(32)}`);
    const second = await strandAuthorAsset(chain, otherAuthor);

    await expect(first.agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: 'AMBIGUOUS_ASSERTION_AUTHOR' });
    await expect(first.agent.reconcileKnowledgeAssetMint({ ...RECONCILE, selectedAuthorAgentAddress: otherAuthor.address }))
      .resolves.toMatchObject({ status: 'adopted', ual: second.sealed.kaUal, txHash: second.lostMint.txHash });

    expect(await second.history()).toMatchObject({ status: 'vm-confirmed', publishedUal: second.sealed.kaUal });
    expect(await first.history()).toMatchObject({ status: 'swm-shared' });
    await expect(first.agent.reconcileKnowledgeAssetMint({ ...RECONCILE, selectedAuthorAgentAddress: AUTHOR }))
      .resolves.toMatchObject({ status: 'adopted', ual: first.sealed.kaUal, txHash: first.lostMint.txHash });
  });

  it('leaves a draft that pull-from reopened while reconcile waited for the lifecycle lock', async () => {
    const { agent, store, history } = await strandedAsset(new MockChainAdapter());
    failNextLifecycleWrite(agent, store, PUBLISHED_UAL_PRED);
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    // The retry reads the reservation, then pauses before the lock while pull-from reopens the asset as a draft.
    vi.mocked(agent.getContextGraphOnChainId).mockImplementationOnce(async () => {
      await agent.assertion.pullFrom(CONTEXT_GRAPH, NAME, 'vm', { agentAddress: AUTHOR });
      return ON_CHAIN_CONTEXT_GRAPH.toString();
    });

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE, message: expect.stringMatching(/removed while reconcile waited/) });

    expect(await history()).toMatchObject({ state: 'created', memoryLayer: 'WM' });
    expect((await history())?.publishedUal).toBeUndefined();
  });

  it('reads mint evidence outside the lifecycle lock, so pull-from finishes during a slow lookup', async () => {
    const chain = new MockChainAdapter();
    const { agent, store, history } = await strandedAsset(chain);
    failNextLifecycleWrite(agent, store, PUBLISHED_UAL_PRED);
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    // pull-from takes the same lifecycle lock; were the lookup inside it, this would never finish.
    const lookup = chain.resolveKnowledgeAssetMint.bind(chain);
    vi.spyOn(chain, 'resolveKnowledgeAssetMint').mockImplementationOnce(async (...args) => {
      await agent.assertion.pullFrom(CONTEXT_GRAPH, NAME, 'vm', { agentAddress: AUTHOR });
      return lookup(...args);
    });

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE, message: expect.stringMatching(/removed while reconcile waited/) });
    expect(await history()).toMatchObject({ state: 'created', memoryLayer: 'WM' });
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

describe('sealChainTargetMismatch', () => {
  const kav10Address = `0x${'12'.repeat(20)}`;
  const seal = { chainId: 31337n, kav10Address };
  const chainAt = (chainId: bigint, kav10: string) => ({
    getEvmChainId: async () => chainId,
    getKnowledgeAssetsLifecycleAddress: async () => kav10,
  }) as unknown as MockChainAdapter;

  it('accepts a seal for this chain and deployment, and an adapter without an EVM identity', async () => {
    await expect(sealChainTargetMismatch(chainAt(31337n, kav10Address.toUpperCase().replace('0X', '0x')), seal)).resolves.toBeUndefined();
    await expect(sealChainTargetMismatch({} as MockChainAdapter, seal)).resolves.toBeUndefined();
  });

  it('names the chain or deployment the seal binds instead', async () => {
    await expect(sealChainTargetMismatch(chainAt(100n, kav10Address), seal))
      .resolves.toMatch(/^seal binds chainId=31337 but daemon is configured for chainId=100\./);
    await expect(sealChainTargetMismatch(chainAt(31337n, `0x${'34'.repeat(20)}`), seal))
      .resolves.toMatch(/^seal binds KAv10=0x1212.* but daemon is configured for KAv10=0x3434/);
  });
});

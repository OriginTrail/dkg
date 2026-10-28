import { Logger, type ContextGraphIdV1 } from '@origintrail-official/dkg-core';
import { assertionLifecycleWriteLockKey, withAssertionLifecycleWriteLease } from '@origintrail-official/dkg-publisher';
import * as publicationStages from '../src/dkg-agent-publish.js';
import { transferConfirmedVmCatalogV1 } from '../src/internal/confirmed-vm-catalog-observer.js';
import { readFinalizedAssertionReservation } from '../src/internal/finalized-assertion-reservation.js';
import type { KnowledgeAssetMintReconcileHost } from '../src/knowledge-asset-mint-reconcile.js';
import * as mintReconciliation from '../src/knowledge-asset-mint-reconcile.js';
import { beginNamedPublishFinalization, finishNamedPublishFinalization, readNamedPublishFinalization } from '../src/named-publish-finalization.js';
import { NETWORK_ID } from './support/rfc64-local-catalog-repair-fixture.js';
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
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  MemoryLayer,
  contextGraphFinalizationTopic,
  contextGraphSharedMemoryUri,
  contextGraphLayerUri,
  decodeFinalizationMessage
} from '@origintrail-official/dkg-core';
import {
  VM_CURRENT_ASSERTION_PRED,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KA_MINT_RECONCILE_INCOMPLETE_CODE, KA_MINT_RECONCILE_REFUSED_CODE } from '../src/index.js';

import { ASSERTION, AUTHOR, CONTEXT_GRAPH, LIFECYCLE, MERKLE_ROOT, META_GRAPH, NAME, NAMED_FINALIZATION_GRAPH, PUBLISHED_AT_TX_PRED, PUBLISHED_UAL_PRED, QUADS, RECONCILE, RESERVED_KA_ID, SWM_SHARE_COMPLETE_PRED, WalletMockChain, ZERO, failNextLifecycleWrite, lifecycleWriteFailures, receiptTxHashes, strandAuthorAsset, strandedAsset, wallet } from './support/late-mint-fixture.js';

describe('late-mint adoption', () => {
  afterEach(() => vi.restoreAllMocks());
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


  it('keeps an ordinary publish confirmed while its catalog transition is unfinished, and reconcile resumes it', async () => {
    const { agent, store, sealed, lostMint, history } = await strandedAsset(new WalletMockChain(), wallet.address);
    vi.spyOn(agent as unknown as { createV10ACKProvider(cg: string): unknown }, 'createV10ACKProvider')
      .mockReturnValue(async () => [{ peerId: 'stub-core', signatureR: ZERO, signatureVS: ZERO, nodeIdentityId: 1n }]);
    // The catalog has not admitted the projection yet.
    const transfer = vi.spyOn(agent, 'transferRfc64ConfirmedVmV1').mockResolvedValueOnce('projection-pending');

    await expect(agent.publishFromFinalizedAssertion(CONTEXT_GRAPH, NAME, { agentAddress: AUTHOR }))
      .resolves.toMatchObject({ status: 'confirmed', ual: sealed.kaUal });
    expect(await history()).toMatchObject({ status: 'vm-confirmed', publishedUal: sealed.kaUal });
    expect(await readNamedPublishFinalization(store, { assertionUri: ASSERTION, seal: sealed })).toMatchObject({ kind: 'pending' });

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .resolves.toMatchObject({ status: 'adopted', ual: sealed.kaUal, txHash: lostMint.txHash });
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(await readNamedPublishFinalization(store, { assertionUri: ASSERTION, seal: sealed })).toEqual({ kind: 'complete' });
  });


  it('reconcile treats a nonmatching transaction hash as a hint and adopts the real mint once', async () => {
    const chain = new MockChainAdapter();
    const { agent, sealed, lostMint, history, createKnowledgeAssets } = await strandedAsset(chain);
    const lookup = vi.spyOn(chain, 'resolveKnowledgeAssetMint');
    const hinted = { ...RECONCILE, txHash: `0x${'ab'.repeat(32)}` };
    await expect(agent.reconcileKnowledgeAssetMint(hinted)).resolves.toMatchObject({
      status: 'adopted', ual: sealed.kaUal, txHash: lostMint.txHash,
    });
    expect(lookup).toHaveBeenCalledOnce();
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
    expect(await history()).toMatchObject({ status: 'vm-confirmed', publishedUal: sealed.kaUal });
    await expect(agent.reconcileKnowledgeAssetMint(hinted)).resolves.toEqual({ status: 'already-published', ual: sealed.kaUal });
    expect(lookup).toHaveBeenCalledOnce();
  });


  it.each([undefined, 'lots'])('reconcile records the late mint without a publish wallet or chain write, and gossips once (subgraph %s)', async subGraphName => {
    const { agent, sealed, lostMint, history, createKnowledgeAssets } = await strandedAsset(new MockChainAdapter(), undefined, subGraphName);
    const gossip = vi.spyOn(agent.gossip, 'publish');
    const reconcile = { ...RECONCILE, subGraphName };

    const reads = vi.spyOn(agent.store, 'query');
    const reconciled = await agent.reconcileKnowledgeAssetMint(reconcile);
    // One preflight snapshot and one locked revalidation; the recorder reuses the latter.
    expect(reads.mock.calls.filter(([, options]) => options?.source === 'agent.reconcileLateMint.seal')).toHaveLength(2);
    expect(reads.mock.calls.filter(([, options]) => options?.source === 'agent.vmPublish.seal')).toHaveLength(0);

    expect(reconciled).toEqual({
      status: 'adopted', ual: sealed.kaUal, kaId: RESERVED_KA_ID.toString(),
      txHash: lostMint.txHash, blockNumber: lostMint.blockNumber, tokenAmount: '5',
    });
    const messages = () => gossip.mock.calls.filter(([topic]) => topic === contextGraphFinalizationTopic(CONTEXT_GRAPH));
    expect(messages()).toHaveLength(1);
    const message = decodeFinalizationMessage(messages()[0]![1]);
    expect(message).toMatchObject({ ual: sealed.kaUal, contextGraphId: CONTEXT_GRAPH,
      txHash: lostMint.txHash });
    expect(String(message.blockNumber)).toBe(String(lostMint.blockNumber));
    expect(ethers.hexlify(message.kcMerkleRoot)).toBe(ethers.hexlify(sealed.merkleRoot));
    expect(message.subGraphName ?? '').toBe(subGraphName ?? '');
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
    expect(await history()).toMatchObject({ status: 'vm-confirmed', publishedUal: sealed.kaUal });
    await expect(agent.reconcileKnowledgeAssetMint(reconcile))
      .resolves.toEqual({ status: 'already-published', ual: sealed.kaUal });
    expect(messages()).toHaveLength(1);
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


  it('resumes consumed-share completion without constructing update capabilities', async () => {
    const { agent, store } = await strandedAsset(new MockChainAdapter());
    failNextLifecycleWrite(agent, store, VM_CURRENT_ASSERTION_PRED);
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    Object.defineProperty(agent, 'update', { configurable: true, get() { throw new Error('completion must not construct update capabilities'); } });
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).resolves.toMatchObject({ status: 'adopted' });
  });

  it.each(['live', 'record'] as const)('publisher owns sealed-content rejection for %s mint acquisition', async kind => {
    const { agent, store, sealed, createKnowledgeAssets, updateKnowledgeCollection } = await strandedAsset(new WalletMockChain(), wallet.address);
    vi.spyOn(agent as unknown as { createV10ACKProvider(cg: string): unknown }, 'createV10ACKProvider')
      .mockReturnValue(async () => [{ peerId: 'stub-core', signatureR: ZERO, signatureVS: ZERO, nodeIdentityId: 1n }]);
    const graphs = (await store.listGraphs()).filter(graph => graph.startsWith(contextGraphSharedMemoryUri(CONTEXT_GRAPH)));
    let changed = 0;
    for (const graph of graphs) {
      const rows = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
      if (rows.type !== 'quads') continue;
      const payload = rows.quads.filter(quad => quad.subject === QUADS[0]!.subject && quad.predicate === QUADS[0]!.predicate);
      if (payload.length === 0) continue;
      await store.delete(payload.map(quad => ({ ...quad, graph })));
      await store.insert(payload.map(quad => ({ ...quad, object: '"Changed after finalization"', graph })));
      changed += payload.length;
    }
    expect(changed).toBeGreaterThan(0);
    const operation = kind === 'live' ? agent.publishFromFinalizedAssertion(CONTEXT_GRAPH, NAME, { agentAddress: AUTHOR })
      : agent.reconcileKnowledgeAssetMint(RECONCILE);
    await expect(operation).rejects.toThrow(/mismatch|does not match/);
    expect(createKnowledgeAssets).not.toHaveBeenCalled(); expect(updateKnowledgeCollection).not.toHaveBeenCalled();
    expect(await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, { contextGraphId: CONTEXT_GRAPH, ual: sealed.kaUal }))
      .not.toMatchObject({ state: 'confirmed' });
  });

  it('retries a consumed-share marker deletion before reporting the mint complete', async () => {
    const { agent, sealed, lostMint, createKnowledgeAssets, updateKnowledgeCollection } = await strandedAsset(new MockChainAdapter());
    const gossip = vi.spyOn(agent.gossip, 'publish');
    const finalizations = () => gossip.mock.calls.filter(([topic]) => topic === contextGraphFinalizationTopic(CONTEXT_GRAPH));
    const clear = vi.spyOn(agent.publisher, 'clearSwmShareComplete').mockRejectedValueOnce(new Error('one-shot marker deletion failure'));
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    expect(await agent.publisher.hasSwmShareComplete(CONTEXT_GRAPH, NAME, AUTHOR)).toBe(true);
    expect(await readNamedPublishFinalization(agent.store, { assertionUri: ASSERTION, seal: sealed })).toEqual({ kind: 'complete' });
    expect(finalizations()).toHaveLength(1);
    const record = vi.fn<KnowledgeAssetMintReconcileHost['recordMint']>();
    const reconcile = mintReconciliation.reconcileLateMint;
    vi.spyOn(mintReconciliation, 'reconcileLateMint').mockImplementation((host, input) => {
      record.mockImplementation(host.recordMint);
      return reconcile({ ...host, recordMint: record }, input);
    });
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).resolves.toMatchObject({ status: 'adopted', txHash: lostMint.txHash });
    expect(await agent.publisher.hasSwmShareComplete(CONTEXT_GRAPH, NAME, AUTHOR)).toBe(false);
    expect(finalizations()).toHaveLength(1);
    expect(clear).toHaveBeenCalledTimes(2); expect(record).not.toHaveBeenCalled();
    expect(createKnowledgeAssets).not.toHaveBeenCalled(); expect(updateKnowledgeCollection).not.toHaveBeenCalled();
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).resolves.toEqual({ status: 'already-published', ual: sealed.kaUal });
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


  it('refuses a VM lifecycle stamped before its finalization gossip, as a queued publish stamps it, instead of reporting success', async () => {
    const chain = new MockChainAdapter();
    const { agent, store, sealed, history } = await strandedAsset(chain);
    await agent.reconcileKnowledgeAssetMint(RECONCILE);
    // A queued publish records the VM content, drops the share and stamps the lifecycle, and only then gossips and
    // clears the share marker. Stopped between the two, it leaves no publish checkpoint and the marker set.
    await store.deleteByPattern({ graph: NAMED_FINALIZATION_GRAPH });
    await store.insert([{ subject: LIFECYCLE, predicate: SWM_SHARE_COMPLETE_PRED, object: '"true"', graph: META_GRAPH }]);
    const before = await history();
    expect(before).toMatchObject({ publishedUal: sealed.kaUal, vmCurrentAssertion: ethers.hexlify(MERKLE_ROOT).slice(2) });
    const lookup = vi.spyOn(chain, 'resolveKnowledgeAssetMint');
    const transfer = vi.spyOn(agent, 'transferRfc64ConfirmedVmV1');
    const gossip = vi.spyOn(agent.gossip, 'publish');

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE, message: expect.stringMatching(/no publish-owned checkpoint/) });

    expect(await history()).toEqual(before);
    expect(await readNamedPublishFinalization(store, { assertionUri: ASSERTION, seal: sealed })).toEqual({ kind: 'legacy' });
    expect(lookup).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
    expect(gossip.mock.calls.filter(([topic]) => topic === contextGraphFinalizationTopic(CONTEXT_GRAPH))).toHaveLength(0);
  });


  it('refuses after an interrupted queued mint is followed by a promote retry that clears the marker', async () => {
    const chain = new MockChainAdapter();
    const { agent, store, sealed, history, createKnowledgeAssets } = await strandedAsset(chain);
    await agent.reconcileKnowledgeAssetMint(RECONCILE);
    // Reconstruct the queued interruption boundary: VM content/lifecycle persisted,
    // no finalization checkpoint, and the original share marker remains.
    await store.deleteByPattern({ graph: NAMED_FINALIZATION_GRAPH });
    await store.insert([{ subject: LIFECYCLE, predicate: SWM_SHARE_COMPLETE_PRED, object: '"true"', graph: META_GRAPH }]);
    const gossip = vi.spyOn(agent.gossip, 'publish');
    await agent.assertion.promote(CONTEXT_GRAPH, NAME, { agentAddress: AUTHOR, entities: 'all' });
    expect(await agent.publisher.hasSwmShareComplete(CONTEXT_GRAPH, NAME, AUTHOR)).toBe(false);
    const before = await history();
    const lookup = vi.spyOn(chain, 'resolveKnowledgeAssetMint');

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE, message: expect.stringMatching(/no publish-owned checkpoint/) });

    expect(await history()).toEqual(before);
    expect(await readNamedPublishFinalization(store, { assertionUri: ASSERTION, seal: sealed })).toEqual({ kind: 'legacy' });
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


  it('records the mint when the first write of the publish checkpoint fails, instead of stranding the consumed share', async () => {
    const { agent, store, sealed, lostMint, history } = await strandedAsset(new MockChainAdapter());
    // The write the publish makes before it stamps the lifecycle and clears the share marker.
    failNextLifecycleWrite(agent, store, 'http://dkg.io/ontology/namedPublishFinalizationReady');

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .resolves.toMatchObject({ status: 'adopted', ual: sealed.kaUal, txHash: lostMint.txHash });
    expect(await history()).toMatchObject({ status: 'vm-confirmed', publishedUal: sealed.kaUal });
    expect(await readNamedPublishFinalization(store, { assertionUri: ASSERTION, seal: sealed })).toEqual({ kind: 'complete' });
  });


  it('fails closed without inventing completion when both readiness checkpoint writes fail', async () => {
    const chain = new MockChainAdapter();
    const { agent, store, sealed } = await strandedAsset(chain);
    const original = store.insert.bind(store);
    const write = vi.spyOn(store, 'insert').mockImplementation(async quads => {
      if (quads.some(q => q.predicate === 'http://dkg.io/ontology/namedPublishFinalizationReady')) throw new Error('checkpoint unavailable');
      return original(quads);
    });
    const consume = vi.spyOn(agent.publisher, 'clearSwmShareComplete');
    const submit = vi.spyOn(chain, 'createKnowledgeAssets');
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    expect(consume).not.toHaveBeenCalled();
    expect(await readNamedPublishFinalization(store, { assertionUri: ASSERTION, seal: sealed })).toEqual({ kind: 'legacy' });
    write.mockRestore();
    // Completed VM recording alone cannot prove gossip completion after a process boundary.
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE });
    expect(await readNamedPublishFinalization(store, { assertionUri: ASSERTION, seal: sealed })).toEqual({ kind: 'legacy' });
    expect(submit).not.toHaveBeenCalled();
  });


  it('keeps ordinary publication confirmed when both readiness checkpoint writes fail', async () => {
    const { agent, store, sealed, lostMint } = await strandedAsset(new WalletMockChain(), wallet.address);
    vi.spyOn(agent as unknown as { createV10ACKProvider(cg: string): unknown }, 'createV10ACKProvider')
      .mockReturnValue(async () => [{ peerId: 'stub-core', signatureR: ZERO, signatureVS: ZERO, nodeIdentityId: 1n }]);
    const original = store.insert.bind(store);
    vi.spyOn(store, 'insert').mockImplementation(async quads => {
      if (quads.some(q => q.predicate === 'http://dkg.io/ontology/namedPublishFinalizationReady')) throw new Error('checkpoint unavailable');
      return original(quads);
    });
    const consume = vi.spyOn(agent.publisher, 'clearSwmShareComplete');
    const published = await agent.publishFromFinalizedAssertion(CONTEXT_GRAPH, NAME, { agentAddress: AUTHOR });
    expect(published).toMatchObject({ status: 'confirmed', ual: sealed.kaUal, onChainResult: { txHash: lostMint.txHash } });
    expect(consume).not.toHaveBeenCalled();
    expect(await readNamedPublishFinalization(store, { assertionUri: ASSERTION, seal: sealed })).toEqual({ kind: 'legacy' });
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


  it('refuses a consumed share without a publish-owned checkpoint', async () => {
    const { agent, history, createKnowledgeAssets } = await strandedAsset(new MockChainAdapter());
    await agent.publisher.clearSwmShareComplete(CONTEXT_GRAPH, NAME, AUTHOR);

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE, message: expect.stringMatching(/no publish-owned checkpoint/) });
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
    expect(await history()).toMatchObject({ status: 'swm-shared' });
  });


  it.each(['missing', 'corrupt'] as const)('refuses checkpoint-backed recovery with %s VM content', async damage => {
    const { agent, store, sealed, history, createKnowledgeAssets, updateKnowledgeCollection } =
      await strandedAsset(new MockChainAdapter());
    failNextLifecycleWrite(agent, store, VM_CURRENT_ASSERTION_PRED);
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    expect(await agent.publisher.hasSwmShareComplete(CONTEXT_GRAPH, NAME, AUTHOR)).toBe(false);
    expect(await readNamedPublishFinalization(store, { assertionUri: ASSERTION, seal: sealed })).not.toEqual({ kind: 'legacy' });
    const before = await history();
    expect(before?.vmCurrentAssertion).toBeUndefined();
    const graph = contextGraphLayerUri(CONTEXT_GRAPH, MemoryLayer.VerifiableMemory, AUTHOR.toLowerCase(), 7n);
    expect(await store.query(`ASK { GRAPH <${graph}> { ?s ?p ?o } }`)).toMatchObject({ type: 'boolean', value: true });
    await store.deleteByPattern({ graph });
    if (damage === 'corrupt') await store.insert([{ ...QUADS[0]!, object: '"Changed after checkpoint"', graph }]);
    const transfer = vi.spyOn(agent, 'transferRfc64ConfirmedVmV1');
    const stamp = vi.mocked(agent.publishedNamedKaVmLifecycleWriter); stamp.mockClear();

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({
      code: KA_MINT_RECONCILE_REFUSED_CODE, message: expect.stringMatching(/no verified record .* of the sealed content/),
    });
    expect(await history()).toEqual(before);
    expect(stamp).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
    expect(createKnowledgeAssets).not.toHaveBeenCalled(); expect(updateKnowledgeCollection).not.toHaveBeenCalled();
  });


  it.each(['public', 'private'] as const)('resumes the %s catalog transition after VM lifecycle and share cleanup already completed', async kind => {
    const { agent, store, sealed, history, createKnowledgeAssets } = await strandedAsset(new MockChainAdapter());
    const inventoryGraph = 'urn:test:remaining-swm-inventory';
    const repairGraph = 'urn:test:durable-private-placement';
    await store.insert([{ subject: sealed.kaUal!, predicate: 'urn:test:advertised', object: '"SWM"', graph: inventoryGraph }]);
    const transfer = vi.spyOn(agent, 'transferRfc64ConfirmedVmV1')
      .mockRejectedValueOnce(new Error('interrupted before catalog ownership transfer'))
      .mockImplementation(params => transferConfirmedVmCatalogV1({
        owner: agent, log: new Logger('late-mint-finalization-test'),
        finalizedPrivateScopeBase: kind === 'private' ? {
          networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH as ContextGraphIdV1,
          governanceChainId: null, governanceContractAddress: null, ownershipTransitionDigest: null,
          subGraphName: null, era: '1',
        } : null,
        storeRepair: async repair => { await store.insert([{ subject: repair.kaUal, predicate: 'urn:test:owed-placement',
          object: JSON.stringify(repair.assertionCoordinate), graph: repairGraph }]); },
        requestPlacement: () => ({ accepted: false }),
        removeInventory: async () => { await store.deleteByPattern({ graph: inventoryGraph });
          return { status: 'applied', attempts: 1, snapshot: null }; },
        requestProjection: () => true,
      }, params));
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toThrow('interrupted before catalog');
    expect(await history()).toMatchObject({ status: 'vm-confirmed', publishedUal: sealed.kaUal });
    expect(await agent.publisher.hasSwmShareComplete(CONTEXT_GRAPH, NAME, AUTHOR)).toBe(false);
    expect(await readNamedPublishFinalization(store, { assertionUri: ASSERTION, seal: sealed })).toMatchObject({ kind: 'pending' });
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).resolves.toMatchObject({ status: 'adopted' });
    expect(transfer).toHaveBeenCalledTimes(2);
    const remaining = await store.query(`ASK { GRAPH <${inventoryGraph}> { ?s ?p ?o } }`);
    const owed = await store.query(`ASK { GRAPH <${repairGraph}> { ?s ?p ?o } }`);
    expect(remaining).toMatchObject({ type: 'boolean', value: kind === 'private' });
    expect(owed).toMatchObject({ type: 'boolean', value: kind === 'private' });
    expect(await readNamedPublishFinalization(store, { assertionUri: ASSERTION, seal: sealed })).toEqual({ kind: 'complete' });
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).resolves.toMatchObject({ status: 'already-published' });
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
  });


  it('cannot manufacture a missing readiness checkpoint during resumption', async () => {
    const { store, sealed } = await strandedAsset(new MockChainAdapter());
    const input = { assertionUri: ASSERTION, seal: sealed, shareOperationId: 'original-share' };
    const transfer = vi.fn(async () => 'owned' as const), insert = vi.spyOn(store, 'insert');
    await expect(finishNamedPublishFinalization(store, input, { transfer })).resolves.toBe('pending');
    expect(transfer).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
    expect(await readNamedPublishFinalization(store, input)).toEqual({ kind: 'legacy' });
  });


  it('retains a publish-owned completion checkpoint when catalog execution is disabled before retry', async () => {
    const { store, sealed } = await strandedAsset(new MockChainAdapter());
    const input = { assertionUri: ASSERTION, seal: sealed, shareOperationId: 'original-share' };
    await beginNamedPublishFinalization(store, input, () => true);
    const transfer = vi.fn(async () => 'inactive' as const);
    await expect(finishNamedPublishFinalization(store, input, { transfer }))
      .resolves.toBe('pending');
    expect(transfer).toHaveBeenCalledWith('original-share');
    expect(await readNamedPublishFinalization(store, input)).toMatchObject({ kind: 'pending',
      checkpoint: { catalogRequired: true, shareOperationId: 'original-share' } });
    await finishNamedPublishFinalization(store, input, { transfer: async () => 'owned' });
    expect(await readNamedPublishFinalization(store, input)).toEqual({ kind: 'complete' });
  });


  it('never routes a record-only publish onto the update path', async () => {
    const { agent, store, updateKnowledgeCollection } = await strandedAsset(new MockChainAdapter());
    await agent.reconcileKnowledgeAssetMint(RECONCILE);
    // A new complete share of the published asset, as an edit cycle leaves it.
    await store.insert([{ subject: LIFECYCLE, predicate: SWM_SHARE_COMPLETE_PRED, object: '"true"', graph: META_GRAPH }]);

    await expect(withAssertionLifecycleWriteLease((agent as any).writeLocks,
      assertionLifecycleWriteLockKey(CONTEXT_GRAPH, NAME, AUTHOR), async heldLifecycle => {
        const reservation = await readFinalizedAssertionReservation(store, { contextGraphId: CONTEXT_GRAPH, name: NAME, agentAddress: AUTHOR }, 'test');
        return publicationStages.recordFinalizedAssertionMint.call(agent, CONTEXT_GRAPH, NAME, {}, { heldLifecycle, reservation }, { agentAddress: AUTHOR });
      }))
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
    const second = await strandAuthorAsset(first.agent, chain, otherAuthor);

    await expect(first.agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: 'AMBIGUOUS_ASSERTION_AUTHOR' });
    await expect(first.agent.reconcileKnowledgeAssetMint({ ...RECONCILE, selectedAuthorAgentAddress: otherAuthor.address }))
      .resolves.toMatchObject({ status: 'adopted', ual: second.sealed.kaUal, txHash: second.lostMint.txHash });

    expect(await second.history()).toMatchObject({ status: 'vm-confirmed', publishedUal: second.sealed.kaUal });
    expect(await first.history()).toMatchObject({ status: 'swm-shared' });
    await expect(first.agent.reconcileKnowledgeAssetMint({ ...RECONCILE, selectedAuthorAgentAddress: AUTHOR }))
      .resolves.toMatchObject({ status: 'adopted', ual: first.sealed.kaUal, txHash: first.lostMint.txHash });
  });


  it('fails retryably when the record-only publish does not confirm', async () => {
    const { agent } = await strandedAsset(new MockChainAdapter());
    const reconcile = mintReconciliation.reconcileLateMint;
    vi.spyOn(mintReconciliation, 'reconcileLateMint').mockImplementation((host, input) => reconcile(
      { ...host, recordMint: vi.fn<KnowledgeAssetMintReconcileHost['recordMint']>().mockResolvedValueOnce({ status: 'tentative' } as never) }, input));

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE, message: expect.stringMatching(/ended tentative/) });
  });


  it('refuses to complete a lifecycle without an on-chain context graph', async () => {
    const { agent } = await strandedAsset(new MockChainAdapter());
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

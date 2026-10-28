import { contextGraphFinalizationTopic } from '@origintrail-official/dkg-core';
import { generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import * as mintReconciliation from '../src/knowledge-asset-mint-reconcile.js';
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
  VM_CURRENT_ASSERTION_PRED,
  computeFlatKCRootV10,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
  withMaterializationLock,
  writeMaterializedVersion
} from '@origintrail-official/dkg-publisher';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KA_MINT_RECONCILE_INCOMPLETE_CODE, KA_MINT_RECONCILE_REFUSED_CODE } from '../src/index.js';

import { AUTHOR, CONTEXT_GRAPH, LIFECYCLE, META_GRAPH, NAME, NAMED_FINALIZATION_GRAPH, ON_CHAIN_CONTEXT_GRAPH, PUBLISHED_UAL_PRED, QUADS, RECONCILE, RESERVED_KA_ID, ZERO, failNextLifecycleWrite, receiptTxHashes, strandedAsset } from './support/late-mint-fixture.js';

describe('late-mint concurrency', () => {
  afterEach(() => vi.restoreAllMocks());
  /** The newer materializer writes under the same per-KA lock as UpdateHandler. */
  async function consumedMintWithNewerMaterializer() {
    const chain = new MockChainAdapter();
    const f = await strandedAsset(chain);
    failNextLifecycleWrite(f.agent, f.store, VM_CURRENT_ASSERTION_PRED);
    await expect(f.agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    return newerMaterializer(f, chain);
  }
  async function newerMaterializer(f: Awaited<ReturnType<typeof strandedAsset>>, chain: MockChainAdapter) {
    const record = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(f.store,
      { contextGraphId: CONTEXT_GRAPH, ual: f.sealed.kaUal });
    if (record.state !== 'confirmed') throw new Error('fixture must hold the consumed mint');
    const vmGraph = record.envelope.assertionGraph;
    const quad = { ...QUADS[0]!, object: '"Version two"', graph: vmGraph };
    const root = computeFlatKCRootV10([{ ...quad, graph: '' }], []);
    const write = async () => {
      await chain.updateKnowledgeCollectionV10({ kaId: RESERVED_KA_ID, newMerkleRoot: root,
        newByteSize: 1n, newMerkleLeafCount: 1, authorAddress: AUTHOR, authorR: ZERO, authorVS: ZERO });
      await f.store.deleteByPattern({ graph: vmGraph });
      await f.store.deleteByPattern({ subject: f.sealed.kaUal, graph: META_GRAPH });
      await f.store.insert([quad, ...generateGraphKnowledgeAssetMetadata({
        ual: f.sealed.kaUal, contextGraphId: CONTEXT_GRAPH, merkleRoot: root,
        publisherPeerId: 'newer-materializer', accessPolicy: 'public', allowedPeers: [], timestamp: new Date(0),
        assertionVersion: 2, authorAddress: AUTHOR, publicTripleCount: 1, privateTripleCount: 0,
        assertionGraph: vmGraph,
      }, { status: 'confirmed', confirmation: { kind: 'finalized-materialization',
        provenance: { batchId: RESERVED_KA_ID, materializedVersion: { blockNumber: 200, txIndex: 0 } } } })]);
      await writeMaterializedVersion(f.store, META_GRAPH, f.sealed.kaUal, { blockNumber: 200, txIndex: 0 });
    };
    return { ...f, chain, write, root };
  }

  it('refuses resident completion when a newer VM commits during finalization gossip', async () => {
    const chain = new MockChainAdapter(), f = await strandedAsset(chain);
    const entered = Promise.withResolvers<void>(), continued = Promise.withResolvers<void>();
    const publish = f.agent.gossip.publish.bind(f.agent.gossip);
    vi.spyOn(f.agent.gossip, 'publish').mockImplementation(async (...args) => {
      if (args[0] === contextGraphFinalizationTopic(CONTEXT_GRAPH)) { entered.resolve(); await continued.promise; }
      return publish(...args);
    });
    const stamp = vi.spyOn(f.agent, 'publishedNamedKaVmLifecycleWriter');
    const recovery = f.agent.reconcileKnowledgeAssetMint(RECONCILE);
    const outcome = recovery.then(value => ({ value }), error => ({ error }));
    try {
      await Promise.race([entered.promise, recovery.then(() => { throw new Error('missing finalization gossip'); })]);
      const newer = await newerMaterializer(f, chain);
      await withMaterializationLock(META_GRAPH, f.sealed.kaUal, newer.write);
      continued.resolve();
      expect(await outcome).toMatchObject({ error: { reason: 'superseded' } });
      expect(stamp).not.toHaveBeenCalled();
      expect((await f.history())?.vmCurrentAssertion).toBeUndefined();
      expect(await readConfirmedGraphKnowledgeAssetMetadataEnvelope(f.store,
        { contextGraphId: CONTEXT_GRAPH, ual: f.sealed.kaUal }))
        .toMatchObject({ state: 'confirmed', envelope: { assertionVersion: '2', merkleRoot: newer.root } });
    } finally { continued.resolve(); await outcome; }
  });

  it('holds resident completion custody until the lifecycle stamp finishes', async () => {
    const chain = new MockChainAdapter(), f = await strandedAsset(chain);
    const entered = Promise.withResolvers<void>(), continued = Promise.withResolvers<void>();
    const writeLifecycle = f.agent.publishedNamedKaVmLifecycleWriter;
    const order: string[] = [];
    vi.spyOn(f.agent, 'publishedNamedKaVmLifecycleWriter').mockImplementation(async value => {
      entered.resolve(); await continued.promise; await writeLifecycle(value); order.push('stamp');
    });
    const recovery = f.agent.reconcileKnowledgeAssetMint(RECONCILE);
    let update: Promise<void> | undefined;
    try {
      await Promise.race([entered.promise, recovery.then(() => { throw new Error('missing lifecycle completion'); })]);
      const newer = await newerMaterializer(f, chain);
      update = withMaterializationLock(META_GRAPH, f.sealed.kaUal, async () => { order.push('update'); await newer.write(); });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(order, 'the newer writer must wait until resident completion finishes').toEqual([]);
      continued.resolve();
      await expect(recovery).resolves.toMatchObject({ status: 'adopted' });
      await update;
      expect(order).toEqual(['stamp', 'update']);
    } finally { continued.resolve(); await Promise.allSettled([recovery, ...(update ? [update] : [])]); }
  });

  it('leaves a draft that pull-from reopened while reconcile waited for the lifecycle lock', async () => {
    const { agent, store, history } = await strandedAsset(new MockChainAdapter());
    await agent.reconcileKnowledgeAssetMint(RECONCILE);
    // A recorded VM copy whose completion metadata needs repair; pull-from can use that proof.
    await store.deleteByPattern({ subject: LIFECYCLE, predicate: PUBLISHED_UAL_PRED, graph: META_GRAPH });
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


  it('refuses a mint superseded after evidence preparation without recording VM or consuming the share', async () => {
    const chain = new MockChainAdapter();
    const { agent, store, history, createKnowledgeAssets } = await strandedAsset(chain);
    const version = chain.readKnowledgeAssetVersionSnapshot.bind(chain);
    vi.spyOn(chain, 'readKnowledgeAssetVersionSnapshot').mockImplementationOnce(async id => {
      const original = await version(id);
      await chain.updateKnowledgeCollectionV10({ kaId: id, newMerkleRoot: new Uint8Array(32).fill(9),
        newByteSize: 1n, newMerkleLeafCount: 1, authorAddress: AUTHOR, authorR: ZERO, authorVS: ZERO });
      return original;
    });
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ reason: 'superseded' });
    expect(await history()).toMatchObject({ status: 'swm-shared' });
    expect((await history())?.vmCurrentAssertion).toBeUndefined();
    expect(await receiptTxHashes(store)).toEqual([]);
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
    const checkpoints = await store.query(`SELECT ?s WHERE { GRAPH <${NAMED_FINALIZATION_GRAPH}> { ?s ?p ?o } }`);
    expect(checkpoints.type === 'bindings' && checkpoints.bindings).toEqual([]);
  });


  it('refuses a consumed-share lifecycle completion superseded after evidence preparation', async () => {
    const chain = new MockChainAdapter();
    const { agent, store, history, createKnowledgeAssets } = await strandedAsset(chain);
    failNextLifecycleWrite(agent, store, VM_CURRENT_ASSERTION_PRED);
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    const receipts = await receiptTxHashes(store);
    expect(await agent.publisher.hasSwmShareComplete(CONTEXT_GRAPH, NAME, AUTHOR)).toBe(false);
    const version = chain.readKnowledgeAssetVersionSnapshot.bind(chain);
    vi.spyOn(chain, 'readKnowledgeAssetVersionSnapshot').mockImplementationOnce(async id => {
      const original = await version(id);
      await chain.updateKnowledgeCollectionV10({ kaId: id, newMerkleRoot: new Uint8Array(32).fill(9),
        newByteSize: 1n, newMerkleLeafCount: 1, authorAddress: AUTHOR, authorR: ZERO, authorVS: ZERO });
      return original;
    });
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ reason: 'superseded' });

    expect((await history())?.vmCurrentAssertion).toBeUndefined();
    expect(await receiptTxHashes(store)).toEqual(receipts);
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
  });


  it('keeps consumed-share completion exclusive until its lifecycle stamp finishes', async () => {
    const f = await consumedMintWithNewerMaterializer();
    let entered!: () => void, resume!: () => void;
    const finalizing = new Promise<void>(resolve => { entered = resolve; });
    const continued = new Promise<void>(resolve => { resume = resolve; });
    const order: string[] = [];
    const reconcile = mintReconciliation.reconcileLateMint;
    vi.spyOn(mintReconciliation, 'reconcileLateMint').mockImplementation((host, input) => reconcile({ ...host,
      completeFinalization: async value => { entered(); await continued; return host.completeFinalization(value); },
      stampPublishedLifecycle: async value => { await host.stampPublishedLifecycle(value); order.push('stamp'); },
    }, input));
    const recovery = f.agent.reconcileKnowledgeAssetMint(RECONCILE);
    let update: Promise<void> | undefined;
    try {
      await Promise.race([finalizing, recovery.then(() => { throw new Error('completion bypassed finalization'); })]);
      update = withMaterializationLock(META_GRAPH, f.sealed.kaUal, async () => {
        order.push('update'); await f.write();
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(order, 'newer materialization must wait for the verified lifecycle completion').toEqual([]);
      resume();
      await expect(recovery).resolves.toMatchObject({ status: 'adopted' });
      await update;
      expect(order).toEqual(['stamp', 'update']);
      expect(await readConfirmedGraphKnowledgeAssetMetadataEnvelope(f.store,
        { contextGraphId: CONTEXT_GRAPH, ual: f.sealed.kaUal }))
        .toMatchObject({ state: 'confirmed', envelope: { assertionVersion: '2', merkleRoot: f.root } });
    } finally { resume(); await Promise.allSettled([recovery, ...(update ? [update] : [])]); }
  });


  it('revalidates consumed-share evidence after waiting for a newer materializer', async () => {
    const f = await consumedMintWithNewerMaterializer();
    let entered!: () => void, release!: () => void, prepared!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const continueUpdate = new Promise<void>(resolve => { release = resolve; });
    const evidenceRead = new Promise<void>(resolve => { prepared = resolve; });
    const update = withMaterializationLock(META_GRAPH, f.sealed.kaUal, async () => {
      entered(); await continueUpdate; await f.write();
    });
    await locked;
    const version = f.chain.readKnowledgeAssetVersionSnapshot.bind(f.chain);
    vi.spyOn(f.chain, 'readKnowledgeAssetVersionSnapshot').mockImplementationOnce(async id => {
      const result = await version(id); prepared(); return result;
    });
    const stamp = vi.spyOn(f.agent, 'publishedNamedKaVmLifecycleWriter').mockClear();
    const recovery = f.agent.reconcileKnowledgeAssetMint(RECONCILE);
    const outcome = recovery.then(value => ({ value }), error => ({ error }));
    try {
      await Promise.race([evidenceRead, recovery.then(() => { throw new Error('missing mint evidence'); })]);
      await new Promise<void>(resolve => setImmediate(resolve));
      release(); await update;
      expect(await outcome).toMatchObject({ error: { reason: 'superseded' } });
      expect(stamp).not.toHaveBeenCalled();
      expect((await f.history())?.vmCurrentAssertion).toBeUndefined();
    } finally { release(); await Promise.allSettled([recovery, update]); }
  });


  it('preserves a resident share reopened by pull-from while mint lookup is pending', async () => {
    const chain = new MockChainAdapter();
    const { agent, store, history, createKnowledgeAssets } = await strandedAsset(chain);
    const lookup = chain.resolveKnowledgeAssetMint.bind(chain);
    vi.spyOn(chain, 'resolveKnowledgeAssetMint').mockImplementationOnce(async (...args) => {
      // This takes the same lifecycle lock. Lookup must be outside it.
      await agent.assertion.pullFrom(CONTEXT_GRAPH, NAME, 'swm', { agentAddress: AUTHOR, onConflict: 'replace' });
      return lookup(...args);
    });
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .rejects.toMatchObject({ code: KA_MINT_RECONCILE_REFUSED_CODE, message: expect.stringMatching(/removed while reconcile waited/) });
    expect(await history()).toMatchObject({ state: 'created', memoryLayer: 'WM' });
    expect((await history())?.publishedUal).toBeUndefined();
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
    const rows = await store.query(`SELECT ?s WHERE { GRAPH <${NAMED_FINALIZATION_GRAPH}> { ?s ?p ?o } }`);
    expect(rows.type === 'bindings' && rows.bindings).toEqual([]);
  });


  it('reads mint evidence outside the lifecycle lock, so pull-from finishes during a slow lookup', async () => {
    const chain = new MockChainAdapter();
    const { agent, store, history } = await strandedAsset(chain);
    await agent.reconcileKnowledgeAssetMint(RECONCILE);
    // A recorded VM copy whose completion metadata needs repair; pull-from can use that proof.
    await store.deleteByPattern({ subject: LIFECYCLE, predicate: PUBLISHED_UAL_PRED, graph: META_GRAPH });
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


});

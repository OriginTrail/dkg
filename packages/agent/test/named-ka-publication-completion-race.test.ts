// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, assertionLifecycleUri, contextGraphMetaUri, createGraphKnowledgeAssetScope, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher, TripleStoreAsyncLiftPublisher, computeFlatKCRootV10, resolveKnowledgeAssetWorkspaceHead, storeKnowledgeAssetOperationPublicQuads } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';

const AUTHOR = '0x1111111111111111111111111111111111111111', CG = 'completion-race', NAME = 'notes';
const DKG = 'http://dkg.io/ontology/';
const payload = [{ subject: 'urn:original', predicate: 'urn:title', object: '"original"', graph: '' }];
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });

async function fixture(alias = false) {
  const store = new OxigraphStore(); stores.push(store);
  const publisher = new DKGPublisher({ store, chain: new NoChainAdapter(), eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
  await publisher.assertionCreate(CG, NAME, AUTHOR); await publisher.assertionWrite(CG, NAME, AUTHOR, payload);
  const first = await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR, assertionVersion: 1 });
  const promoted = await publisher.assertionPromote(CG, NAME, AUTHOR, { publisherPeerId: 'publisher-peer', localOnly: true });
  const scope = createGraphKnowledgeAssetScope(first.kaUal, 1), packed = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
  if (alias) {
    const graphManager = new GraphManager(store), selectedAlias = 'storage-ack-alias';
    await storeKnowledgeAssetOperationPublicQuads({ store, graphManager, contextGraphId: CG, shareOperationId: selectedAlias,
      kaUal: first.kaUal, assertionVersion: 1, quads: first.publicQuads, privateTripleCount: 0,
      accessPolicy: 'public', publisherPeerId: 'publisher-peer', timestamp: new Date(Date.now() + 1_000) });
    await store.insert([{ graph: graphManager.sharedMemoryMetaUri(CG), subject: `${first.kaUal}#dkg-swm-head`, predicate: `${DKG}shareOperationId`, object: JSON.stringify(selectedAlias) }]);
    expect(await resolveKnowledgeAssetWorkspaceHead({ store, graphManager, contextGraphId: CG, kaUal: first.kaUal })).toMatchObject({ shareOperationId: selectedAlias });
  }
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.store = store; agent.publisher = publisher; agent.chain = {}; agent.config = {}; agent.defaultAgentAddress = AUTHOR;
  agent.log = { warn() {}, info() {}, debug() {}, error() {} };
  Object.defineProperty(agent, 'peerId', { value: 'publisher-peer' });
  agent.createV10ACKProvider = () => undefined; agent._resolveEncryptInlinePayload = async () => undefined; agent._resolveEncryptInlineChunked = async () => undefined;
  agent.afterConfirmedGraphScopedVmPublishV1 = async () => undefined; agent.gossip = { publish: async () => undefined };
  agent.publishFromSharedMemory = publisher.publishFromSharedMemory.bind(publisher);
  const replace = async () => {
    await publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm');
    await publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:replacement', predicate: 'urn:title', object: '"replacement"', graph: '' }]);
    await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR, assertionVersion: 1 });
    return publisher.assertionPromote(CG, NAME, AUTHOR, { publisherPeerId: 'publisher-peer', localOnly: true });
  };
  const result = { status: 'confirmed' as const, ual: first.kaUal, kaId: packed, merkleRoot: computeFlatKCRootV10(first.publicQuads, []), kaManifest: [], publicQuads: first.publicQuads, onChainResult: { txHash: `0x${'ab'.repeat(32)}`, blockNumber: 1, blockTimestamp: 1, batchId: packed, kaId: packed, startKAId: packed, endKAId: packed, publisherAddress: AUTHOR } };
  return { store, publisher, agent, first, promoted, replace, result };
}

describe('agent publication completion marker fencing', () => {
  it.each(['synchronous', 'queued'] as const)('clears the original lifecycle marker when %s publication selects an equivalent ACK alias', async (lane) => {
    const f = await fixture(true), clear = vi.spyOn(f.publisher, 'clearSwmShareComplete');
    vi.spyOn(f.publisher, 'publish').mockResolvedValueOnce(f.result);
    if (lane === 'synchronous') await f.agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AUTHOR });
    else {
      const request = await f.agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: AUTHOR });
      expect(request.shareOperationId).toBe(f.promoted.shareOperationId);
      const queue = new TripleStoreAsyncLiftPublisher(f.store, { knowledgeAssetVmPublishHandler: { execute: ({ request, publishOptions }) => f.agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions) } });
      await queue.enqueueKnowledgeAssetVmPublish(request); const completed = await queue.processNext('wallet'); expect(completed).toMatchObject({ status: 'finalized' });
    }
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(false);
    expect(clear.mock.calls.at(-1)?.[4]).toBe(f.promoted.shareOperationId);
  });

  it.each(['synchronous', 'queued'] as const)('preserves a promoted replacement while %s confirmation is held', async (lane) => {
    const f = await fixture(), clear = vi.spyOn(f.publisher, 'clearSwmShareComplete');
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(f.publisher, 'publish').mockImplementationOnce(async () => { entered(); await held; return f.result; });
    let publishing: Promise<unknown>;
    if (lane === 'synchronous') publishing = f.agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AUTHOR });
    else {
      const request = await f.agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: AUTHOR });
      const queue = new TripleStoreAsyncLiftPublisher(f.store, { knowledgeAssetVmPublishHandler: { execute: ({ request, publishOptions }) => f.agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions) } });
      await queue.enqueueKnowledgeAssetVmPublish(request); publishing = queue.processNext('wallet');
    }
    await started;
    let replacement: Awaited<ReturnType<typeof f.replace>>;
    try { replacement = await f.replace(); } finally { release(); }
    const completed = await publishing;
    if (lane === 'queued') expect(completed).toMatchObject({ status: 'finalized' });
    expect(replacement!.shareOperationId).not.toBe(f.promoted.shareOperationId);
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    expect(clear.mock.calls.at(-1)?.[4]).toBe(f.promoted.shareOperationId);
    expect(await f.store.countQuads(f.first.sharedGraphUri)).toBe(2);
  });

  it.each([false, true])('fences a captured legacy marker without an operation ID (replacement: %s)', async (replacement) => {
    const f = await fixture();
    const subject = assertionLifecycleUri(CG, AUTHOR, NAME), graph = contextGraphMetaUri(CG);
    await f.store.deleteByPattern({ subject, graph, predicate: `${DKG}shareOperationId` });
    if (replacement) await f.store.insert([{ subject, graph, predicate: `${DKG}shareOperationId`, object: '"replacement-share"' }]);
    await f.publisher.clearSwmShareComplete(CG, NAME, AUTHOR, undefined, null);
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(replacement);
  });

  it('rejects a lifecycle operation outside the selected head equivalence class before publication', async () => {
    const f = await fixture(), publish = vi.spyOn(f.publisher, 'publish');
    const subject = assertionLifecycleUri(CG, AUTHOR, NAME), graph = contextGraphMetaUri(CG);
    await f.store.deleteByPattern({ subject, graph, predicate: `${DKG}shareOperationId` });
    await f.store.insert([{ subject, graph, predicate: `${DKG}shareOperationId`, object: '"unrelated-share"' }]);
    await expect(f.agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AUTHOR })).rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });
    expect(publish).not.toHaveBeenCalled(); expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
  });
});

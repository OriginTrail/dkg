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

async function fixture(alias = false, updating = false) {
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
  agent.localAgents = new Map();
  agent.log = { warn() {}, info() {}, debug() {}, error() {} };
  Object.defineProperty(agent, 'peerId', { value: 'publisher-peer' });
  agent.createV10ACKProvider = () => undefined; agent._resolveEncryptInlinePayload = async () => undefined; agent._resolveEncryptInlineChunked = async () => undefined;
  agent.afterConfirmedGraphScopedVmPublishV1 = async () => undefined; agent.gossip = { publish: async () => undefined };
  // Resolve chain metadata externally; keep the inherited agent publication path intact.
  agent.getContextGraphOnChainId = async () => undefined;
  if (updating) {
    await store.insert([{ graph: contextGraphMetaUri(CG), subject: assertionLifecycleUri(CG, AUTHOR, NAME),
      predicate: `${DKG}vmCurrentAssertion`, object: JSON.stringify('ff'.repeat(32)) }]);
    // Keep inherited update routing, provenance, pointer writes and completion;
    // only the signature/chain submission boundaries are supplied by the fixture.
    agent._buildPrecomputedUpdateAttestationForSeal = async () => ({});
    agent._canReSignUpdateAttestationForAuthor = async () => true;
  }
  const replace = async (sameContent = false) => {
    await publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm');
    if (!sameContent) await publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:replacement', predicate: 'urn:title', object: '"replacement"', graph: '' }]);
    await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR, assertionVersion: 1 });
    return publisher.assertionPromote(CG, NAME, AUTHOR, { publisherPeerId: 'publisher-peer', localOnly: true });
  };
  const result = { status: 'confirmed' as const, ual: first.kaUal, kaId: packed, merkleRoot: computeFlatKCRootV10(first.publicQuads, []), kaManifest: [], publicQuads: first.publicQuads, onChainResult: { txHash: `0x${'ab'.repeat(32)}`, blockNumber: 1, blockTimestamp: 1, batchId: packed, kaId: packed, startKAId: packed, endKAId: packed, publisherAddress: AUTHOR } };
  return { store, publisher, agent, first, promoted, replace, result };
}

describe('agent publication completion marker fencing', () => {
  it.each(['synchronous', 'queued'] as const)('clears the original lifecycle marker when %s publication selects an equivalent ACK alias', async (lane) => {
    const f = await fixture(true), clear = vi.spyOn(f.publisher, 'consumePublishedSwmShareComplete');
    vi.spyOn(f.publisher, 'publish').mockResolvedValueOnce(f.result);
    if (lane === 'synchronous') await f.agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AUTHOR });
    else {
      const request = await f.agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: AUTHOR });
      expect(request.shareOperationId).toBe(f.promoted.shareOperationId);
      const queue = new TripleStoreAsyncLiftPublisher(f.store, { knowledgeAssetVmPublishHandler: { execute: ({ request, publishOptions }) => f.agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions) } });
      await queue.enqueueKnowledgeAssetVmPublish(request); const completed = await queue.processNext('wallet'); expect(completed).toMatchObject({ status: 'finalized' });
    }
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(false);
    expect(clear.mock.calls.at(-1)?.[3]).toBe(f.promoted.shareOperationId);
  });

  it.each([['synchronous', false], ['queued', false], ['synchronous', true], ['queued', true]] as const)('preserves a promoted replacement while %s confirmation is held (same content: %s)', async (lane, sameContent) => {
    const f = await fixture(), clear = vi.spyOn(f.publisher, 'consumePublishedSwmShareComplete');
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
    try { replacement = await f.replace(sameContent); } finally { release(); }
    const completed = await publishing;
    if (lane === 'queued') expect(completed).toMatchObject({ status: 'finalized' });
    expect(replacement!.shareOperationId).not.toBe(f.promoted.shareOperationId);
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    expect(clear.mock.calls.at(-1)?.[3]).toBe(f.promoted.shareOperationId);
    expect(await f.store.countQuads(f.first.sharedGraphUri)).toBe(sameContent ? 1 : 2);
    expect(await resolveKnowledgeAssetWorkspaceHead({ store: f.store, graphManager: new GraphManager(f.store), contextGraphId: CG, kaUal: f.first.kaUal }))
      .toMatchObject({ shareOperationId: replacement!.shareOperationId });
  });

  it.each((['synchronous', 'queued'] as const).flatMap(lane =>
    (['public', 'private', 'unchanged'] as const).flatMap(change => [false, true].map(updating => ({ lane, change, updating })))))(
    'finishes $lane publication while a $change replacement awaits curator confirmation (update: $updating)', async ({ lane, change, updating }) => {
      const f = await fixture(false, updating);
      const lifecycle = assertionLifecycleUri(CG, AUTHOR, NAME), graph = contextGraphMetaUri(CG);
      let releasePublication!: () => void, publicationEntered!: () => void;
      const publicationHeld = new Promise<void>(resolve => { releasePublication = resolve; });
      const publicationStarted = new Promise<void>(resolve => { publicationEntered = resolve; });
      const submission = updating ? vi.spyOn(f.agent, 'update') : vi.spyOn(f.publisher, 'publish');
      submission.mockImplementationOnce(async () => { publicationEntered(); await publicationHeld; return f.result; });
      const publishing = (async () => {
        if (lane === 'synchronous') return f.agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AUTHOR });
        const request = await f.agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: AUTHOR });
        const queue = new TripleStoreAsyncLiftPublisher(f.store, { knowledgeAssetVmPublishHandler: { execute: ({ request, publishOptions }) => f.agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions) } });
        await queue.enqueueKnowledgeAssetVmPublish(request); return queue.processNext('wallet');
      })();
      await Promise.race([publicationStarted, publishing.then(value => {
        throw new Error(`Publication settled before reaching held chain submission: ${JSON.stringify(value)}`);
      })]);
      let releaseCurator: () => void = () => undefined;
      let promotion: Promise<{ value: Awaited<ReturnType<DKGPublisher['assertionPromote']>>; error?: never } | { error: unknown; value?: never }> | undefined;
      if (change !== 'unchanged') {
        await f.publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm');
        if (change === 'public') await f.publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:next', predicate: 'urn:title', object: '"next"', graph: '' }]);
        else await f.publisher.assertionWritePrivate(CG, NAME, AUTHOR, [{ subject: 'urn:secret', predicate: 'urn:title', object: '"private replacement"', graph: '' }]);
        await finalizeRootlessAssertionForTest({ publisher: f.publisher, store: f.store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR, assertionVersion: 1 });
        let curatorEntered!: () => void;
        const curatorHeld = new Promise<void>(resolve => { releaseCurator = resolve; });
        const curatorStarted = new Promise<void>(resolve => { curatorEntered = resolve; });
        promotion = f.publisher.assertionPromote(CG, NAME, AUTHOR, { publisherPeerId: 'publisher-peer',
          confirmBeforeCommit: async () => { curatorEntered(); await curatorHeld; return { applied: true }; } })
          .then(value => ({ value }), error => ({ error }));
        await curatorStarted;
      }
      releasePublication();
      try {
        const completed = await Promise.race([publishing.then(value => ({ value })), new Promise<{ timedOut: true }>(resolve => setTimeout(() => resolve({ timedOut: true }), 500))]);
        expect(completed).not.toHaveProperty('timedOut');
        if (!('value' in completed)) throw new Error('Publication completion waited for the replacement curator');
        if (lane === 'queued') expect(completed.value).toMatchObject({ status: 'finalized' });
        const layers = await f.store.query(`SELECT ?layer ?vm WHERE { GRAPH <${graph}> { <${lifecycle}> <${DKG}memoryLayer> ?layer ; <${DKG}vmCurrentAssertion> ?vm } }`);
        expect(layers.type === 'bindings' ? layers.bindings : []).toEqual([{ layer: JSON.stringify(change === 'unchanged' ? 'VM' : 'WM'), vm: JSON.stringify(Buffer.from(f.result.merkleRoot).toString('hex')) }]);
      } finally { releaseCurator(); await publishing; if (promotion) await promotion; }
      if (promotion) {
        const promoted = await promotion; expect(promoted.error).toBeUndefined();
        if (!promoted.value) throw promoted.error;
        expect(promoted.value.shareOperationId).not.toBe(f.promoted.shareOperationId);
        expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
        expect(await f.publisher.assertionPromote(CG, NAME, AUTHOR, { publisherPeerId: 'publisher-peer', confirmBeforeCommit: async () => ({ applied: true }) })).toMatchObject({ shareOperationId: promoted.value.shareOperationId });
        const reopened = await f.publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm');
        expect(reopened.seededPublic).toBe(change === 'public' ? 2 : 1);
        expect(reopened.seededPrivate).toBe(change === 'private' ? 1 : 0);
      } else expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(false);
    });

  it('rechecks draft ownership after publication preflight queues behind a sanctioned reopen', async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const holding = f.publisher.withPublishedAssertionLifecycle(CG, NAME, AUTHOR, f.promoted.shareOperationId!, async () => { entered(); await held; });
    await started;
    const reopening = f.publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm');
    const query = f.store.query.bind(f.store);
    let preflightRead!: () => void;
    const preflight = new Promise<void>(resolve => { preflightRead = resolve; });
    vi.spyOn(f.store, 'query').mockImplementation(async (sparql, options) => {
      const result = await query(sparql, options);
      if (sparql.startsWith('SELECT ?operation')) preflightRead();
      return result;
    });
    const request = { contextGraphId: CG, name: NAME, agentAddress: AUTHOR, shareOperationId: f.promoted.shareOperationId,
      sealMerkleRoot: Buffer.from(f.result.merkleRoot).toString('hex') };
    const completion = f.agent._stampQueuedKnowledgeAssetVmPublishedLifecycle(request, f.result.ual, f.result.kaId);
    await preflight;
    release(); await Promise.all([holding, reopening, completion]);
    const graph = contextGraphMetaUri(CG), subject = assertionLifecycleUri(CG, AUTHOR, NAME);
    const layers = await f.store.query(`SELECT ?layer ?vm WHERE { GRAPH <${graph}> { <${subject}> <${DKG}memoryLayer> ?layer ; <${DKG}vmCurrentAssertion> ?vm } }`);
    expect(layers.type === 'bindings' ? layers.bindings : []).toEqual([{ layer: '"WM"', vm: JSON.stringify(request.sealMerkleRoot) }]);
    expect(await f.publisher.assertionQuery(CG, NAME, AUTHOR)).toHaveLength(1);
  });

  it.each(['conflicting', 'iri', 'empty'] as const)('records confirmed VM history without consuming a %s lifecycle owner', async corruption => {
    const f = await fixture(), graph = contextGraphMetaUri(CG), subject = assertionLifecycleUri(CG, AUTHOR, NAME);
    if (corruption !== 'conflicting') await f.store.deleteByPattern({ graph, subject, predicate: `${DKG}shareOperationId` });
    await f.store.insert([{ graph, subject, predicate: `${DKG}shareOperationId`,
      object: corruption === 'iri' ? 'urn:invalid:operation' : corruption === 'empty' ? '""' : '"another-owner"' }]);
    await f.agent._stampQueuedKnowledgeAssetVmPublishedLifecycle({ contextGraphId: CG, name: NAME, agentAddress: AUTHOR,
      shareOperationId: f.promoted.shareOperationId, sealMerkleRoot: Buffer.from(f.result.merkleRoot).toString('hex') }, f.result.ual, f.result.kaId);
    await f.publisher.consumePublishedSwmShareComplete(CG, NAME, AUTHOR, f.promoted.shareOperationId!);
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    const layer = await f.store.query(`SELECT ?layer WHERE { GRAPH <${graph}> { <${subject}> <${DKG}memoryLayer> ?layer } }`);
    expect(layer.type === 'bindings' ? layer.bindings : []).toEqual([{ layer: '"SWM"' }]);
    const vm = await f.store.query(`SELECT ?vm WHERE { GRAPH <${graph}> { <${subject}> <${DKG}vmCurrentAssertion> ?vm } }`);
    expect(vm.type === 'bindings' ? vm.bindings : []).toEqual([{ vm: JSON.stringify(Buffer.from(f.result.merkleRoot).toString('hex')) }]);
  });

  it.each([false, true])('fences a captured legacy marker without an operation ID (replacement: %s)', async (replacement) => {
    const f = await fixture();
    const subject = assertionLifecycleUri(CG, AUTHOR, NAME), graph = contextGraphMetaUri(CG);
    await f.store.deleteByPattern({ subject, graph, predicate: `${DKG}shareOperationId` });
    if (replacement) await f.store.insert([{ subject, graph, predicate: `${DKG}shareOperationId`, object: '"replacement-share"' }]);
    await f.publisher.consumePublishedSwmShareComplete(CG, NAME, AUTHOR, null);
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(replacement);
  });

  it('keeps unconditional invalidation separate from explicit publication consumption', async () => {
    const f = await fixture();
    // A legacy JS caller cannot accidentally omit the required publication fence.
    await (f.publisher.consumePublishedSwmShareComplete as any)(CG, NAME, AUTHOR);
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    await f.publisher.clearSwmShareComplete(CG, NAME, AUTHOR);
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(false);
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

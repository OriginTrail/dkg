// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, assertionLifecycleUri, contextGraphMetaUri, createGraphKnowledgeAssetScope, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher, TripleStoreAsyncLiftPublisher, computeFlatKCRootV10, resolveKnowledgeAssetWorkspaceHead, storeKnowledgeAssetOperationPublicQuads } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';
import { GossipSession } from '../src/gossip-session.js';
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
  agent.gossipSession = new GossipSession();
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

async function modelLegacyPublicationOwner(f: Awaited<ReturnType<typeof fixture>>) {
  const graph = contextGraphMetaUri(CG), subject = assertionLifecycleUri(CG, AUTHOR, NAME);
  const events = await f.store.query(`SELECT ?event WHERE { GRAPH <${graph}> {
    ?event a <${DKG}AssertionPromoted> ; <http://www.w3.org/ns/prov#used> <${subject}>
  } }`);
  if (events.type !== 'bindings') throw new Error('Legacy fixture promotion events unavailable');
  for (const row of events.bindings) await f.store.deleteByPattern({ graph, subject: row.event!, predicate: `${DKG}shareOperationId` });
  await f.store.deleteByPattern({ graph, subject, predicate: `${DKG}shareOperationId` });
  await f.store.deleteByPattern({ graph, subject, predicate: `${DKG}promoteOperationIntent` });
}

describe('agent publication completion marker fencing', () => {
  it.each(['synchronous', 'queued'].flatMap(lane => [false, true].map(alias => ({ lane, alias }))))('completes $lane publication from a trimmed lifecycle and retained promotion event (ACK alias: $alias)', async ({ lane, alias }) => {
    const f = await fixture(alias), graph = contextGraphMetaUri(CG), subject = assertionLifecycleUri(CG, AUTHOR, NAME);
    const request = await f.agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: AUTHOR });
    await f.store.deleteByPattern({ graph, subject, predicate: `${DKG}shareOperationId` });
    const before = await f.agent.assertion.history(CG, NAME);
    expect(before?.currentShareOperationId).toBeUndefined();
    expect(before?.events.find((event: { type: string }) => event.type === 'promoted')?.shareOperationId).toBe(f.promoted.shareOperationId);
    vi.spyOn(f.publisher, 'publish').mockResolvedValueOnce(f.result);
    if (lane === 'synchronous') await f.agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AUTHOR });
    else {
      await f.publisher.clearPublishedSwmRoots(CG, [...request.roots], undefined, { operationId: 'trimmed-queued-share' } as any);
      const queue = new TripleStoreAsyncLiftPublisher(f.store, { knowledgeAssetVmPublishHandler: { execute: ({ request, publishOptions }) => f.agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions) } });
      await queue.enqueueKnowledgeAssetVmPublish(request); expect(await queue.processNext('wallet')).toMatchObject({ status: 'finalized' });
    }
    expect(await f.agent.assertion.history(CG, NAME)).toMatchObject({ state: 'published', memoryLayer: 'VM' });
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(false);
  });

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

  it.each([false, true])('rechecks draft ownership after publication preflight queues behind a sanctioned reopen (legacy: %s)', async legacy => {
    const f = await fixture();
    if (legacy) {
      await modelLegacyPublicationOwner(f);
    }
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const holding = f.publisher.withPublishedAssertionLifecycle(CG, NAME, AUTHOR, legacy ? null : f.promoted.shareOperationId!, async () => { entered(); await held; });
    await started;
    const reopening = f.publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm');
    const query = f.store.query.bind(f.store);
    let preflightRead!: () => void;
    const preflight = new Promise<void>(resolve => { preflightRead = resolve; });
    vi.spyOn(f.store, 'query').mockImplementation(async (sparql, options) => {
      const result = await query(sparql, options);
      if (sparql.startsWith(legacy ? 'SELECT ?layer' : 'SELECT ?operation')) preflightRead();
      return result;
    });
    const request = { contextGraphId: CG, name: NAME, agentAddress: AUTHOR, shareOperationId: legacy ? undefined : f.promoted.shareOperationId,
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

  it('preserves a reopened unshared draft when the captured legacy publication has no operation ID', async () => {
    const f = await fixture(), graph = contextGraphMetaUri(CG), subject = assertionLifecycleUri(CG, AUTHOR, NAME);
    await modelLegacyPublicationOwner(f);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(f.publisher, 'publish').mockImplementationOnce(async () => { entered(); await held; return f.result; });
    const publishing = f.agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AUTHOR });
    await started;
    await f.publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm');
    await f.publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:unshared', predicate: 'urn:title', object: '"draft"', graph: '' }]);
    release(); await publishing;
    const layers = await f.store.query(`SELECT ?layer WHERE { GRAPH <${graph}> { <${subject}> <${DKG}memoryLayer> ?layer } }`);
    expect(layers.type === 'bindings' ? layers.bindings : []).toEqual([{ layer: '"WM"' }]);
    expect(await f.publisher.assertionQuery(CG, NAME, AUTHOR)).toHaveLength(2);
    // Reopen intentionally retains the prior marker for seal recovery.
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
  });

  it.each([false, true])('fences a captured legacy marker without an operation ID (replacement: %s)', async (replacement) => {
    const f = await fixture();
    const subject = assertionLifecycleUri(CG, AUTHOR, NAME), graph = contextGraphMetaUri(CG);
    await modelLegacyPublicationOwner(f);
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


type OwnershipShape = 'current-over-event' | 'trimmed-event' | 'legacy' | 'conflicting-current' | 'iri-current' | 'empty-current' | 'corrupt-event';
async function operationSelectionFixture(shape: OwnershipShape) {
  const f = await fixture(), graph = contextGraphMetaUri(CG), lifecycle = assertionLifecycleUri(CG, AUTHOR, NAME);
  let request = await f.agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: AUTHOR });
  let expected: string | null | undefined = f.promoted.shareOperationId;
  if (shape === 'current-over-event') {
    const prior = await f.store.query(`CONSTRUCT { ?event ?p ?o } WHERE { GRAPH <${graph}> {
      ?event a <${DKG}AssertionPromoted> ; <${DKG}shareOperationId> ${JSON.stringify(f.promoted.shareOperationId)} ; ?p ?o
    } }`);
    if (prior.type !== 'quads' || prior.quads.length === 0) throw new Error('Expected real prior promotion metadata');
    const current = await f.replace(true);
    request = await f.agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: AUTHOR });
    expected = current.shareOperationId;
    const events = await f.store.query(`SELECT ?event WHERE { GRAPH <${graph}> {
      ?event a <${DKG}AssertionPromoted> ; <${DKG}shareOperationId> ${JSON.stringify(expected)}
    } } LIMIT 2`);
    if (events.type !== 'bindings' || events.bindings.length !== 1) throw new Error('Expected one replacement promotion event');
    await f.store.deleteByPattern({ graph, subject: events.bindings[0]!.event! });
    // Retain the actual old publisher event, as a historical metadata record
    // may remain across a replacement in read-both/imported stores.
    await f.store.insert(prior.quads.map(quad => ({ ...quad, graph })));
    await f.store.deleteByPattern({ graph, subject: lifecycle, predicate: `${DKG}shareOperationId` });
    await f.store.insert([{ graph, subject: lifecycle, predicate: `${DKG}shareOperationId`, object: JSON.stringify(expected) }]);
    // A valid current C row and retained prior B event are one real replacement,
    // not two hand-built seals or a stubbed assertion history response.
    expect((await f.agent.assertion.history(CG, NAME))?.events.filter((event: {type:string}) => event.type === 'promoted'))
      .toEqual([expect.objectContaining({ shareOperationId:f.promoted.shareOperationId })]);
  } else if (shape === 'legacy') {
    await modelLegacyPublicationOwner(f); expected = null;
  } else {
    await f.store.deleteByPattern({ graph, subject: lifecycle, predicate: `${DKG}shareOperationId` });
    if (shape === 'conflicting-current') {
      await f.store.insert([f.promoted.shareOperationId!, 'conflicting-current'].map(id => ({ graph, subject:lifecycle, predicate:`${DKG}shareOperationId`, object:JSON.stringify(id) })));
      expected = undefined;
    } else if (shape === 'iri-current' || shape === 'empty-current') {
      await f.store.insert([{ graph, subject:lifecycle, predicate:`${DKG}shareOperationId`, object:shape === 'iri-current' ? 'urn:invalid:operation' : '""' }]);
      expected = undefined;
    } else if (shape === 'corrupt-event') {
      const events = await f.store.query(`SELECT ?event WHERE { GRAPH <${graph}> {
        ?event a <${DKG}AssertionPromoted> ; <${DKG}shareOperationId> ${JSON.stringify(f.promoted.shareOperationId)}
      } } LIMIT 2`);
      if (events.type !== 'bindings' || events.bindings.length !== 1) throw new Error('Expected one retained promotion event');
      const event = events.bindings[0]!.event!;
      await f.store.deleteByPattern({ graph, subject:event, predicate:'http://www.w3.org/ns/prov#startedAtTime' });
      await f.store.insert([{ graph, subject:event, predicate:'http://www.w3.org/ns/prov#startedAtTime', object:'"not-a-date"' }]);
      expected = undefined;
    }
  }
  return { ...f, request, expected };
}

describe('publisher-owned operation selection across publication lanes', () => {
  const shapes: OwnershipShape[] = ['current-over-event', 'trimmed-event', 'legacy', 'conflicting-current', 'iri-current', 'empty-current', 'corrupt-event'];
  it.each(shapes.flatMap(shape => (['admission', 'preflight', 'recovery', 'completion'] as const).map(lane => ({shape,lane}))))(
    'applies one selection policy for $shape during $lane', async ({shape,lane}) => {
      const f = await operationSelectionFixture(shape);
      if (lane === 'admission') {
        const admission = f.agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress:AUTHOR });
        if (typeof f.expected === 'string') expect((await admission).shareOperationId).toBe(f.expected);
        else await expect(admission).rejects.toMatchObject({code:'PUBLISH_INTENT_STALE'});
      } else if (lane === 'preflight') {
        const preflight = f.agent.preflightQueuedKnowledgeAssetVmPublishExecution(f.request);
        if (typeof f.expected === 'string') await expect(preflight).resolves.toMatchObject({action:'execute'});
        else await expect(preflight).rejects.toMatchObject({code:'PUBLISH_INTENT_STALE'});
      } else if (lane === 'recovery') {
        expect(await f.agent._canStampRecoveredKnowledgeAssetVmLifecycle(f.request)).toBe(typeof f.expected === 'string');
      } else {
        const consume = vi.spyOn(f.publisher,'consumePublishedSwmShareComplete');
        const publish = vi.spyOn(f.publisher,'publish').mockResolvedValueOnce(f.result);
        const completion = f.agent.publishFromFinalizedAssertion(CG, NAME, {agentAddress:AUTHOR});
        if (f.expected === undefined) {
          await expect(completion).rejects.toMatchObject({code:'PUBLISH_INTENT_STALE'});
          expect(publish).not.toHaveBeenCalled();
          expect(consume).not.toHaveBeenCalled();
        } else {
          await completion;
          expect(consume.mock.calls.at(-1)?.[3]).toBe(f.expected);
        }
        expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(f.expected === undefined);
        // Synchronous publication supports an explicitly absent legacy owner,
        // while corrupt modern ownership must fail before chain submission.
      }
    });
});

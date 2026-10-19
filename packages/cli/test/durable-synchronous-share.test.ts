import { RemoteSignerError } from '@origintrail-official/dkg-chain';
import { createServer } from 'node:http';
import { Wallet } from 'ethers';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { requestAuthentication } from './_helpers/request-authentication.js';
import { executePromoteRequest } from '../src/daemon/worker/execute-promote-request.js';
import { inventoryPersistenceFailure } from '../../agent/src/rfc64/inventory-persistence-failure.js';
import { SwmCatalogAuthorityNotReady, SwmInventoryWriteFailure } from '../../agent/src/internal/swm-inventory-write.js';
import { ConfirmedVmOwnershipFailure } from '../../agent/src/internal/confirmed-vm-catalog-observer.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from '../../agent/src/rfc64/swm-inventory-shadow-runtime-v1.js';
import { resolveRfc64CatalogAuthoringPolicyV1 } from '../../agent/src/rfc64/public-catalog-activation-config-v1.js';
import { classifySynchronousShareFailure } from '../src/daemon/routes/durable-share-response.js';
import { DurableShareFailure, observeShareRecovery } from '../src/daemon/routes/durable-share-failure.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-agent', () => import('../../agent/src/index.js'));
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { computeCanonicalGraphScopedAuthorSealDigestV1, assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { BlazegraphStore, OxigraphStore, StoreOperationTimeoutError, StoreSchedulerBusyError, UnsupportedTripleStoreCapabilityError, type Quad } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue, CuratorRejectedError, CuratorUnconfirmedError, PromoteAdmissionUncertainError,
  computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata, skolemizeKnowledgeAssetParts } from '@origintrail-official/dkg-publisher';
import { createPromotionAgentForTest } from '../../agent/test/_helpers/promotion-agent.js';
import { makeTestKaNumberAllocator } from '../../agent/test/_helpers/ka-allocator.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { durableSynchronousShare } from '../src/daemon/routes/durable-synchronous-share.js';
import { daemonState } from '../src/daemon/state.js';
import { createPromoteWorkerSupervisor, runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';

const signer = new Wallet(`0x${'11'.repeat(32)}`);
const CG = 'durable-sync-2963', NAME = 'asset', AUTHOR = signer.address.toLowerCase();
const lifecycle = assertionLifecycleUri(CG, AUTHOR, NAME);
class FaultStore extends OxigraphStore {
  remaining = 0;
  typed = true;
  override async insert(quads: Quad[]): Promise<void> {
    if (this.remaining && quads.some(q => q.subject === lifecycle && q.predicate.endsWith('/state') && q.object === '"promoted"')) {
      this.remaining--;
      throw this.typed ? new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'test.lifecycleInsert', { storeOperation: 'insert' })
        : new Error('interrupted after lifecycle deletion');
    }
    return super.insert(quads);
  }
}
async function setup() {
  const store = new FaultStore();
  const options = { agentAddress: AUTHOR, peerId: '12D3KooWRecovery', kaAllocator: makeTestKaNumberAllocator() };
  const freshAgent = async () => {
    const { agent, publisher } = await createPromotionAgentForTest(store, options);
    // This fixture isolates publisher/queue recovery. Live validation exercises
    // actual inventory and authority; separate tests cover that handoff.
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'legacy', killSwitchActive: false });
    agent.createRfc64CatalogAuthorSignerV1 = () => ({ address: AUTHOR, signMessage: signer.signMessage.bind(signer) });
    agent.configurePromoteQueue({ backoff: () => 0, maxRetries: 1 });
    return { agent, publisher };
  };
  const { agent, publisher } = await freshAgent();
  await publisher.assertionCreate(CG, NAME, AUTHOR);
  await publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:asset', predicate: 'https://schema.org/name', object: '"original"' }]);
  const finalized = await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR });
  return { store, agent, publisher, freshAgent, finalized };
}
async function serveShares(agent: Awaited<ReturnType<typeof setup>>['agent']) {
  vi.spyOn(agent, 'listContextGraphs').mockResolvedValue([{ id: CG, uri: `did:dkg:context-graph:${CG}`, name: CG, subscribed: true, synced: true }] as any);
  vi.spyOn(agent, 'contextGraphExists').mockResolvedValue(true);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    try {
      await handleKnowledgeAssetsRoutes({ req, res, url, path: url.pathname, agent,
        requestAgentAddress: AUTHOR, authentication: requestAuthentication({ kind: 'anonymous' }),
        extractionStatus: new Map(), assertionImportLocks: new Map(), emitMemoryGraphChanged: () => {}, publisherControl: {},
      } as any);
      if (!res.writableEnded) { res.writeHead(404); res.end('{}'); }
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const post = () => fetch(`http://127.0.0.1:${address.port}/api/knowledge-assets/${NAME}/swm/share`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextGraphId: CG }),
  });
  return { post, async close() {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
afterEach(() => { daemonState.promoteWorkerAvailable = false; });
/** The real authority resolver and responsibility registry, refresh-fenced or not responsible. */
function useInactiveCatalogAuthority(agent: Awaited<ReturnType<typeof setup>>['agent'], authority: 'not-responsible' | 'refresh-fenced') {
  // Drop the fixture's legacy override.
  delete (agent as any).resolveRfc64CatalogReceiverAuthorityV1;
  agent.config = { nodeRole: 'edge', rfc64CatalogExecutionPlan: {
    killSwitchActive: false, responsibilityDefaultMode: 'catalog', selectedAuthority: {}, contextGraphModes: {},
  } } as any;
  if (authority === 'refresh-fenced') {
    // Responsible, but its authority has not been accepted yet (a new graph, a pending roster read
    // or a restart). The receiver-lane start-up work is outside this share path.
    (agent as any).handleRfc64CatalogReceiverSelectionTransitionV1 = vi.fn();
    agent.commitRfc64CatalogResponsibilityV1(CG, 'edge-subscription');
    expect(agent.readRfc64CatalogResponsibilityV1(CG)).toMatchObject({ responsible: true, active: true, mode: 'catalog' });
  }
  expect(agent.resolveRfc64CatalogReceiverAuthorityV1(CG)).toMatchObject({
    mode: 'catalog', killSwitchActive: false, authoringAllowed: false, reconciliationLane: 'disabled',
  });
}
const OPEN_LANE = { mode: 'catalog', killSwitchActive: false, active: true, authoringAllowed: true, reconciliationLane: 'catalog-apply' };
const CLOSED_LANE = { mode: 'catalog', killSwitchActive: false, active: false, authoringAllowed: false, reconciliationLane: 'disabled' };
/** Admit with an open authoring lane, then close it before the commit, as a transition after admission does. */
function closeLaneAfterAdmission(agent: Awaited<ReturnType<typeof setup>>['agent']) {
  let authority: object = OPEN_LANE;
  agent.resolveRfc64CatalogReceiverAuthorityV1 = () => authority;
  const assertion = agent.assertion;
  vi.spyOn(agent, 'assertion', 'get').mockReturnValue({ ...assertion, prepareDurableShare: async (...args: any[]) => {
    const prepared = await (assertion.prepareDurableShare as any)(...args);
    // The handoff is frozen as owed; the authority is then fenced, as after a restart.
    authority = CLOSED_LANE;
    return prepared;
  } });
  return { reopen: () => { authority = OPEN_LANE; } };
}
/** A responsibility pass that finds the graph's lane still closed. */
function keepLaneClosed(agent: Awaited<ReturnType<typeof setup>>['agent']) {
  return vi.spyOn(agent, 'reconcileRfc64CatalogResponsibilityV1').mockResolvedValue({ active: false, mode: 'catalog' } as any);
}
const MEMORY_LAYER = 'http://dkg.io/ontology/memoryLayer';
async function graphContent(store: FaultStore, graph: string) {
  return store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
}
/** A bound share answered with a pending handoff, then a confirmed VM publish of its admitted version. */
async function publishWhileHandoffPending() {
  const fixture = await setup();
  const { store, agent, publisher, finalized } = fixture;
  daemonState.promoteWorkerAvailable = true;
  closeLaneAfterAdmission(agent);
  keepLaneClosed(agent);
  const answer = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR });
  expect(answer.catalogHandoff).toMatchObject({ state: 'pending', reason: 'inactive-lane' });
  const [job] = await agent.promoteQueue.list({});
  const vm = finalized.sharedGraphUri.replace('/_shared_memory/', '/_verifiable_memory/');
  await store.insert(finalized.publicQuads.map(q => ({ ...q, graph: vm })));
  await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: MEMORY_LAYER });
  await store.insert([{ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: MEMORY_LAYER, object: '"VM"' }]);
  await publisher.clearSwmShareComplete(CG, NAME, AUTHOR);
  return { ...fixture, job, vm, binding: job.request.recoveryBinding! };
}
type VmUpdate = 'superseding' | 'equal-version' | 'different-root' | 'missing-vm' | 'unconfirmed-envelope';
/** A later update replaces the per-asset VM graph and confirms its newer version. */
async function confirmVmUpdate(fixture: Awaited<ReturnType<typeof publishWhileHandoffPending>>, kind: VmUpdate) {
  const { store, finalized, vm } = fixture;
  const updated = [{ subject: 'urn:asset', predicate: 'https://schema.org/name', object: '"updated"', graph: '' }];
  await store.deleteByPattern({ graph: vm });
  if (kind !== 'missing-vm') await store.insert(updated.map(q => ({ ...q, graph: vm })));
  const rootQuads = kind === 'different-root' ? finalized.publicQuads : updated;
  const normalized = await skolemizeKnowledgeAssetParts(rootQuads.map(q => ({ ...q, graph: '' })), [], { allowCanonicalSkolemTerms: true });
  const version = kind === 'equal-version' ? BigInt(finalized.assertionVersion) : BigInt(finalized.assertionVersion) + 1n;
  await store.insert(generateGraphKnowledgeAssetMetadata({ ual: finalized.kaUal, contextGraphId: CG,
    merkleRoot: computeFlatKCRootV10(normalized.publicQuads, []), publisherPeerId: '12D3KooWRecovery', accessPolicy: 'public',
    timestamp: new Date(0), assertionVersion: version, publicTripleCount: 1, assertionGraph: vm,
  }, kind === 'unconfirmed-envelope' ? { status: 'tentative' } : { status: 'confirmed', confirmation: { kind: 'transaction',
    provenance: { txHash: `0x${'ab'.repeat(32)}`, blockNumber: 1, blockTimestamp: 1, publisherAddress: AUTHOR, batchId: 7n, chainId: '31337' } } }));
  return graphContent(store, vm);
}

describe('durable synchronous share ownership', () => {
  it('rechecks the author before admitting a prepared durable owner', async () => {
    const { store, agent, finalized } = await setup();
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    await expect(agent.assertion.admitDurableShare({ contextGraphId: CG, assertionName: NAME, entities: 'all',
      ...prepared, authorAgentAddress: '0x3333333333333333333333333333333333333333' }, 'admission-check'))
      .rejects.toMatchObject({ code: 'KA_SHARE_AUTHOR_MISMATCH' });
    expect(await agent.promoteQueue.list()).toHaveLength(0);
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    daemonState.promoteWorkerAvailable = true;
    await expect(durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR, authorAgentAddress: AUTHOR }))
      .resolves.toMatchObject({ publishReady: true });
    await store.close();
  });
  it('rejects a synchronous author mismatch before ownership and permits the corrected request', async () => {
    const { store, agent, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    await expect(durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR,
      authorAgentAddress: '0x3333333333333333333333333333333333333333' }))
      .rejects.toMatchObject({ code: 'KA_SHARE_AUTHOR_MISMATCH' });
    expect(await agent.promoteQueue.list()).toHaveLength(0);
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    expect(await store.countQuads(finalized.graphUri)).toBe(1);
    await expect(durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR, authorAgentAddress: signer.address }))
      .resolves.toMatchObject({ promotedCount: 1, publishReady: true });
    const jobs = await agent.promoteQueue.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe('succeeded');
    await store.close();
  });

  it('completes an ordinary share with a matching mixed-case author hint', async () => {
    const { store, agent, finalized } = await setup();
    const id = await agent.promoteQueue.enqueue({ contextGraphId: CG, assertionName: NAME, agentAddress: AUTHOR,
      authorAgentAddress: signer.address, entities: 'all' });
    const job = (await agent.promoteQueue.claimNext('author-check'))!;
    expect(await runPromoteJob({ job, queue: agent.promoteQueue, workerId: 'author-check',
      runPromote: (r, executionAuthority) => executePromoteRequest(agent, r, { executionAuthority }),
      now: Date.now, heartbeatIntervalMs: 0, log: () => {} })).toMatchObject({ outcome: 'succeeded' });
    expect((await agent.promoteQueue.getStatus(id))?.result?.shareEvidence?.seal.authorAddress).toBe(AUTHOR);
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    expect(await store.countQuads(finalized.graphUri)).toBe(0);
    await store.close();
  });
  it('rejects a mismatched share author before SWM commit through the real worker', async () => {
    const { store, agent, finalized } = await setup();
    const request = { contextGraphId: CG, assertionName: NAME, agentAddress: AUTHOR,
      authorAgentAddress: '0x3333333333333333333333333333333333333333', entities: 'all' as const };
    const id = await agent.promoteQueue.enqueue(request), job = (await agent.promoteQueue.claimNext('author-check'))!;
    const gossip = vi.spyOn(agent, 'publishWorkspaceGossip');
    const result = await runPromoteJob({ job, queue: agent.promoteQueue, workerId: 'author-check',
      runPromote: (r, executionAuthority) => executePromoteRequest(agent, r, { executionAuthority }),
      now: Date.now, heartbeatIntervalMs: 0, log: () => {} });
    expect(result).toMatchObject({ outcome: 'failed_terminal', cause: { code: 'KA_SHARE_AUTHOR_MISMATCH' } });
    expect((await agent.promoteQueue.getStatus(id))?.state).toBe('failed');
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    expect(await store.countQuads(finalized.graphUri)).toBe(1);
    expect(gossip).not.toHaveBeenCalled();
    await store.close();
  });

  it.each(['unowned-precommit', 'bound-precommit', 'committed-missing-layer'])('preflights only new uncommitted admission (%s)', async state => {
    const { store, agent, publisher, finalized } = await setup();
    const opts = { publisherPeerId: agent.node.peerId.toString(), confirmBeforeCommit: async () => { throw new CuratorUnconfirmedError(CG); } };
    await expect(publisher.assertionPromote(CG, NAME, AUTHOR, opts)).rejects.toMatchObject({ code: 'CURATOR_UNCONFIRMED' });
    const original = await publisher.prepareAssertionPromoteRecovery(CG, NAME, AUTHOR, opts, true);
    expect('completedResult' in original).toBe(false);
    if (state === 'bound-precommit') await agent.promoteQueue.enqueue({ contextGraphId: CG, assertionName: NAME, entities: 'all', agentAddress: AUTHOR, recoveryBinding: original as any });
    if (state === 'committed-missing-layer') {
      await publisher.assertionPromote(CG, NAME, AUTHOR, { ...opts, confirmBeforeCommit: async () => ({ applied: true }) });
      await store.delete([{ subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"SWM"', graph: contextGraphMetaUri(CG) }]);
    }
    const before = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${contextGraphMetaUri(CG)}> { ?s ?p ?o } }`);
    const preflight = vi.fn(async () => { throw new Error('author inventory signer unavailable'); });
    const admission = publisher.prepareAssertionPromoteRecovery(CG, NAME, AUTHOR, opts, true, preflight);
    if (state === 'unowned-precommit') await expect(admission).rejects.toThrow('author inventory signer unavailable');
    else await expect(admission).resolves.toEqual(original);
    expect(preflight).toHaveBeenCalledTimes(state === 'unowned-precommit' ? 1 : 0);
    expect(await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${contextGraphMetaUri(CG)}> { ?s ?p ?o } }`)).toEqual(before);
    expect(await store.countQuads(finalized.graphUri)).toBe(state === 'committed-missing-layer' ? 0 : 1);
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(state === 'committed-missing-layer' ? 1 : 0);
    expect(await agent.promoteQueue.list()).toHaveLength(state === 'bound-precommit' ? 1 : 0);
    await store.close();
  });

  it.each([{ entities: ['urn:subset'] }, { skipSeal: true }])('rejects contradictory untyped bound execution: %j', async invalid => {
    const { store, agent, finalized } = await setup();
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    await expect(agent.assertion.promote(CG, NAME, { ...prepared, ...invalid } as any))
      .rejects.toThrow('Bound recovery requires a sealed, complete Knowledge Asset');
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    expect(await store.countQuads(finalized.graphUri)).toBe(1);
    await store.close();
  });

  it('normalizes bound execution from its immutable policy without resealing or changing caller options', async () => {
    const { store, agent, publisher } = await setup();
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    const input = { ...prepared, accessPolicy: 'allowlist', allowedPeers: ['unadmitted-peer'],
      preSignedAuthorAttestation: { address: 'unadmitted-author' } };
    const unchanged = JSON.stringify(input);
    const seal = vi.spyOn(agent, 'prepareAtomicAssertionShare');
    const promote = vi.spyOn(publisher, 'assertionPromote');
    await agent.assertion.promote(CG, NAME, input as any);
    expect(seal).not.toHaveBeenCalled();
    expect(promote.mock.calls[0][3]).toMatchObject({ recoveryBinding: prepared.recoveryBinding,
      accessPolicy: prepared.recoveryBinding.intent.accessPolicy, allowedPeers: prepared.recoveryBinding.intent.allowedPeers });
    expect(JSON.stringify(input)).toBe(unchanged);
    await store.close();
  });

  it('fences an unbound promotion admitted behind a bound owner and lets its real worker finish', async () => {
    const { store, agent, publisher, finalized } = await setup();
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    const jobId = await agent.promoteQueue.enqueue({ contextGraphId: CG, assertionName: NAME, entities: 'all', ...prepared });
    await expect(agent.assertion.promote(CG, NAME, { agentAddress: AUTHOR }))
      .rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED', recoveryJobId: jobId });
    await expect(publisher.assertionPromote(CG, NAME, AUTHOR))
      .rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED', recoveryJobId: jobId });
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    const supervisor = createPromoteWorkerSupervisor({ agent, workerConcurrency: 1, pollIntervalMs: 10, log: () => undefined });
    try {
      await supervisor.start();
      await vi.waitFor(async () => expect((await agent.promoteQueue.getStatus(jobId))?.state).toBe('succeeded'));
      expect((await agent.promoteQueue.getStatus(jobId))?.request.recoveryBinding).toEqual(prepared.recoveryBinding);
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    } finally { await supervisor.stop(); await store.close(); }
  });

  it.each([false, true])('recovers a synchronous start-marker timeout (write committed: %s) through the real worker', async committed => {
    const { store, agent, finalized } = await setup();
    let now = Date.now();
    const queue = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100, backoff: () => 0 });
    vi.spyOn(agent, 'promoteQueue', 'get').mockReturnValue(queue);
    daemonState.promoteWorkerAvailable = true;
    const marker = queue.recordCommitMarker.bind(queue), replace = store.replaceSubject.bind(store);
    vi.spyOn(queue, 'recordCommitMarker').mockImplementationOnce(async (...args) => {
      vi.spyOn(store, 'replaceSubject').mockImplementationOnce(async (...write) => {
        if (committed) await replace(...write);
        throw new StoreOperationTimeoutError({ backend: 'blazegraph', operation: 'replaceSubject', outcome: 'indeterminate' });
      });
      return marker(...args);
    });
    const assertion = agent.assertion, promote = vi.fn(assertion.promote);
    vi.spyOn(agent, 'assertion', 'get').mockReturnValue({ ...assertion, promote });
    const failure = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR }).catch(e => e);
    expect(failure).toBeInstanceOf(DurableShareFailure);
    expect(failure.observation.state).toBe('pending');
    const original = (await queue.getStatus(failure.observation.jobId))!;
    expect(original.state).toBe('running');
    expect(original.commitMarker?.promoteStarted ?? false).toBe(committed);
    expect(original.attempt.lastError).toBeUndefined();
    expect(promote).not.toHaveBeenCalled();
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    now += 101;
    // Reconstruct the queue from its persisted RDF, as after a process restart.
    const reopened = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100, backoff: () => 0 });
    vi.spyOn(agent, 'promoteQueue', 'get').mockReturnValue(reopened);
    const supervisor = createPromoteWorkerSupervisor({ agent, workerConcurrency: 1, pollIntervalMs: 10, heartbeatIntervalMs: 25, bookkeepingRetryBudgetMs: 0, log: () => undefined });
    try {
      await supervisor.start();
      await vi.waitFor(async () => expect((await reopened.getStatus(original.jobId))?.state).toBe('succeeded'));
      const completed = (await reopened.getStatus(original.jobId))!;
      expect(completed.request.recoveryBinding).toEqual(original.request.recoveryBinding);
      expect(promote).toHaveBeenCalledTimes(1);
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
      await expect(queue.succeed(original.jobId, original.lease!.claimToken, { promotedCount: 1, succeededAt: now })).rejects.toThrow();
    } finally { await supervisor.stop(); await store.close(); }
  });

  it('retires a producer-certified first-attempt size rejection and permits discard', async () => {
    const {store, agent, publisher} = await setup();
    const name = 'oversized';
    await publisher.assertionCreate(CG, name, AUTHOR);
    await publisher.assertionWrite(CG, name, AUTHOR, Array.from({length:80},(_,i)=>({subject:'urn:large',predicate:`urn:value:${i}`,object:JSON.stringify('x'.repeat(55_000))})));
    const seal = await finalizeRootlessAssertionForTest({publisher,store,contextGraphId:CG,name,agentAddress:AUTHOR});
    daemonState.promoteWorkerAvailable = true;
    await expect(durableSynchronousShare(agent, CG, name, {agentAddress:AUTHOR}))
      .rejects.toMatchObject({code:'SWM_GOSSIP_PAYLOAD_TOO_LARGE'});
    const [job] = await agent.promoteQueue.list();
    expect(job.state).toBe('failed');
    expect(job.attempt.lastError).toMatchObject({classification:'cap_exceeded',retryable:false,
      diagnosticCode:'PROMOTE_NO_EFFECT_REJECTION',noEffectProof:{sealDigest:job.request.recoveryBinding!.sealDigest,
        operationId:job.request.recoveryBinding!.intent.operationId}});
    expect(await store.countQuads(seal.sharedGraphUri)).toBe(0);
    await expect(agent.assertion.discard(CG, name, {agentAddress:AUTHOR})).resolves.toBeUndefined();
    expect(await store.countQuads(seal.graphUri)).toBe(0);
    const reopened=new TripleStoreAsyncPromoteQueue(store);
    await expect(reopened.recover(job.jobId)).rejects.toThrow('retired no-effect rejection');
    expect(await reopened.clearTerminalJob(job.jobId)).toEqual({outcome:'cleared'});
    await store.close();
  });

  it('does not retire an arbitrary cap-like failure without a producer certificate', async () => {
    const {store,agent} = await setup();
    daemonState.promoteWorkerAvailable = true;
    const assertion=agent.assertion;
    vi.spyOn(agent,'assertion','get').mockReturnValue({...assertion,promote:async()=>{
      throw Object.assign(new Error('payload too large'),{code:'SWM_GOSSIP_PAYLOAD_TOO_LARGE',noEffectProof:{}});
    }});
    const error=await durableSynchronousShare(agent,CG,NAME,{agentAddress:AUTHOR}).catch(e=>e);
    expect(error.observation.state).toBe('inspection-required');
    const job=await agent.promoteQueue.getStatus(error.observation.jobId);
    expect(job!.attempt.lastError!.noEffectProof).toBeUndefined();
    await expect(assertion.discard(CG,NAME,{agentAddress:AUTHOR})).rejects.toMatchObject({code:'KA_PROMOTE_RECOVERY_REQUIRED'});
    expect(await agent.promoteQueue.clearTerminalJob(job!.jobId)).toMatchObject({outcome:'rejected'});
    await store.close();
  });

  it('executes the admitted fields inline and in the worker despite later HTTP option mutation', async () => {
    const {store,agent}=await setup(); daemonState.promoteWorkerAvailable=true; store.remaining=1;
    const options={agentAddress:AUTHOR,subGraphName:undefined as string|undefined,curatorAckTimeoutMs:1234};
    const queue=agent.promoteQueue, enqueue=queue.enqueueAndClaim.bind(queue);
    vi.spyOn(queue,'enqueueAndClaim').mockImplementation(async(request,worker)=>{
      const job=await enqueue(request,worker); options.agentAddress=`0x${'22'.repeat(20)}`;options.subGraphName='mutated';return job;
    });
    const assertion=agent.assertion, promote=vi.fn(assertion.promote);
    vi.spyOn(agent,'assertion','get').mockReturnValue({...assertion,promote});
    const error=await durableSynchronousShare(agent,CG,NAME,options).catch(e=>e);
    expect(error.observation.state).toBe('pending');
    const original=await queue.getStatus(error.observation.jobId);
    const supervisor=createPromoteWorkerSupervisor({agent,workerConcurrency:1,pollIntervalMs:10,log:()=>undefined});
    try { await supervisor.start(); await vi.waitFor(async()=>expect((await queue.getStatus(original!.jobId))?.state).toBe('succeeded')); }
    finally {await supervisor.stop();}
    expect(promote).toHaveBeenCalledTimes(2);
    for(const [cg,name,opts] of promote.mock.calls){expect([cg,name]).toEqual([CG,NAME]);expect(opts).toMatchObject({agentAddress:AUTHOR,entities:'all',recoveryBinding:original!.request.recoveryBinding});expect(opts!.subGraphName).toBeUndefined();}
    expect(promote.mock.calls[0][2]!.curatorAckTimeoutMs).toBe(1234);
    expect(promote.mock.calls[1][2]!.curatorAckTimeoutMs).toBeUndefined();
    await store.close();
  });

  it('preserves a verified completed pre-intent share as a read-only no-op', async () => {
    const { store, agent } = await setup();
    daemonState.promoteWorkerAvailable = true;
    const original = await agent.assertion.promote(CG, NAME, { agentAddress: AUTHOR });
    await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: lifecycle,
      predicate: 'http://dkg.io/ontology/promoteOperationIntent' });
    const admission = vi.spyOn(agent.promoteQueue, 'enqueueAndClaim');
    const insert = vi.spyOn(store, 'insert');
    const replace = vi.spyOn(store, 'replaceSubject');
    expect(await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR })).toEqual({
      promotedCount: 0, sealed: true, publishReady: false, shareOperationId: original.shareOperationId,
    });
    expect(admission).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    await store.close();
  });

  it.each(['incomplete', 'changed-content'])('refuses pre-intent %s without admitting replay', async kind => {
    const { store, agent, publisher, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    if (kind === 'incomplete') store.remaining = 1;
    await agent.assertion.promote(CG, NAME, { agentAddress: AUTHOR }).catch(() => undefined);
    await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: lifecycle,
      predicate: 'http://dkg.io/ontology/promoteOperationIntent' });
    if (kind === 'changed-content') await store.insert([{ graph: finalized.sharedGraphUri,
      subject: 'urn:extra', predicate: 'urn:p', object: '"changed"' }]);
    const admission = vi.spyOn(agent.promoteQueue, 'enqueueAndClaim');
    await expect(durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR })).rejects.toThrow();
    expect(await publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(false);
    expect(admission).not.toHaveBeenCalled();
    await store.close();
  });

  it.each(['corrupt-with-wm', 'corrupt-without-wm', 'incomplete-legacy'])('retires stale completion evidence before refusing %s admission', async kind => {
    const { store, agent, publisher, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    await agent.assertion.promote(CG, NAME, { agentAddress: AUTHOR });
    const graph = contextGraphMetaUri(CG);
    const predicate = 'http://dkg.io/ontology/promoteOperationIntent';
    await store.deleteByPattern({ graph, subject: lifecycle, predicate });
    if (kind.startsWith('corrupt')) await store.insert([{ graph, subject: lifecycle, predicate, object: '"not-json"' }]);
    if (kind !== 'corrupt-without-wm') await store.insert([{ graph: finalized.graphUri,
      subject: 'urn:asset', predicate: 'https://schema.org/name', object: '"original"' }]);
    expect(await publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    const admission = vi.spyOn(agent.promoteQueue, 'enqueueAndClaim');
    await expect(durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR })).rejects.toMatchObject({
      code: kind.startsWith('corrupt') ? 'KA_PROMOTE_OPERATION_INTENT_CORRUPT' : 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT',
    });
    // This is the certificate checked by the VM publication full-share gate.
    expect(await publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(false);
    expect(admission).not.toHaveBeenCalled();
    expect(await agent.promoteQueue.list()).toEqual([]);
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    await store.close();
  });

  it.each([true, false])('automatically repairs a partial commit beyond the ordinary attempt cap (typed=%s)', async typed => {
    const { store, agent, freshAgent, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    store.typed = typed; store.remaining = 2;
    const error = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR }).catch(e => e);
    expect(error.observation.state).toBe('pending');
    const failed = await agent.promoteQueue.getStatus(error.observation.jobId);
    expect(failed.request.recoveryBinding.intent.operationId).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
    expect(failed.state).toBe('failed_retrying');
    expect(failed.attempt.lastError.retryable).toBe(true);
    expect(await agent.assertion.history(CG, NAME, { agentAddress: AUTHOR })).toBeNull();
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    const { agent: restarted } = await freshAgent();
    const supervisor = createPromoteWorkerSupervisor({ agent: restarted, workerConcurrency: 1,
      pollIntervalMs: 10, heartbeatIntervalMs: 60_000, log: () => undefined });
    try {
      await supervisor.start();
      await vi.waitFor(async () => expect((await restarted.promoteQueue.getStatus(error.observation.jobId)).state).toBe('succeeded'), { timeout: 10_000 });
      const recovered = await restarted.promoteQueue.getStatus(error.observation.jobId);
      expect(recovered.request.recoveryBinding).toEqual(failed.request.recoveryBinding);
      expect(recovered.attempt.count).toBe(3);
      expect(await restarted.assertion.history(CG, NAME, { agentAddress: AUTHOR })).toMatchObject({ state: 'promoted', memoryLayer: 'SWM' });
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
      expect(await store.countQuads(finalized.graphUri)).toBe(0);
      const prepared = await restarted.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
      expect(prepared.recoveryBinding).toEqual(failed.request.recoveryBinding);
    } finally { await supervisor.stop(); await store.close(); }
  });

  it('automatically resumes an original partial commit after a one-time replay read reset', async () => {
    const { store, agent, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    store.remaining = 1;
    const first = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR }).catch(e => e);
    const original = await agent.promoteQueue.getStatus(first.observation.jobId);
    const query = store.query.bind(store);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const remoteRead = new BlazegraphStore('http://127.0.0.1:1/sparql');
    let resets = 0;
    vi.spyOn(store, 'query').mockImplementation((sparql, options) => {
      if (!resets && sparql.includes('VALUES ?s') && sparql.includes(lifecycle)) {
        resets++;
        fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed', {
          cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
        }));
        return remoteRead.query(sparql, options);
      }
      return query(sparql, options);
    });
    const supervisor = createPromoteWorkerSupervisor({ agent, workerConcurrency: 1, pollIntervalMs: 10, log: () => undefined });
    try {
      await supervisor.start();
      await vi.waitFor(async () => expect((await agent.promoteQueue.getStatus(first.observation.jobId)).state).toBe('succeeded'));
      const completed = await agent.promoteQueue.getStatus(first.observation.jobId);
      expect(resets).toBe(1);
      expect(completed.attempt.count).toBe(3);
      expect(completed.request.recoveryBinding).toEqual(original.request.recoveryBinding);
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
      expect(await store.countQuads(finalized.graphUri)).toBe(0);
    } finally { fetchSpy.mockRestore(); await supervisor.stop(); await remoteRead.close(); await store.close(); }
  });

  it.each(['REMOTE_SIGNER_TIMEOUT', 'REMOTE_SIGNER_UNAVAILABLE', 'REMOTE_SIGNER_HTTP_ERROR'] as const)(
    'automatically recovers curator envelope signing %s before dispatch with the original owner', async code => {
      const { store, agent, finalized } = await setup();
      daemonState.promoteWorkerAvailable = true;
      agent.buildCuratorAckConfirmer = Object.getPrototypeOf(agent).buildCuratorAckConfirmer;
      agent.resolveCuratorAckTarget = async () => ({ peerIds: ['curator'], timeoutMs: 100 });
      let available = false;
      const signMessage = vi.fn(async (bytes: Uint8Array) => {
        if (!available) throw new RemoteSignerError(code, 'temporary external signer failure', { httpStatus: 503 });
        return signer.signMessage(bytes);
      });
      agent.resolveWorkspaceGossipSigningAgent = async () => ({ agentAddress: AUTHOR, signMessage });
      const dispatch = vi.fn(async () => ({ applied: true }));
      agent.confirmCuratorApplied = dispatch;
      const failure = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR, awaitCuratorAck: true }).catch(e => e);
      expect(failure).toBeInstanceOf(DurableShareFailure);
      const original = await agent.promoteQueue.getStatus(failure.observation.jobId);
      expect(original.state).toBe('failed_retrying');
      expect(original.request.recoveryBinding.intent.confirmationRequired).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
      expect(await store.countQuads(finalized.graphUri)).toBe(1);
      const seal = vi.spyOn(agent, 'prepareAtomicAssertionShare');
      // Reopen the durable queue before starting its real polling worker.
      const reopened = new TripleStoreAsyncPromoteQueue(store, { backoff: () => 0, maxRetries: 1 });
      vi.spyOn(agent, 'promoteQueue', 'get').mockReturnValue(reopened);
      available = true;
      const supervisor = createPromoteWorkerSupervisor({ agent, workerConcurrency: 1, pollIntervalMs: 10, log: () => undefined });
      try {
        await supervisor.start();
        await vi.waitFor(async () => expect((await reopened.getStatus(original.jobId))?.state).toBe('succeeded'));
        const completed = await reopened.getStatus(original.jobId);
        expect(completed.request.recoveryBinding).toEqual(original.request.recoveryBinding);
        expect(completed.attempt.count).toBe(2);
        expect(await reopened.list({})).toHaveLength(1);
        expect(signMessage).toHaveBeenCalledTimes(2);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(seal).not.toHaveBeenCalled();
        expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
        expect(await store.countQuads(finalized.graphUri)).toBe(0);
      } finally { await supervisor.stop(); await store.close(); }
    });

  it.each(['REMOTE_SIGNER_UNAUTHORIZED', 'REMOTE_SIGNER_INVALID_SIGNATURE', 'REMOTE_SIGNER_REJECTED'] as const)(
    'keeps permanent curator envelope refusal %s terminal without dispatch', async code => {
      const { store, agent, finalized } = await setup();
      daemonState.promoteWorkerAvailable = true;
      agent.buildCuratorAckConfirmer = Object.getPrototypeOf(agent).buildCuratorAckConfirmer;
      agent.resolveCuratorAckTarget = async () => ({ peerIds: ['curator'], timeoutMs: 100 });
      const signMessage = vi.fn(async () => { throw new RemoteSignerError(code, 'permanent refusal'); });
      agent.resolveWorkspaceGossipSigningAgent = async () => ({ agentAddress: AUTHOR, signMessage });
      const dispatch = vi.fn(); agent.confirmCuratorApplied = dispatch;
      const failure = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR, awaitCuratorAck: true }).catch(e => e);
      expect(failure).toBeInstanceOf(DurableShareFailure);
      const original = await agent.promoteQueue.getStatus(failure.observation.jobId);
      expect(original.state).toBe('failed');
      expect(await agent.promoteQueue.claimNext('worker')).toBeNull();
      expect(signMessage).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
      expect(await store.countQuads(finalized.graphUri)).toBe(1);
      await store.close();
    });

  it('automatically retries curator non-confirmation with the original required acknowledgement', async () => {
    const { store, agent, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    let connected = false;
    const confirmation = vi.fn(async () => ({ applied: connected }));
    agent.buildCuratorAckConfirmer = async () => confirmation;
    const error = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR, awaitCuratorAck: true }).catch(e => e);
    expect(error.cause.code).toBe('CURATOR_UNCONFIRMED');
    const failed = await agent.promoteQueue.getStatus(error.observation.jobId);
    expect(failed.state).toBe('failed_retrying');
    expect(failed.request.recoveryBinding.intent.confirmationRequired).toBe(true);
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    connected = true;
    const supervisor = createPromoteWorkerSupervisor({ agent, workerConcurrency: 1, pollIntervalMs: 10, log: () => undefined });
    try {
      await supervisor.start();
      await vi.waitFor(async () => expect((await agent.promoteQueue.getStatus(error.observation.jobId)).state).toBe('succeeded'));
      expect((await agent.promoteQueue.getStatus(error.observation.jobId)).request.recoveryBinding).toEqual(failed.request.recoveryBinding);
      expect(confirmation).toHaveBeenCalledTimes(2);
    } finally { await supervisor.stop(); await store.close(); }
  });

  it('rejects an explicit stronger acknowledgement request for an existing unconfirmed intent', async () => {
    const { store, agent } = await setup();
    daemonState.promoteWorkerAvailable = true;
    await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR, awaitCuratorAck: false });
    const original = await agent.promoteQueue.list({});
    const confirmation = vi.fn(async () => ({ applied: false }));
    agent.buildCuratorAckConfirmer = async () => confirmation;
    const admit = vi.spyOn(agent.promoteQueue, 'enqueueAndClaim');
    await expect(durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR, awaitCuratorAck: true }))
      .rejects.toMatchObject({ code: 'KA_PROMOTE_ACK_REQUIREMENT_CONFLICT' });
    expect(admit).not.toHaveBeenCalled();
    expect(confirmation).not.toHaveBeenCalled();
    expect(await agent.promoteQueue.list({})).toEqual(original);
    await store.close();
  });

  it('accepts an explicit acknowledgement when the node is itself the curator and no remote confirmation is needed', async () => {
    const { store, agent } = await setup();
    daemonState.promoteWorkerAvailable = true;
    agent.buildCuratorAckConfirmer = async () => undefined;
    const result = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR, awaitCuratorAck: true });
    expect(result.promotedCount).toBe(1);
    expect((await agent.promoteQueue.list({}))[0].request.recoveryBinding.intent.confirmationRequired).toBe(false);
    await store.close();
  });

  it.each(['ordinary', 'network-cg', 'timeout', 'ECONNRESET'])('keeps permanent curator rejection for %s in an inspection hold', async rejectedGraph => {
    const { store, agent } = await setup();
    daemonState.promoteWorkerAvailable = true;
    agent.buildCuratorAckConfirmer = async () => async () => { throw new CuratorRejectedError(rejectedGraph); };
    const error = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR, awaitCuratorAck: true }).catch(e => e);
    expect(error.cause.code).toBe('CURATOR_REJECTED');
    expect((await agent.promoteQueue.getStatus(error.observation.jobId)).state).toBe('failed');
    const repeated = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR, awaitCuratorAck: true }).catch(e => e);
    expect(repeated).toBeInstanceOf(DurableShareFailure);
    expect(repeated.observation).toEqual({ state: 'inspection-required', jobId: error.observation.jobId });
    expect(classifySynchronousShareFailure(repeated, { contextGraphId: CG, name: NAME, phase: 'swm-share' }))
      .toMatchObject({ status: 409, body: { recoveryState: 'inspection-required', retryable: false,
        recoveryJobId: error.observation.jobId, code: 'SHARE_OWNER_CONFLICT' } });
    expect(await agent.promoteQueue.list({})).toHaveLength(1);
    vi.spyOn(agent.promoteQueue, 'getStatus').mockRejectedValueOnce(new Error('store unavailable'));
    expect(await observeShareRecovery(agent.promoteQueue, error.observation.jobId))
      .toEqual({ state: 'unobserved', jobId: error.observation.jobId });

    await store.close();
  });

  it.each([
    ['legacy', false, false, false], ['catalog', true, false, false],
    ['catalog', false, true, true], ['shadow', false, true, true],
    // A fenced or non-responsible authority cannot open the lane the handoff would wait on.
    ['catalog', false, false, false], ['shadow', false, false, false],
  ])('captures effective %s admission with kill switch %s and authoring allowed %s as inventoryRequired=%s', async (mode, killSwitchActive, authoringAllowed, required) => {
    const { store, agent } = await setup();
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode, killSwitchActive, active: authoringAllowed, authoringAllowed });
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    expect(prepared.recoveryBinding.inventoryRequired).toBe(required);
    await store.close();
  });

  it.each(['catalog', 'shadow'])('completes a private share under the public-only compatibility fallback (%s)', async mode => {
    const { store, agent, finalized } = await setup();
    agent.config = { rfc64CatalogDeploymentProfile: { networkId: 'otp:20430' },
      rfc64CatalogAuthoringPolicy: resolveRfc64CatalogAuthoringPolicyV1({ selectedCatalogAuthoringControls: [], acceptedPolicies: [],
        legacyPublicFallback: { mode: 'all-accepted-public', config: { peers: [], catalogIssuerDelegationExpiresAt: '253402300799000' } } }) };
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode, killSwitchActive: false, active: true, authoringAllowed: true });
    vi.spyOn(agent, 'rfc64PublicCatalogServiceV1', 'get').mockReturnValue({ acceptedPolicySnapshot: () => ({ policy: { accessPolicy: 1 } }) });
    agent.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 1 });
    // The configuration normalizer and public/private lane decision are real;
    // this publisher fixture models accepted authority and transport separately.
    expect(agent.resolveRfc64CatalogAuthoringLaneV1(CG, undefined)).toBeNull();
    const inventory = vi.spyOn(agent, 'commitRfc64SwmAuthorInventoryV1');
    daemonState.promoteWorkerAvailable = true;
    const result = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR });
    expect(result.promotedCount).toBe(1);
    expect((await agent.promoteQueue.list({}))[0]).toMatchObject({ state: 'succeeded', request: { recoveryBinding: { inventoryRequired: false } } });
    expect(inventory).not.toHaveBeenCalled();
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    await store.close();
  });

  it.each([[null, false], [null, true], [0, false], [0, true]] as const)(
    'requires accepted policy before exempting a public-only share (accepted=%s, authoring allowed=%s)', async (accepted, authoringAllowed) => {
    const { store, agent, finalized } = await setup();
    agent.config = { rfc64CatalogDeploymentProfile: { networkId: 'otp:20430' },
      rfc64CatalogAuthoringPolicy: resolveRfc64CatalogAuthoringPolicyV1({ selectedCatalogAuthoringControls: [], acceptedPolicies: [],
        legacyPublicFallback: { mode: 'all-accepted-public', config: { peers: [], catalogIssuerDelegationExpiresAt: '253402300799000' } } }) };
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'catalog', killSwitchActive: false, active: authoringAllowed, authoringAllowed });
    vi.spyOn(agent, 'rfc64PublicCatalogServiceV1', 'get').mockReturnValue({ acceptedPolicySnapshot: () => accepted === null ? null : { policy: { accessPolicy: accepted } } });
    const request = agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR, accessPolicy: 'ownerOnly' });
    // Missing policy stays a retryable readiness gap; an accepted private policy owes the
    // bound handoff only while the authoring lane can be active.
    if (accepted === null) await expect(request).rejects.toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE' });
    else expect((await request).recoveryBinding.inventoryRequired).toBe(authoringAllowed);
    expect(await agent.promoteQueue.list({})).toHaveLength(0);
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    expect(await store.countQuads(finalized.graphUri)).toBe(1);
    await store.close();
  });

  it('completes a share with the actual effective kill-switch authority and no inventory obligation', async () => {
    const { store, agent } = await setup();
    // Use the real authority resolver/registry, not the fixture's legacy override.
    delete agent.resolveRfc64CatalogReceiverAuthorityV1;
    agent.config = { nodeRole: 'edge', rfc64CatalogExecutionPlan: {
      killSwitchActive: true, responsibilityDefaultMode: 'catalog', selectedAuthority: {}, contextGraphModes: {},
    } };
    expect(agent.resolveRfc64CatalogReceiverAuthorityV1(CG)).toMatchObject({ killSwitchActive: true, authoringAllowed: false });
    const inventory = vi.spyOn(agent, 'commitRfc64SwmAuthorInventoryV1');
    daemonState.promoteWorkerAvailable = true;
    const result = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR });
    expect(result.promotedCount).toBe(1);
    const jobs = await agent.promoteQueue.list({});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: 'succeeded', request: { recoveryBinding: { inventoryRequired: false } } });
    expect(inventory).not.toHaveBeenCalled();
    await store.close();
  });

  it.each(['not-responsible', 'refresh-fenced'] as const)(
    'completes a share whose catalog authority is %s and hands inventory to the detached observer', async authority => {
      const { store, agent, finalized } = await setup();
      useInactiveCatalogAuthority(agent, authority);
      const inventory = vi.spyOn(agent, 'commitRfc64SwmAuthorInventoryV1');
      daemonState.promoteWorkerAvailable = true;
      const result = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR });
      expect(result).toMatchObject({ promotedCount: 1, sealed: true, publishReady: true, shareOperationId: expect.any(String) });
      const jobs = await agent.promoteQueue.list({});
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ state: 'succeeded', request: { recoveryBinding: {
        inventoryRequired: false, intent: { operationId: result.shareOperationId } } } });
      expect(agent.scheduleRfc64SwmInventoryObserverV1).toHaveBeenCalledWith(expect.objectContaining({
        contextGraphId: CG, assertionCoordinate: NAME, shareOperationId: result.shareOperationId,
      }));
      expect(inventory).not.toHaveBeenCalled();
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
      await store.close();
    });

  it('answers a shared, publish-ready HTTP share while the catalog authority is refresh-fenced', async () => {
    const { store, agent, finalized } = await setup();
    useInactiveCatalogAuthority(agent, 'refresh-fenced');
    daemonState.promoteWorkerAvailable = true;
    const { post, close } = await serveShares(agent);
    try {
      const response = await post();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ swmShared: true, sealed: true, publishReady: true, promotedCount: 1, shareOperationId: expect.any(String) });
      expect(agent.scheduleRfc64SwmInventoryObserverV1).toHaveBeenCalledWith(expect.objectContaining({
        contextGraphId: CG, assertionCoordinate: NAME, shareOperationId: body.shareOperationId,
      }));
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    } finally { await close(); await store.close(); }
  });

  it('answers a committed share with a pending catalog handoff when the authoring lane closes before commit, then writes the inventory once the lane reopens', async () => {
    const { store, agent, publisher, freshAgent, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    closeLaneAfterAdmission(agent);
    const reconcile = keepLaneClosed(agent);
    const writer = vi.spyOn(agent, 'commitRfc64SwmAuthorInventoryV1');
    const result = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR });
    const [job] = await agent.promoteQueue.list({});
    const operationId = job.request.recoveryBinding!.intent.operationId;
    expect(result).toEqual({ promotedCount: 1, sealed: true, publishReady: true, shareOperationId: operationId,
      catalogHandoff: { state: 'pending', reason: 'inactive-lane', recoveryJobId: job.jobId } });
    expect(reconcile).toHaveBeenCalledOnce();
    // The real inventory writer reports the closed lane once; the pass does not reopen it.
    expect(writer).toHaveBeenCalledOnce();
    await expect(writer.mock.results[0]!.value).resolves.toMatchObject({ status: 'dormant', dormantReason: 'inactive-lane' });
    expect(job).toMatchObject({ state: 'failed_retrying', request: { recoveryBinding: { inventoryRequired: true } },
      attempt: { lastError: { diagnosticCode: 'PROMOTE_RETRYABLE_FAILURE', retryable: true } } });
    expect(agent.scheduleRfc64SwmInventoryObserverV1).not.toHaveBeenCalled();
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    expect(await publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    await expect(agent.assertion.discard(CG, NAME, { agentAddress: AUTHOR })).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    await expect(agent.assertion.pullFrom(CG, NAME, 'swm', { agentAddress: AUTHOR }))
      .rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED', recoveryJobId: job.jobId });
    await expect(agent.promoteQueue.cancel(job.jobId)).rejects.toThrow('obligation');
    expect(await agent.promoteQueue.clearTerminalJob(job.jobId)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    // A restarted node whose lane is still closed writes nothing: the real writer refuses and the job keeps its obligation.
    const { agent: closed } = await freshAgent();
    closed.resolveRfc64CatalogReceiverAuthorityV1 = () => CLOSED_LANE;
    keepLaneClosed(closed);
    const closedWriter = vi.spyOn(closed, 'commitRfc64SwmAuthorInventoryV1');
    const claim = (await closed.promoteQueue.claimNext('closed-lane'))!;
    expect(claim.jobId).toBe(job.jobId);
    expect((await runPromoteJob({ job: claim, queue: closed.promoteQueue, workerId: 'closed-lane', now: Date.now,
      heartbeatIntervalMs: 60_000, log: () => undefined,
      runPromote: (request, executionAuthority) => executePromoteRequest(closed, request, { executionAuthority }) })).outcome).toBe('failed_retrying');
    expect(closedWriter).toHaveBeenCalledOnce();
    await expect(closedWriter.mock.results[0]!.value).resolves.toMatchObject({ status: 'dormant', dormantReason: 'inactive-lane' });
    expect(await closed.promoteQueue.getStatus(job.jobId)).toMatchObject({ state: 'failed_retrying',
      request: { recoveryBinding: job.request.recoveryBinding } });
    await expect(closed.assertion.pullFrom(CG, NAME, 'swm', { agentAddress: AUTHOR }))
      .rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED', recoveryJobId: job.jobId });
    // A restarted node whose lane is open again writes the owed inventory through the same job.
    const { agent: restarted } = await freshAgent();
    restarted.resolveRfc64CatalogReceiverAuthorityV1 = () => OPEN_LANE;
    const reopened = vi.fn(async () => ({ status: 'applied', attempts: 1, headObjectDigest: 'reopened-head', kaUal: finalized.kaUal }));
    restarted.commitRfc64SwmAuthorInventoryV1 = reopened;
    restarted.requestRfc64SwmCatalogProjectionV1 = () => true;
    const worker = createPromoteWorkerSupervisor({ agent: restarted, workerConcurrency: 1, pollIntervalMs: 10, log: () => undefined });
    try {
      await worker.start();
      await vi.waitFor(async () => expect((await restarted.promoteQueue.getStatus(job.jobId))?.state).toBe('succeeded'));
      expect(reopened).toHaveBeenCalledOnce();
      expect(reopened.mock.calls[0]![0]).toMatchObject({ shareOperationId: operationId });
      expect((await restarted.promoteQueue.getStatus(job.jobId))?.request.recoveryBinding).toEqual(job.request.recoveryBinding);
      expect(await restarted.assertion.pullFrom(CG, NAME, 'swm', { agentAddress: AUTHOR })).toMatchObject({ seeded: 1 });
    } finally { await worker.stop(); await store.close(); }
  });

  it('completes the one-shot share inline when one responsibility pass reopens the authoring lane', async () => {
    const { store, agent, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    const lane = closeLaneAfterAdmission(agent);
    const reconcile = vi.spyOn(agent, 'reconcileRfc64CatalogResponsibilityV1').mockImplementation(async () => {
      lane.reopen();
      return { active: true, mode: 'catalog' } as any;
    });
    const realWriter = agent.commitRfc64SwmAuthorInventoryV1.bind(agent);
    const writer = vi.spyOn(agent, 'commitRfc64SwmAuthorInventoryV1')
      .mockImplementationOnce(realWriter)
      .mockResolvedValueOnce({ status: 'applied', attempts: 1, headObjectDigest: 'reopened-head', kaUal: finalized.kaUal } as any);
    const projection = vi.fn(() => true);
    agent.requestRfc64SwmCatalogProjectionV1 = projection;
    const result = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR });
    const [job] = await agent.promoteQueue.list({});
    expect(result).toEqual({ promotedCount: 1, sealed: true, publishReady: true,
      shareOperationId: job.request.recoveryBinding!.intent.operationId, shareEvidence: job.result!.shareEvidence });
    expect(job.result!.shareEvidence).toMatchObject({ version: 1, contextGraphId: CG, assertionName: NAME,
      shareOperationId: job.request.recoveryBinding!.intent.operationId, seal: { kaUal: finalized.kaUal } });
    expect(computeCanonicalGraphScopedAuthorSealDigestV1(job.result!.shareEvidence!.seal)).toBe(job.request.recoveryBinding!.sealDigest);
    expect(job).toMatchObject({ state: 'succeeded', request: { recoveryBinding: { inventoryRequired: true } } });
    await expect(writer.mock.results[0]!.value).resolves.toMatchObject({ status: 'dormant', dormantReason: 'inactive-lane' });
    expect(writer).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(projection).toHaveBeenCalledOnce();
    await store.close();
  });

  it.each(['authority-transition', 'projection-admission', 'authority-not-ready'] as const)(
    'answers a committed share with a pending %s catalog handoff', async reason => {
      const { store, agent, finalized } = await setup();
      daemonState.promoteWorkerAvailable = true;
      agent.resolveRfc64CatalogReceiverAuthorityV1 = () => OPEN_LANE;
      keepLaneClosed(agent);
      agent.commitRfc64SwmAuthorInventoryV1 = vi.fn(async () => {
        if (reason === 'authority-not-ready') {
          throw new SwmInventoryWriteFailure('authority', null, new SwmCatalogAuthorityNotReady('service-unavailable'));
        }
        return reason === 'authority-transition' ? { status: 'dormant', dormantReason: reason }
          : { status: 'applied', attempts: 1, headObjectDigest: 'head', kaUal: finalized.kaUal };
      }) as any;
      agent.requestRfc64SwmCatalogProjectionV1 = () => false;
      const result = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR });
      const [job] = await agent.promoteQueue.list({});
      expect(result).toMatchObject({ promotedCount: 1, sealed: true, publishReady: true,
        shareOperationId: job.request.recoveryBinding!.intent.operationId,
        catalogHandoff: { state: 'pending', reason, recoveryJobId: job.jobId } });
      expect(job).toMatchObject({ state: 'failed_retrying', request: { recoveryBinding: { inventoryRequired: true } } });
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
      await store.close();
    });

  it.each(['pending', 'authority-not-ready'] as const)('keeps confirmed-ownership (%s) on the 503 recovery contract', async outcome => {
    const { store, agent } = await setup();
    daemonState.promoteWorkerAvailable = true;
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => OPEN_LANE;
    agent.commitRfc64SwmAuthorInventoryV1 = vi.fn(async () => ({ status: 'dormant', dormantReason: 'vm-confirmed' })) as any;
    const notReady = new SwmCatalogAuthorityNotReady('service-unavailable');
    const transfer = outcome === 'pending' ? vi.spyOn(agent, 'transferRfc64ConfirmedVmV1').mockResolvedValue('pending')
      : vi.spyOn(agent, 'transferRfc64ConfirmedVmV1').mockRejectedValue(new ConfirmedVmOwnershipFailure('authority', notReady));
    const failure = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR }).catch(e => e);
    expect(failure).toBeInstanceOf(DurableShareFailure);
    expect(failure.observation.state).toBe('pending');
    if (outcome === 'pending') {
      expect(failure.cause).toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE',
        cause: { code: 'SWM_INVENTORY_HANDOFF_PENDING', reason: 'confirmed-ownership' } });
    } else {
      // The same readiness cause from the shared-memory inventory step is answered as shared.
      expect(failure.cause).toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE' });
      expect(failure.cause.cause).toBe(notReady);
    }
    expect(transfer).toHaveBeenCalledOnce();
    expect(classifySynchronousShareFailure(failure, { contextGraphId: CG, name: NAME, phase: 'swm-share' }))
      .toMatchObject({ status: 503, body: { recoveryState: 'pending', recoveryJobId: failure.observation.jobId } });
    await store.close();
  });

  it('keeps the 503 unobserved contract when a pending-handoff failure cannot be recorded', async () => {
    const { store, agent } = await setup();
    daemonState.promoteWorkerAvailable = true;
    closeLaneAfterAdmission(agent);
    keepLaneClosed(agent);
    const queue = agent.promoteQueue;
    vi.spyOn(queue, 'fail').mockImplementation(async () => {
      vi.spyOn(queue, 'getStatus').mockRejectedValue(new Error('queue observation unavailable'));
      throw new Error('failure write refused');
    });
    const failure = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR }).catch(e => e);
    expect(failure).toBeInstanceOf(DurableShareFailure);
    expect(failure.observation).toEqual({ state: 'unobserved', jobId: expect.any(String) });
    expect(failure).not.toHaveProperty('catalogHandoff');
    expect(failure.cause).toMatchObject({ cause: { code: 'SWM_INVENTORY_HANDOFF_PENDING', reason: 'inactive-lane' } });
    await store.close();
  });

  it('answers the share route with a shared, publish-ready body and a pending catalog handoff when the authoring lane closes before commit', async () => {
    const { store, agent, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    closeLaneAfterAdmission(agent);
    // The responsibility pass runs in the request, outside the asset's inventory lock (a started agent runs the real pass
    // in the agent suite; this fixture has no background dispatcher).
    const lockedDuringPass: boolean[] = [];
    const reconcile = vi.spyOn(agent, 'reconcileRfc64CatalogResponsibilityV1').mockImplementation(async () => {
      // An exclusive section starts its callback synchronously, before it is tracked; one macrotask later a pass
      // running inside the lane lock would see the write.
      await new Promise(resolve => setImmediate(resolve));
      lockedDuringPass.push(rfc64SwmInventoryShadowRuntimeV1(agent).hasInventoryWrites({ contextGraphId: CG, authorAddress: AUTHOR }));
      return { active: false, mode: 'catalog' } as any;
    });
    const { post, close } = await serveShares(agent);
    try {
      const response = await post();
      expect(response.status).toBe(200);
      expect(response.headers.get('retry-after')).toBeNull();
      const body = await response.json();
      const [job] = await agent.promoteQueue.list({});
      expect(body).toMatchObject({ swmShared: true, sealed: true, publishReady: true, promotedCount: 1,
        shareOperationId: job.request.recoveryBinding!.intent.operationId,
        catalogHandoff: { state: 'pending', reason: 'inactive-lane', recoveryJobId: job.jobId,
          recoveryStatusUrl: `/api/knowledge-assets/swm/share-jobs/${job.jobId}` } });
      for (const field of ['code', 'error', 'partial', 'recoveryState']) expect(body).not.toHaveProperty(field);
      expect(job.state).toBe('failed_retrying');
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
      expect(reconcile).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledWith(CG);
      expect(lockedDuringPass).toEqual([false]);
    } finally { await close(); await store.close(); }
  });

  it.each([false, true])('finishes a pre-intent VM no-op with leftover WM=%s', async leftover => {
    const { store, agent, publisher, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    await agent.assertion.promote(CG, NAME, { agentAddress: AUTHOR });
    const vm = finalized.sharedGraphUri.replace('/_shared_memory/', '/_verifiable_memory/');
    await store.insert(finalized.publicQuads.map(q => ({ ...q, graph: vm })));
    await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: 'http://dkg.io/ontology/promoteOperationIntent' });
    await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer' });
    await store.insert([{ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"VM"' }]);
    await publisher.clearSwmShareComplete(CG, NAME, AUTHOR);
    if (leftover) await store.insert(finalized.publicQuads.map(q => ({ ...q, graph: finalized.graphUri })));
    const admission = vi.spyOn(agent.promoteQueue, 'enqueueAndClaim');
    const insert = vi.spyOn(store, 'insert');
    const drop = vi.spyOn(store, 'dropGraph');
    const remove = vi.spyOn(store, 'deleteByPattern');
    expect(await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR })).toEqual({ promotedCount: 0, sealed: true, publishReady: false });
    expect(admission).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(await store.countQuads(finalized.graphUri)).toBe(0);
    if (!leftover) { expect(drop).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); }
    expect(await agent.assertion.pullFrom(CG, NAME, 'vm', { agentAddress: AUTHOR })).toMatchObject({ seeded: 1 });
    await store.close();
  });

  it.each(['invalid-vm', 'cleanup-failure'])('refuses a legacy VM success before safe cleanup: %s', async failure => {
    const { store, agent, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    await agent.assertion.promote(CG, NAME, { agentAddress: AUTHOR });
    const vm = finalized.sharedGraphUri.replace('/_shared_memory/', '/_verifiable_memory/');
    await store.insert(finalized.publicQuads.map(q => ({ ...q, graph: vm })));
    await store.insert(finalized.publicQuads.map(q => ({ ...q, graph: finalized.graphUri })));
    await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: 'http://dkg.io/ontology/promoteOperationIntent' });
    await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer' });
    await store.insert([{ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"VM"' }]);
    if (failure === 'cleanup-failure') vi.spyOn(store, 'dropGraph').mockRejectedValueOnce(new Error('cleanup unavailable'));
    else await store.insert([{ graph: vm, subject: 'urn:extra', predicate: 'urn:p', object: '"corrupt"' }]);
    await expect(durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR })).rejects.toThrow();
    expect(await store.countQuads(finalized.graphUri)).toBe(1);
    expect(await agent.promoteQueue.list({})).toHaveLength(0);
    await store.close();
  });

  it('requires durable catalog ownership after the real publisher verifies a VM no-op', async () => {
    const { store, agent, finalized } = await setup();
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'catalog', killSwitchActive: false, active: true, authoringAllowed: true });
    const bound = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    const swmTail = vi.spyOn(agent, 'afterDurableSwmPromotionV1').mockRejectedValueOnce(new Error('inventory CAS unavailable'));
    await expect(agent.assertion.promote(CG, NAME, bound)).rejects.toThrow('inventory CAS unavailable');
    const vm = finalized.sharedGraphUri.replace('/_shared_memory/', '/_verifiable_memory/');
    await store.insert(finalized.publicQuads.map(q => ({ ...q, graph: vm })));
    await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer' });
    await store.insert([{ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"VM"' }]);
    const confirmed = vi.spyOn(agent, 'transferRfc64ConfirmedVmV1').mockResolvedValueOnce('pending').mockResolvedValueOnce('owned');
    await expect(agent.assertion.promote(CG, NAME, bound)).rejects.toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE' });
    expect(await agent.assertion.promote(CG, NAME, bound)).toEqual({ promotedCount: 0, sealed: true, publishReady: false });
    expect(confirmed).toHaveBeenCalledTimes(2);
    expect(confirmed.mock.calls[0][0]).toMatchObject({ expectedWorkspaceAccessPolicy: bound.recoveryBinding.intent.accessPolicy,
      shareOperationId: bound.recoveryBinding.intent.operationId });
    expect(swmTail).toHaveBeenCalledTimes(1);
    expect(await store.countQuads(vm)).toBe(1);
    expect(await agent.assertion.history(CG, NAME, { agentAddress: AUTHOR })).toMatchObject({ memoryLayer: 'VM' });
    await store.close();
  });

  it('converges a bound replay through confirmed ownership after a VM publish and a later confirmed update', async () => {
    const fixture = await publishWhileHandoffPending();
    const { store, agent, finalized, binding, vm } = fixture;
    const updated = await confirmVmUpdate(fixture, 'superseding');
    const transfer = vi.spyOn(agent, 'transferRfc64ConfirmedVmV1').mockResolvedValueOnce('inactive').mockResolvedValueOnce('owned');
    const replay = { agentAddress: AUTHOR, recoveryBinding: binding };
    await expect(agent.assertion.promote(CG, NAME, replay)).rejects.toMatchObject({ code: 'PROMOTE_RETRYABLE_FAILURE',
      cause: { code: 'SWM_INVENTORY_HANDOFF_PENDING', reason: 'confirmed-ownership' } });
    expect(await agent.assertion.promote(CG, NAME, replay)).toEqual({ promotedCount: 0, sealed: true, publishReady: false });
    expect(transfer).toHaveBeenCalledTimes(2);
    for (const [call] of transfer.mock.calls) {
      expect(call).toMatchObject({ shareOperationId: binding.intent.operationId,
        expectedWorkspaceAccessPolicy: binding.intent.accessPolicy, seal: { assertionVersion: finalized.assertionVersion } });
    }
    expect(await graphContent(store, vm)).toEqual(updated);
    expect(await agent.assertion.history(CG, NAME, { agentAddress: AUTHOR })).toMatchObject({ memoryLayer: 'VM' });
    await store.close();
  });

  it('ends the bound job succeeded and releases the lifecycle fence after a VM publish and a later confirmed update', async () => {
    const fixture = await publishWhileHandoffPending();
    const { store, agent, publisher, job, vm } = fixture;
    const updated = await confirmVmUpdate(fixture, 'superseding');
    const owner = { contextGraphId: CG, assertionName: NAME, agentAddress: AUTHOR };
    expect(await (publisher as any).promoteOwnershipReader(owner)).toMatchObject({ jobId: job.jobId });
    const transfer = vi.spyOn(agent, 'transferRfc64ConfirmedVmV1').mockResolvedValue('owned');
    const worker = createPromoteWorkerSupervisor({ agent, workerConcurrency: 1, pollIntervalMs: 10, log: () => undefined });
    try {
      await worker.start();
      await vi.waitFor(async () => expect((await agent.promoteQueue.getStatus(job.jobId))?.state).toBe('succeeded'));
      expect(transfer).toHaveBeenCalledOnce();
      expect(await (publisher as any).promoteOwnershipReader(owner)).toBeFalsy();
      expect(await graphContent(store, vm)).toEqual(updated);
    } finally { await worker.stop(); await store.close(); }
  });

  it.each(['equal-version', 'different-root', 'missing-vm', 'unconfirmed-envelope'] as const)(
    'keeps an unproven VM replacement fatal for a bound replay (%s)', async kind => {
      const fixture = await publishWhileHandoffPending();
      const { store, agent, binding, vm } = fixture;
      const replaced = await confirmVmUpdate(fixture, kind);
      const meta = await graphContent(store, contextGraphMetaUri(CG));
      const transfer = vi.spyOn(agent, 'transferRfc64ConfirmedVmV1');
      const failure = await agent.assertion.promote(CG, NAME, { agentAddress: AUTHOR, recoveryBinding: binding }).catch(e => e);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.code).toBeUndefined();
      expect(failure.message).toMatch(kind === 'missing-vm' ? /triple-count mismatch/ : /Merkle mismatch/);
      expect(transfer).not.toHaveBeenCalled();
      expect(await graphContent(store, vm)).toEqual(replaced);
      expect(await graphContent(store, contextGraphMetaUri(CG))).toEqual(meta);
      await store.close();
    });

  it('reclaims an expired started bound lease after process loss and fences the old token', async () => {
    const { store, agent, freshAgent } = await setup();
    let now = Date.now();
    const queue = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100, backoff: () => 0 });
    const binding = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    const job = await queue.enqueueAndClaim({ contextGraphId: CG, assertionName: NAME, entities: 'all', ...binding }, 'old');
    await queue.recordCommitMarker(job.jobId, job.lease!.claimToken, 'promoteStarted');
    store.remaining = 1;
    await expect(agent.assertion.promote(CG, NAME, binding)).rejects.toThrow();
    // Simulated process loss: no fail/succeed bookkeeping. New instances load RDF.
    now += 101;
    const reopened = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100, backoff: () => 0 });
    expect(await reopened.recoverOnStartup()).toEqual({ reclaimed: 1, abandoned: 0 });
    const claim = await reopened.claimNext('new');
    await expect(queue.succeed(job.jobId, job.lease!.claimToken, { promotedCount: 0, succeededAt: now })).rejects.toThrow();
    const { agent: restarted } = await freshAgent();
    const result = await restarted.assertion.promote(CG, NAME, { agentAddress: AUTHOR, recoveryBinding: claim!.request.recoveryBinding });
    expect(result).toMatchObject({ promotedCount: 0, shareOperationId: binding.recoveryBinding.intent.operationId });
    await store.close();
  });

  it('refuses a changed seal or intent without modifying committed content', async () => {
    const { store, agent, finalized } = await setup();
    const bound = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    store.remaining = 1;
    await expect(agent.assertion.promote(CG, NAME, bound)).rejects.toThrow();
    const badSeal = { ...bound.recoveryBinding, sealDigest: `0x${'ff'.repeat(32)}` };
    await expect(agent.assertion.promote(CG, NAME, { ...bound, recoveryBinding: badSeal })).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT' });
    const badIntent = { ...bound.recoveryBinding, intent: { ...bound.recoveryBinding.intent, timestampMs: bound.recoveryBinding.intent.timestampMs + 1 } };
    await expect(agent.assertion.promote(CG, NAME, { ...bound, recoveryBinding: badIntent })).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT' });
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    expect(await agent.assertion.history(CG, NAME, { agentAddress: AUTHOR })).toBeNull();
    await store.close();
  });

  it('retains an unfinished obligation against cancel and terminal clear', async () => {
    const { store, agent } = await setup();
    const bound = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    const q = agent.promoteQueue;
    const job = await q.enqueueAndClaim({ contextGraphId: CG, assertionName: NAME, entities: 'all', ...bound }, 'inline');
    await q.fail(job.jobId, job.lease!.claimToken, { message: 'identity refused', retryable: false, classification: 'fatal', recordedAt: Date.now() });
    expect(await q.clearTerminalJob(job.jobId)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    await q.recover(job.jobId);
    await expect(q.cancel(job.jobId)).rejects.toThrow('obligation');
    await store.close();
  });

  it('fences reopening through pending inventory recovery, including a fresh agent, then releases it after worker success', async () => {
    const { store, agent, freshAgent, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'catalog', killSwitchActive: false, active: true, authoringAllowed: true });
    agent.commitRfc64SwmAuthorInventoryV1 = async () => {
      throw new SwmInventoryWriteFailure('inventory-maintenance', null, inventoryPersistenceFailure(new Error('inventory CAS unavailable')));
    };
    const failure = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR }).catch(e => e);
    expect(failure.observation.state).toBe('pending');
    const original = await agent.promoteQueue.getStatus(failure.observation.jobId);
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    const { agent: restarted } = await freshAgent();
    await expect(restarted.assertion.pullFrom(CG, NAME, 'swm', { agentAddress: AUTHOR }))
      .rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED', recoveryJobId: original.jobId });
    await expect(restarted.assertion.discard(CG, NAME, { agentAddress: AUTHOR }))
      .rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    expect((await restarted.promoteQueue.getStatus(original.jobId)).request.recoveryBinding).toEqual(original.request.recoveryBinding);
    restarted.commitRfc64SwmAuthorInventoryV1 = async () => ({ status: 'applied', attempts: 1, headObjectDigest: 'confirmed-head', kaUal: 'did:dkg:confirmed-asset' });
    restarted.requestRfc64SwmCatalogProjectionV1 = () => true;
    const worker = createPromoteWorkerSupervisor({ agent: restarted, workerConcurrency: 1, pollIntervalMs: 10, log: () => undefined });
    try {
      await worker.start();
      await vi.waitFor(async () => expect((await restarted.promoteQueue.getStatus(original.jobId)).state).toBe('succeeded'));
      expect((await restarted.promoteQueue.getStatus(original.jobId)).request.recoveryBinding).toEqual(original.request.recoveryBinding);
      expect(await restarted.assertion.pullFrom(CG, NAME, 'swm', { agentAddress: AUTHOR })).toMatchObject({ seeded: 1 });
    } finally { await worker.stop(); await store.close(); }
  });

  it.each([true, false])('returns a defined HTTP conflict for concurrent prepared shares (owner readable=%s)', async readable => {
    const { store, agent, publisher } = await setup();
    daemonState.promoteWorkerAvailable = true;
    const assertion = agent.assertion;
    let calls = 0, releaseSecond!: () => void, bothPrepared!: () => void;
    const ready = new Promise<void>(resolve => { bothPrepared = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    vi.spyOn(agent, 'assertion', 'get').mockReturnValue({ ...assertion, prepareDurableShare: async (...args) => {
      const index = ++calls, prepared = await assertion.prepareDurableShare(...args);
      if (index === 1) await ready;
      else { bothPrepared(); await secondGate; }
      return prepared;
    } });
    const { post, close } = await serveShares(agent);
    try {
      const winner = post();
      await vi.waitFor(() => expect(calls).toBe(1));
      const stale = post();
      const success = await winner;
      expect(success.status).toBe(200);
      const original = await success.json();
      const jobs = await agent.promoteQueue.list();
      if (!readable) vi.spyOn(agent.promoteQueue, 'list').mockRejectedValue(new Error('queue observation unavailable'));
      releaseSecond();
      const conflict = await stale, body = await conflict.json();
      expect(conflict.status).toBe(409);
      expect(jobs).toHaveLength(1);
      expect(body).toMatchObject({ code: 'SHARE_ADMISSION_STALE', retryable: false });
      if (readable) expect(body).toMatchObject({ recoveryState: 'completed', recoveryJobId: jobs[0].jobId });
      else expect(body).not.toHaveProperty('recoveryJobId');
      expect(body).not.toHaveProperty('recoveryBinding'); expect(body).not.toHaveProperty('claimToken');
      expect(jobs[0].request.recoveryBinding?.intent.operationId).toBe(original.shareOperationId);
      expect(await publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
      await expect(agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: AUTHOR })).resolves.toBeDefined();
    } finally {
      releaseSecond(); await close(); await store.close();
    }
  });

  it('refuses the legacy shortcut over HTTP when a bound inventory obligation lost its intent', async () => {
    const { store, agent, publisher, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'catalog', killSwitchActive: false, active: true, authoringAllowed: true });
    agent.commitRfc64SwmAuthorInventoryV1 = async () => {
      throw new SwmInventoryWriteFailure('inventory-maintenance', null, inventoryPersistenceFailure(new Error('inventory CAS unavailable')));
    };
    const { post, close } = await serveShares(agent);
    try {
      const interrupted = await post(); expect(interrupted.status).toBe(503);
      const failure = await interrupted.json(), original = await agent.promoteQueue.getStatus(failure.recoveryJobId);
      expect(original.state).toBe('failed_retrying');
      expect(await publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
      await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: 'http://dkg.io/ontology/promoteOperationIntent' });
      const repeated = await post(); expect(repeated.status).toBe(409);
      expect(await repeated.json()).toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
      expect(await agent.promoteQueue.getStatus(original.jobId)).toEqual(original);
      expect(await agent.promoteQueue.list()).toHaveLength(1);
      expect(await publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(false);
      await expect(agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: AUTHOR })).rejects.toMatchObject({ code: 'PUBLISH_NOT_FULL_SHARE' });
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
      expect(await agent.promoteQueue.clearTerminalJob(original.jobId)).toMatchObject({ outcome: 'rejected' });
    } finally { await close(); await store.close(); }
  });

  it('rejects a stale prepared admission without revoking the completed winner', async()=>{
    const {store,agent,publisher}=await setup();
    const first=await agent.assertion.prepareDurableShare(CG,NAME,{agentAddress:AUTHOR});
    const second=await agent.assertion.prepareDurableShare(CG,NAME,{agentAddress:AUTHOR});
    expect(first.recoveryBinding.intent.operationId).not.toBe(second.recoveryBinding.intent.operationId);
    const job=await agent.assertion.admitDurableShare({contextGraphId:CG,assertionName:NAME,entities:'all',...first},'winner');
    expect((await runPromoteJob({job,queue:agent.promoteQueue,workerId:'winner',now:Date.now,
      heartbeatIntervalMs:60_000,log:()=>undefined,runPromote:()=>agent.assertion.promote(CG,NAME,first)})).outcome).toBe('succeeded');
    const publishable=await agent.resolveFinalizedAssertionVmPublishIntent(CG,NAME,{agentAddress:AUTHOR});
    await expect(agent.assertion.admitDurableShare({contextGraphId:CG,assertionName:NAME,entities:'all',...second},'stale'))
      .rejects.toMatchObject({code:'KA_PROMOTE_RECOVERY_BINDING_CONFLICT'});
    expect(await publisher.hasSwmShareComplete(CG,NAME,AUTHOR)).toBe(true);
    expect(await agent.resolveFinalizedAssertionVmPublishIntent(CG,NAME,{agentAddress:AUTHOR})).toEqual(publishable);
    expect(await agent.promoteQueue.list()).toHaveLength(1);
    expect((await agent.promoteQueue.getStatus(job.jobId))?.state).toBe('succeeded');
    await store.close();
  });

  it.each(['corrupt', 'missing', 'changed'])('revokes a publication certificate on %s bound replay after inventory failure', async corruption => {
    const {store,agent,publisher,finalized}=await setup();
    daemonState.promoteWorkerAvailable=true;
    agent.resolveRfc64CatalogReceiverAuthorityV1=()=>({mode:'catalog',killSwitchActive:false,active:true,authoringAllowed:true});
    agent.commitRfc64SwmAuthorInventoryV1=async()=>{throw new SwmInventoryWriteFailure('inventory-maintenance',null,inventoryPersistenceFailure(new Error('inventory unavailable')));};
    const failure=await durableSynchronousShare(agent,CG,NAME,{agentAddress:AUTHOR}).catch(e=>e);
    const job=(await agent.promoteQueue.getStatus(failure.observation.jobId))!;
    expect(job.state).toBe('failed_retrying');
    expect(await publisher.hasSwmShareComplete(CG,NAME,AUTHOR)).toBe(true);
    await store.deleteByPattern({graph:contextGraphMetaUri(CG),subject:lifecycle,predicate:'http://dkg.io/ontology/promoteOperationIntent'});
    if(corruption!=='missing')await store.insert([{graph:contextGraphMetaUri(CG),subject:lifecycle,
      predicate:'http://dkg.io/ontology/promoteOperationIntent',object:JSON.stringify(corruption==='corrupt'?'not-json':JSON.stringify({
        ...job.request.recoveryBinding!.intent,timestampMs:job.request.recoveryBinding!.intent.timestampMs+1}))}]);
    const worker=createPromoteWorkerSupervisor({agent,workerConcurrency:1,pollIntervalMs:10,log:()=>undefined});
    try {
      await worker.start();
      await vi.waitFor(async()=>expect((await agent.promoteQueue.getStatus(job.jobId))?.state).toBe('failed'));
      expect(await publisher.hasSwmShareComplete(CG,NAME,AUTHOR)).toBe(false);
      await expect(agent.resolveFinalizedAssertionVmPublishIntent(CG,NAME,{agentAddress:AUTHOR})).rejects.toMatchObject({code:'PUBLISH_NOT_FULL_SHARE'});
      expect(await agent.promoteQueue.clearTerminalJob(job.jobId)).toMatchObject({outcome:'rejected'});
      await expect(agent.assertion.discard(CG,NAME,{agentAddress:AUTHOR})).rejects.toMatchObject({code:'KA_PROMOTE_RECOVERY_REQUIRED'});
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    } finally {await worker.stop();await store.close();}
  });

  it('preserves the certificate when bound evidence cannot temporarily be read', async()=>{
    const {store,agent,publisher}=await setup();
    const bound=await agent.assertion.prepareDurableShare(CG,NAME,{agentAddress:AUTHOR});
    await agent.assertion.promote(CG,NAME,bound);
    const query=store.query.bind(store);
    vi.spyOn(store,'query').mockImplementationOnce(async()=>{throw new StoreSchedulerBusyError('queue_wait_timeout','normal','test.read',{storeOperation:'query'});});
    await expect(publisher.assertionPromote(CG,NAME,AUTHOR,bound)).rejects.toThrow();
    vi.mocked(store.query).mockImplementation(query);
    expect(await publisher.hasSwmShareComplete(CG,NAME,AUTHOR)).toBe(true);
    await store.close();
  });

  it.each(['before-publisher', 'inside-publisher'])('fences an expired executor %s across real queue takeover', async pause => {
    const { store, agent, publisher, finalized } = await setup();
    let now = Date.now(), entered = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queue = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100, backoff: () => 0 });
    const bound = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    const job = await queue.enqueueAndClaim({ contextGraphId: CG, assertionName: NAME, entities: 'all', ...bound }, 'old');
    if (pause === 'before-publisher') {
      const promote = publisher.assertionPromote.bind(publisher);
      vi.spyOn(publisher, 'assertionPromote').mockImplementationOnce(async (...args) => {
        entered = true; await gate; return promote(...args);
      });
    } else {
      const insert = store.insert.bind(store);
      vi.spyOn(store, 'insert').mockImplementation(async quads => {
        if (!entered && quads.some(q => q.subject === lifecycle && q.predicate.endsWith('/state') && q.object === '"promoted"')) {
          entered = true; await gate; throw new Error('old lifecycle write failed');
        }
        return insert(quads);
      });
    }
    const execute = (q: typeof queue, claim: typeof job) => runPromoteJob({ job: claim, queue: q,
      workerId: claim.lease!.workerId, now: () => now, heartbeatIntervalMs: 60_000, bookkeepingRetryBudgetMs: 0,
      log: () => undefined, runPromote: (request, executionAuthority) => executePromoteRequest(agent, request, { executionAuthority }) });
    const old = execute(queue, job);
    await vi.waitFor(() => expect(entered).toBe(true));
    now += 101;
    const reopened = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100, backoff: () => 0 });
    const replacement = (await reopened.claimNext('new'))!;
    expect(replacement.jobId).toBe(job.jobId);
    let replacementDone = false;
    const next = execute(reopened, replacement).finally(() => { replacementDone = true; });
    if (pause === 'inside-publisher') {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(replacementDone).toBe(false);
      release();
    }
    expect((await next).outcome).toBe('succeeded');
    const publishable = await agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: AUTHOR });
    const tail = vi.spyOn(agent, 'afterDurableSwmPromotionV1');
    if (pause === 'before-publisher') { store.remaining = 1; release(); }
    expect((await old).outcome).toBe('failure_bookkeeping_uncertain');
    expect(tail).not.toHaveBeenCalled();
    if (pause === 'before-publisher') expect(store.remaining).toBe(1);
    expect(await publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    expect(await agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: AUTHOR })).toEqual(publishable);
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    expect(await store.countQuads(finalized.graphUri)).toBe(0);
    expect(await reopened.getStatus(job.jobId)).toMatchObject({ state: 'succeeded', attempt: { count: 2 }, request: { recoveryBinding: bound.recoveryBinding } });
    await store.close();
  });

  it('fences a claim that expires while waiting for the publisher lifecycle lock', async () => {
    const { store, agent, publisher, finalized } = await setup();
    let now = Date.now(), release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queue = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100, backoff: () => 0 });
    const bound = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    const job = await queue.enqueueAndClaim({ contextGraphId: CG, assertionName: NAME, entities: 'all', ...bound }, 'old');
    const locked = (publisher as any).withAssertionLifecycleWriteLock(CG, NAME, AUTHOR, undefined, () => gate);
    const lockEntry = vi.spyOn(publisher as any, 'withAssertionLifecycleWriteLock');
    const clear = vi.spyOn(publisher as any, 'clearSwmShareCompleteUnlocked');
    const tail = vi.spyOn(agent, 'afterDurableSwmPromotionV1');
    const execute = (q: typeof queue, claim: typeof job) => runPromoteJob({ job: claim, queue: q,
      workerId: claim.lease!.workerId, now: () => now, heartbeatIntervalMs: 60_000, bookkeepingRetryBudgetMs: 0,
      log: () => undefined, runPromote: (request, executionAuthority) => executePromoteRequest(agent, request, { executionAuthority }) });
    const old = execute(queue, job);
    // Entry into this lock is after the execution section's first claim check.
    await vi.waitFor(() => expect(lockEntry).toHaveBeenCalled());
    now += 101;
    const reopened = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100, backoff: () => 0 });
    const replacement = (await reopened.claimNext('new'))!;
    expect(replacement.jobId).toBe(job.jobId);
    release(); await locked;
    expect((await old).outcome).toBe('failure_bookkeeping_uncertain');
    expect(clear).not.toHaveBeenCalled(); expect(tail).not.toHaveBeenCalled();
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    expect(await store.countQuads(finalized.graphUri)).toBe(1);
    expect((await execute(reopened, replacement)).outcome).toBe('succeeded');
    expect(await publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    expect(await store.countQuads(finalized.graphUri)).toBe(0);
    expect(await reopened.getStatus(job.jobId)).toMatchObject({ state: 'succeeded', attempt: { count: 2 }, request: { recoveryBinding: bound.recoveryBinding } });
    await store.close();
  });

  it.each(['before-tail', 'inside-tail'])('fences expired domain work %s independently of the publisher lock', async pause => {
    const { store, agent, publisher, finalized } = await setup();
    let now = Date.now(), entered = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'catalog', killSwitchActive: false, active: true, authoringAllowed: true });
    const inventory = vi.fn(async () => {
      if (pause === 'inside-tail' && !entered) { entered = true; await gate; }
      return { status: 'applied', attempts: 1, headObjectDigest: 'same-head', kaUal: 'did:dkg:confirmed-asset' };
    });
    agent.commitRfc64SwmAuthorInventoryV1 = inventory;
    agent.requestRfc64SwmCatalogProjectionV1 = () => true;
    if (pause === 'before-tail') {
      const promote = publisher.assertionPromote.bind(publisher);
      vi.spyOn(publisher, 'assertionPromote').mockImplementationOnce(async (...args) => {
        const result = await promote(...args); entered = true; await gate; return result;
      });
    }
    const queue = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100, backoff: () => 0 });
    const bound = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    const job = await queue.enqueueAndClaim({ contextGraphId: CG, assertionName: NAME, entities: 'all', ...bound }, 'old');
    const execute = (q: typeof queue, claim: typeof job, heartbeatIntervalMs: number) => runPromoteJob({ job: claim, queue: q,
      workerId: claim.lease!.workerId, now: () => now, heartbeatIntervalMs, bookkeepingRetryBudgetMs: 0,
      log: () => undefined, runPromote: (request, executionAuthority) => executePromoteRequest(agent, request, { executionAuthority }) });
    const old = execute(queue, job, 60_000);
    await vi.waitFor(() => expect(entered).toBe(true)); now += 101;
    const reopened = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100, backoff: () => 0 });
    const replacement = (await reopened.claimNext('new'))!;
    const heartbeat = vi.spyOn(reopened, 'heartbeat');
    const clear = vi.spyOn(publisher as any, 'clearSwmShareCompleteUnlocked');
    let done = false;
    const next = execute(reopened, replacement, 10).finally(() => { done = true; });
    if (pause === 'inside-tail') {
      now += 50;
      await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
      expect((await reopened.getStatus(job.jobId))?.lease?.expiresAt).toBeGreaterThan(now);
      expect(done).toBe(false); expect(clear).not.toHaveBeenCalled();
      release();
    }
    expect((await next).outcome).toBe('succeeded');
    const publishable = await agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: AUTHOR });
    const tail = vi.spyOn(agent, 'afterDurableSwmPromotionV1');
    vi.mocked(agent.publishWorkspaceGossip).mockClear(); inventory.mockClear(); clear.mockClear();
    if (pause === 'before-tail') release();
    expect((await old).outcome).toBe(pause === 'before-tail' ? 'failure_bookkeeping_uncertain' : 'partial_promote_ambiguity');
    expect(tail).not.toHaveBeenCalled(); expect(inventory).not.toHaveBeenCalled();
    expect(agent.publishWorkspaceGossip).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
    expect(await publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    expect(await agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: AUTHOR })).toEqual(publishable);
    expect(await reopened.getStatus(job.jobId)).toMatchObject({ state: 'succeeded', attempt: { count: 2 }, request: { recoveryBinding: bound.recoveryBinding } });
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
    await store.close();
  });

  it('reclaims a bound completed share after success bookkeeping fails with swmInserted=true', async()=>{
    const {store,agent,finalized}=await setup();let now=Date.now();
    const queue=new TripleStoreAsyncPromoteQueue(store,{now:()=>now,leaseMs:100,backoff:()=>0});
    const bound=await agent.assertion.prepareDurableShare(CG,NAME,{agentAddress:AUTHOR});
    const job=await queue.enqueueAndClaim({contextGraphId:CG,assertionName:NAME,entities:'all',...bound},'old');
    vi.spyOn(queue,'succeed').mockRejectedValue(new Error('success bookkeeping unavailable'));
    const outcome=await runPromoteJob({job,queue,workerId:'old',now:()=>now,heartbeatIntervalMs:25,bookkeepingRetryBudgetMs:0,
      log:()=>undefined,runPromote:()=>agent.assertion.promote(CG,NAME,bound)});
    expect(outcome.outcome).toBe('partial_promote_ambiguity');
    expect(await queue.getStatus(job.jobId)).toMatchObject({state:'running',commitMarker:{promoteStarted:true,swmInserted:true}});
    const content=await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${finalized.sharedGraphUri}> { ?s ?p ?o } }`);
    now+=101;
    const reopened=new TripleStoreAsyncPromoteQueue(store,{now:()=>now,leaseMs:100,backoff:()=>0});
    vi.spyOn(agent,'promoteQueue','get').mockReturnValue(reopened);
    const worker=createPromoteWorkerSupervisor({agent,workerConcurrency:1,pollIntervalMs:10,heartbeatIntervalMs:25,bookkeepingRetryBudgetMs:0,log:()=>undefined});
    try {
      await worker.start();
      await vi.waitFor(async()=>expect((await reopened.getStatus(job.jobId))?.state).toBe('succeeded'));
      expect(await reopened.getStatus(job.jobId)).toMatchObject({attempt:{count:2},request:{recoveryBinding:bound.recoveryBinding}});
      expect(await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${finalized.sharedGraphUri}> { ?s ?p ?o } }`)).toEqual(content);
      await expect(reopened.succeed(job.jobId,job.lease!.claimToken,{promotedCount:1,succeededAt:now})).rejects.toThrow();
    } finally {await worker.stop();await store.close();}
  });

  it('refuses a stale prepared seal before persisting an owner if reopening won the lifecycle lock', async () => {
    const { store, agent } = await setup();
    await agent.assertion.promote(CG, NAME, { agentAddress: AUTHOR });
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    await agent.assertion.pullFrom(CG, NAME, 'swm', { agentAddress: AUTHOR });
    await expect(agent.assertion.admitDurableShare({ contextGraphId: CG, assertionName: NAME, entities: 'all', ...prepared }, 'inline'))
      .rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT' });
    expect(await agent.promoteQueue.list({})).toEqual([]);
    await store.close();
  });

  it('holds the lifecycle lock until admission is durable, so a concurrent reopen cannot erase its seal', async () => {
    const { store, agent } = await setup();
    await agent.assertion.promote(CG, NAME, { agentAddress: AUTHOR });
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    const enqueue = agent.promoteQueue.enqueueAndClaim.bind(agent.promoteQueue);
    let release!: () => void, entered = false;
    const wait = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(agent.promoteQueue, 'enqueueAndClaim').mockImplementation(async (request, worker) => {
      entered = true; await wait; return enqueue(request, worker);
    });
    const admission = agent.assertion.admitDurableShare({ contextGraphId: CG, assertionName: NAME, entities: 'all', ...prepared }, 'inline');
    await vi.waitFor(() => expect(entered).toBe(true));
    let finished = false;
    const reopening = agent.assertion.pullFrom(CG, NAME, 'swm', { agentAddress: AUTHOR }).catch((error: unknown) => error)
      .finally(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    release(); const job = await admission;
    expect(await reopening).toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED', recoveryJobId: job.jobId });
    await store.close();
  });

  it('fails before content mutation when atomic queue persistence is refused', async () => {
    const { store, agent, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    const assertion = agent.assertion;
    const promote = vi.fn(assertion.promote);
    vi.spyOn(agent, 'assertion', 'get').mockReturnValue({ ...assertion, promote });
    vi.spyOn(store, 'replaceSubject').mockRejectedValue(new UnsupportedTripleStoreCapabilityError('replaceSubject'));
    const error = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR }).catch(e => e);
    expect(error).toBeInstanceOf(DurableShareFailure);
    expect(error.cause).toBeInstanceOf(PromoteAdmissionUncertainError);
    expect(error.observation).toEqual({ state: 'admission-unconfirmed', jobId: error.cause.jobId });
    expect(await agent.promoteQueue.getStatus(error.cause.jobId)).toBeNull();
    expect(promote).not.toHaveBeenCalled();
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    expect(await store.countQuads(finalized.graphUri)).toBe(1);
    await store.close();
  });
  it('recovers an admission whose atomic write committed but its acknowledgement was lost', async () => {
    const { store, agent, finalized } = await setup();
    let now = Date.now();
    const q = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100 });
    daemonState.promoteWorkerAvailable = true;
    vi.spyOn(agent, 'promoteQueue', 'get').mockReturnValue(q);
    const assertion = agent.assertion;
    const promote = vi.fn(assertion.promote);
    vi.spyOn(agent, 'assertion', 'get').mockReturnValue({ ...assertion, promote });
    const replace = store.replaceSubject.bind(store);
    vi.spyOn(store, 'replaceSubject').mockImplementationOnce(async (...args) => {
      await replace(...args); throw new Error('acknowledgement lost');
    });
    const error = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR }).catch(e => e);
    expect(error).toBeInstanceOf(DurableShareFailure);
    expect(error.cause).toBeInstanceOf(PromoteAdmissionUncertainError);
    expect(error.observation).toEqual({ state: 'admission-unconfirmed', jobId: error.cause.jobId });
    const persisted = await q.getStatus(error.cause.jobId);
    expect(persisted?.state).toBe('running');
    expect(promote).not.toHaveBeenCalled();
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    expect(await store.countQuads(finalized.graphUri)).toBe(1);
    now += 101;
    const reopened = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100 });
    const reclaimed = await reopened.claimNext('new');
    expect(reclaimed?.jobId).toBe(error.cause.jobId);
    expect(reclaimed?.request.recoveryBinding).toEqual(persisted.request.recoveryBinding);
    expect(await assertion.promote(CG, NAME, { agentAddress: AUTHOR, recoveryBinding: reclaimed.request.recoveryBinding })).toMatchObject({
      promotedCount: 1, shareOperationId: persisted.request.recoveryBinding.intent.operationId,
    });
    await store.close();
  });

  it('leaves unknown bound formats untouched and refuses a competing owner', async () => {
    const { serializeJobRecord } = await import('../../publisher/src/async-promote-queue-utils.js');
    const { store, agent } = await setup();
    const bound = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    const q = agent.promoteQueue;
    const request = { contextGraphId: CG, assertionName: NAME, entities: 'all' as const, ...bound };
    const job = await q.enqueueAndClaim(request, 'owner');
    const graph = 'urn:dkg:promote-queue:control-plane';
    const record = serializeJobRecord({ ...job, formatVersion: 5, state: 'queued', lease: undefined }, graph);
    await store.replaceSubject(graph, record.jobRef, record.jobQuads);
    expect(await q.claimNext('future')).toBeNull();
    await expect(q.enqueueAndClaim(request, 'competing')).rejects.toThrow('unreadable');
    await store.close();
  });

  it('rechecks current recipient authority and preserves the admitted curator requirement', async () => {
    const { store, agent, finalized } = await setup();
    const bound = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    agent.resolveWorkspaceRecipientsGated = async () => { throw new Error('current authority denied'); };
    await expect(agent.assertion.promote(CG, NAME, bound)).rejects.toThrow('current authority denied');
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    agent.resolveWorkspaceRecipientsGated = async () => ({ requiresEncryption: false, recipients: [] });
    const confirmer = vi.fn(async () => undefined);
    agent.buildCuratorAckConfirmer = confirmer;
    const required = { ...bound.recoveryBinding, intent: { ...bound.recoveryBinding.intent, confirmationRequired: true } };
    await expect(agent.assertion.promote(CG, NAME, { ...bound, recoveryBinding: required, awaitCuratorAck: false }))
      .rejects.toMatchObject({ code: 'KA_PROMOTE_CONFIRMATION_REQUIRED' });
    expect(confirmer.mock.calls[0]?.[2]).toMatchObject({ awaitCuratorAck: true });
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    expect(await store.countQuads(finalized.graphUri)).toBe(1);
    await store.close();
  });

});

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { OxigraphStore, StoreSchedulerBusyError, UnsupportedTripleStoreCapabilityError, type Quad } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue, CuratorRejectedError } from '@origintrail-official/dkg-publisher';
import { createPromotionAgentForTest } from '../../agent/test/_helpers/promotion-agent.js';
import { makeTestKaNumberAllocator } from '../../agent/test/_helpers/ka-allocator.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { durableSynchronousShare } from '../src/daemon/routes/durable-synchronous-share.js';
import { daemonState } from '../src/daemon/state.js';
import { createPromoteWorkerSupervisor } from '../src/daemon/worker/async-promote-worker.js';

const CG = 'durable-sync-2963', NAME = 'asset', AUTHOR = `0x${'11'.repeat(20)}`;
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
    agent.configurePromoteQueue({ backoff: () => 0, maxRetries: 1 });
    return { agent, publisher };
  };
  const { agent, publisher } = await freshAgent();
  await publisher.assertionCreate(CG, NAME, AUTHOR);
  await publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:asset', predicate: 'https://schema.org/name', object: '"original"' }]);
  const finalized = await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR });
  return { store, agent, publisher, freshAgent, finalized };
}
afterEach(() => { daemonState.promoteWorkerAvailable = false; });

describe('durable synchronous share ownership', () => {
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
    const { store, agent, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    if (kind === 'incomplete') store.remaining = 1;
    await agent.assertion.promote(CG, NAME, { agentAddress: AUTHOR }).catch(() => undefined);
    await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: lifecycle,
      predicate: 'http://dkg.io/ontology/promoteOperationIntent' });
    if (kind === 'changed-content') await store.insert([{ graph: finalized.sharedGraphUri,
      subject: 'urn:extra', predicate: 'urn:p', object: '"changed"' }]);
    const admission = vi.spyOn(agent.promoteQueue, 'enqueueAndClaim');
    await expect(durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR })).rejects.toThrow();
    expect(admission).not.toHaveBeenCalled();
    await store.close();
  });

  it.each([true, false])('automatically repairs a partial commit beyond the ordinary attempt cap (typed=%s)', async typed => {
    const { store, agent, freshAgent, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    store.typed = typed; store.remaining = 2;
    const error = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR }).catch(e => e);
    expect(error.recoveryState).toBe('pending');
    const failed = await agent.promoteQueue.getStatus(error.recoveryJobId);
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
      await vi.waitFor(async () => expect((await restarted.promoteQueue.getStatus(error.recoveryJobId)).state).toBe('succeeded'), { timeout: 10_000 });
      const recovered = await restarted.promoteQueue.getStatus(error.recoveryJobId);
      expect(recovered.request.recoveryBinding).toEqual(failed.request.recoveryBinding);
      expect(recovered.attempt.count).toBe(3);
      expect(await restarted.assertion.history(CG, NAME, { agentAddress: AUTHOR })).toMatchObject({ state: 'promoted', memoryLayer: 'SWM' });
      expect(await store.countQuads(finalized.sharedGraphUri)).toBe(1);
      expect(await store.countQuads(finalized.graphUri)).toBe(0);
      const prepared = await restarted.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
      expect(prepared.recoveryBinding).toEqual(failed.request.recoveryBinding);
    } finally { await supervisor.stop(); await store.close(); }
  });

  it('automatically retries curator non-confirmation with the original required acknowledgement', async () => {
    const { store, agent, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    let connected = false;
    const confirmation = vi.fn(async () => ({ applied: connected }));
    agent.buildCuratorAckConfirmer = async () => confirmation;
    const error = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR, awaitCuratorAck: true }).catch(e => e);
    expect(error.code).toBe('CURATOR_UNCONFIRMED');
    const failed = await agent.promoteQueue.getStatus(error.recoveryJobId);
    expect(failed.state).toBe('failed_retrying');
    expect(failed.request.recoveryBinding.intent.confirmationRequired).toBe(true);
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    connected = true;
    const supervisor = createPromoteWorkerSupervisor({ agent, workerConcurrency: 1, pollIntervalMs: 10, log: () => undefined });
    try {
      await supervisor.start();
      await vi.waitFor(async () => expect((await agent.promoteQueue.getStatus(error.recoveryJobId)).state).toBe('succeeded'));
      expect((await agent.promoteQueue.getStatus(error.recoveryJobId)).request.recoveryBinding).toEqual(failed.request.recoveryBinding);
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

  it('keeps permanent curator rejection in an inspection hold', async () => {
    const { store, agent } = await setup();
    daemonState.promoteWorkerAvailable = true;
    agent.buildCuratorAckConfirmer = async () => async () => { throw new CuratorRejectedError(CG); };
    const error = await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR, awaitCuratorAck: true }).catch(e => e);
    expect(error.code).toBe('CURATOR_REJECTED');
    expect((await agent.promoteQueue.getStatus(error.recoveryJobId)).state).toBe('failed');
    await store.close();
  });

  it.each([
    ['legacy', false, false], ['catalog', true, false], ['catalog', false, true], ['shadow', false, true],
  ])('captures effective %s admission with kill switch %s as inventoryRequired=%s', async (mode, killSwitchActive, required) => {
    const { store, agent } = await setup();
    agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode, killSwitchActive, active: false });
    const prepared = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    expect(prepared.recoveryBinding.inventoryRequired).toBe(required);
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

  it('keeps a complete pre-intent VM asset a read-only no-op', async () => {
    const { store, agent, finalized } = await setup();
    daemonState.promoteWorkerAvailable = true;
    await agent.assertion.promote(CG, NAME, { agentAddress: AUTHOR });
    const vm = finalized.sharedGraphUri.replace('/_shared_memory/', '/_verifiable_memory/');
    await store.insert(finalized.publicQuads.map(q => ({ ...q, graph: vm })));
    await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: 'http://dkg.io/ontology/promoteOperationIntent' });
    await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer' });
    await store.insert([{ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"VM"' }]);
    const admission = vi.spyOn(agent.promoteQueue, 'enqueueAndClaim');
    const insert = vi.spyOn(store, 'insert');
    expect(await durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR })).toEqual({ promotedCount: 0, sealed: true, publishReady: false });
    expect(admission).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    await store.insert([{ graph: vm, subject: 'urn:extra', predicate: 'urn:p', object: '"corrupt"' }]);
    await expect(durableSynchronousShare(agent, CG, NAME, { agentAddress: AUTHOR })).rejects.toThrow();
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

  it('fails before content mutation when atomic queue persistence is refused', async () => {
    const { store, agent, finalized } = await setup();
    const bound = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    vi.spyOn(store, 'replaceSubject').mockRejectedValue(new UnsupportedTripleStoreCapabilityError('replaceSubject'));
    await expect(agent.promoteQueue.enqueueAndClaim({ contextGraphId: CG, assertionName: NAME, entities: 'all', ...bound }, 'inline')).rejects.toMatchObject({ code: 'SHARE_ADMISSION_UNCERTAIN' });
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    expect(await store.countQuads(finalized.graphUri)).toBe(1);
    await store.close();
  });
  it('recovers an admission whose atomic write committed but its acknowledgement was lost', async () => {
    const { store, agent, finalized } = await setup();
    let now = Date.now();
    const q = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100 });
    const bound = await agent.assertion.prepareDurableShare(CG, NAME, { agentAddress: AUTHOR });
    const replace = store.replaceSubject.bind(store);
    vi.spyOn(store, 'replaceSubject').mockImplementationOnce(async (...args) => {
      await replace(...args); throw new Error('acknowledgement lost');
    });
    const error = await q.enqueueAndClaim({ contextGraphId: CG, assertionName: NAME, entities: 'all', ...bound }, 'lost')
      .catch(error => error);
    expect(error.recoveryState).toBe('admission-unconfirmed');
    expect((await q.getStatus(error.recoveryJobId))?.state).toBe('running');
    expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
    now += 101;
    const reopened = new TripleStoreAsyncPromoteQueue(store, { now: () => now, leaseMs: 100 });
    const reclaimed = await reopened.claimNext('new');
    expect(reclaimed?.jobId).toBe(error.recoveryJobId);
    expect(reclaimed?.request.recoveryBinding).toEqual(bound.recoveryBinding);
    expect(await agent.assertion.promote(CG, NAME, bound)).toMatchObject({
      promotedCount: 1, shareOperationId: bound.recoveryBinding.intent.operationId,
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

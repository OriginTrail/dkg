import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { PromoteJobLeaseError } from '@origintrail-official/dkg-publisher';
import { createPromotionAgentForTest } from '../../agent/test/_helpers/promotion-agent.js';
import { makeTestKaNumberAllocator } from '../../agent/test/_helpers/ka-allocator.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { ensureSubGraphRegistration } from '../../publisher/src/sub-graph-registration.js';
import { createPromoteWorkerSupervisor, runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';
import { executePromoteRequest } from '../src/daemon/worker/execute-promote-request.js';

const CG = 'async-recovery', NAME = 'asset', AUTHOR = `0x${'11'.repeat(20)}`;
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(s => s.close())); });
async function setup(subGraphName?: string) {
  const store = new OxigraphStore(); stores.push(store);
  const { agent, publisher } = await createPromotionAgentForTest(store, {
    agentAddress: AUTHOR, peerId: '12D3KooWRecovery', kaAllocator: makeTestKaNumberAllocator(),
  });
  agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'legacy', killSwitchActive: false });
  let time = Date.now();
  agent.configurePromoteQueue({ now: () => time, leaseMs: 1000 });
  if (subGraphName) await ensureSubGraphRegistration(store, { contextGraphId: CG, subGraphName, createdBy: '12D3KooWRecovery', timestamp: new Date() });
  await publisher.assertionCreate(CG, NAME, AUTHOR, subGraphName);
  await publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:asset', predicate: 'urn:value', object: '"original"' }], subGraphName);
  const finalized = await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR, subGraphName });
  const queue = agent.promoteQueue;
  const { jobId } = await agent.assertion.promoteAsync(CG, NAME, { subGraphName, agentAddress: AUTHOR });
  const claim = () => queue.claimNext('worker');
  const run = (job: any, overrides: any = {}) => runPromoteJob({ job, queue, workerId: 'worker', now: () => time,
    heartbeatIntervalMs: 0, log: () => {}, prepareJob: j => agent.assertion.prepareQueuedShare(j),
    runPromote: (request, executionAuthority) => executePromoteRequest(agent, request, { executionAuthority }), ...overrides });
  return { agent, publisher, queue, store, finalized, jobId, claim, run, expire: () => { time += 1001; } };
}

describe('async shares acquire durable replay authority before promotion', () => {
  it('wires binding into the production supervisor without changing admission', async () => {
    const f = await setup();
    const supervisor = createPromoteWorkerSupervisor({ agent: f.agent, workerConcurrency: 1,
      heartbeatIntervalMs: 0, bookkeepingRetryBudgetMs: 100, pollIntervalMs: 1000, postCommitRecoveryIntervalMs: 0, log: () => {} });
    try {
      await supervisor.start();
      await supervisor.tickOnce();
      await expect.poll(async () => (await f.queue.getStatus(f.jobId)).state).toBe('succeeded');
      expect((await f.queue.getStatus(f.jobId)).request.recoveryBinding).toBeDefined();
      // assertion is a fresh facade getter; persisted binding is the integration assertion.
    } finally { await supervisor.stop(); }
  });

  it.each([undefined, 'subgraph'])('recovers the original job after commit with unchanged payload (%s)', async subGraphName => {
    const f = await setup(subGraphName);
    expect((await f.queue.getStatus(f.jobId)).request.recoveryBinding).toBeUndefined();
    const first = await f.claim();
    let originalBinding: unknown;
    // Execute real promotion, then model process exit before outer success bookkeeping.
    const abort = new AbortController();
    const interrupted = f.run(first, { shutdownSignal: abort.signal, runPromote: async (request: any, executionAuthority: any) => {
      originalBinding = request.recoveryBinding;
      expect(originalBinding).toBeDefined();
      const result = await executePromoteRequest(f.agent, request, { executionAuthority });
      abort.abort();
      return result;
    } });
    await expect(interrupted).rejects.toThrow('shutdown');
    expect((await f.queue.getStatus(f.jobId)).commitMarker).toMatchObject({ promoteStarted: true, swmInserted: false });
    f.expire();
    expect(await f.queue.recoverOnStartup()).toEqual({ reclaimed: 1, abandoned: 0 });
    const replacement = await f.claim();
    expect(replacement.jobId).toBe(f.jobId);
    expect(replacement.request.recoveryBinding).toEqual(originalBinding);
    const result = await f.run(replacement);
    expect(result.outcome).toBe('succeeded');
    expect((await f.queue.getStatus(f.jobId)).state).toBe('succeeded');
    expect(await f.store.countQuads(f.finalized.graphUri)).toBe(0);
    const content = await f.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${f.finalized.sharedGraphUri}> { ?s ?p ?o } }`);
    expect(content.type === 'quads' && content.quads.map(({ subject, predicate, object }) => ({ subject, predicate, object })))
      .toEqual([{ subject: 'urn:asset', predicate: 'urn:value', object: '"original"' }]);
    expect(await f.queue.list({})).toHaveLength(1);
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR, subGraphName)).toBe(true);
    await expect(f.queue.bindRecovery(first.jobId, first.lease.claimToken, originalBinding)).rejects.toBeInstanceOf(PromoteJobLeaseError);
  });

  it('repairs a crash after the internal SWM insert before WM cleanup', async () => {
    const f = await setup();
    const first = await f.claim();
    const abort = new AbortController();
    const replace = f.store.replaceGraph.bind(f.store);
    let injected = false;
    const fault = vi.spyOn(f.store, 'replaceGraph').mockImplementation(async (...args) => {
      await replace(...args);
      if (!injected && args[0] === f.finalized.sharedGraphUri) {
        injected = true; abort.abort(); throw new Error('process exits after SWM insert');
      }
    });
    await expect(f.run(first, { shutdownSignal: abort.signal })).rejects.toThrow('shutdown');
    fault.mockRestore();
    expect(injected).toBe(true);
    expect(await f.store.countQuads(f.finalized.graphUri)).toBeGreaterThan(0);
    expect(await f.store.countQuads(f.finalized.sharedGraphUri)).toBe(1);
    const bound = (await f.queue.getStatus(f.jobId)).request.recoveryBinding;
    f.expire();
    expect(await f.queue.recoverOnStartup()).toEqual({ reclaimed: 1, abandoned: 0 });
    expect((await f.run(await f.claim())).outcome).toBe('succeeded');
    expect((await f.queue.getStatus(f.jobId)).request.recoveryBinding).toEqual(bound);
    expect(await f.store.countQuads(f.finalized.graphUri)).toBe(0);
    const content = await f.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${f.finalized.sharedGraphUri}> { ?s ?p ?o } }`);
    expect(content.type === 'quads' && content.quads.map(q => q.object)).toEqual(['"original"']);
  });

  it('recovers after binding and promoteStarted but before content mutation', async () => {
    const f = await setup();
    const first = await f.claim();
    const { job } = await f.agent.assertion.prepareQueuedShare(first);
    await f.queue.recordCommitMarker(job.jobId, job.lease.claimToken, 'promoteStarted');
    f.expire();
    expect(await f.queue.recoverOnStartup()).toEqual({ reclaimed: 1, abandoned: 0 });
    expect((await f.run(await f.claim())).outcome).toBe('succeeded');
    expect((await f.queue.getStatus(f.jobId)).request.recoveryBinding).toEqual(job.request.recoveryBinding);
  });

  it.each([false, true])('never executes after a binding write fails (committed=%s)', async committed => {
    const f = await setup();
    const first = await f.claim();
    const replace = f.store.replaceSubject.bind(f.store);
    const writer = vi.spyOn(f.store, 'replaceSubject').mockImplementation(async (...args) => {
      if (args[0] === 'urn:dkg:promote-queue:control-plane') {
        if (committed) await replace(...args);
        throw new Error('binding acknowledgement unavailable');
      }
      return replace(...args);
    });
    const runPromote = vi.fn();
    expect((await f.run(first, { runPromote })).outcome).toBe('failure_bookkeeping_uncertain');
    writer.mockRestore();
    expect(runPromote).not.toHaveBeenCalled();
    expect(Boolean((await f.queue.getStatus(f.jobId)).request.recoveryBinding)).toBe(committed);
    expect((await f.queue.getStatus(f.jobId)).commitMarker.promoteStarted).toBe(false);
    f.expire();
    expect(await f.queue.recoverOnStartup()).toEqual({ reclaimed: 1, abandoned: 0 });
    expect((await f.run(await f.claim())).outcome).toBe('succeeded');
  });

  it('does not bind with an expired claim or overwrite a replacement', async () => {
    const f = await setup();
    const stale = await f.claim();
    f.expire();
    await f.queue.recoverOnStartup();
    const replacement = await f.claim();
    const runPromote = vi.fn();
    expect((await f.run(stale, { runPromote })).outcome).toBe('failure_bookkeeping_uncertain');
    expect(runPromote).not.toHaveBeenCalled();
    expect((await f.queue.getStatus(f.jobId)).lease.claimToken).toBe(replacement.lease.claimToken);
    expect((await f.run(replacement)).outcome).toBe('succeeded');
  });

  it('keeps previously started unbound work inspection-required', async () => {
    const f = await setup();
    const first = await f.claim();
    await f.queue.recordCommitMarker(first.jobId, first.lease.claimToken, 'promoteStarted');
    await expect(f.agent.assertion.prepareQueuedShare(first)).rejects.toThrow('unstarted');
    f.expire();
    expect(await f.queue.recoverOnStartup()).toEqual({ reclaimed: 0, abandoned: 1 });
    expect((await f.queue.getStatus(f.jobId)).request.recoveryBinding).toBeUndefined();
  });

  it('preserves legacy queued execution without inventing a binding', async () => {
    const f = await setup();
    const job = await f.claim();
    const legacy = { ...job, formatVersion: 3, request: { ...job.request, agentAddress: undefined } };
    const seal = vi.spyOn(f.agent, 'prepareAtomicAssertionShare');
    expect(await f.agent.assertion.prepareQueuedShare(legacy)).toEqual({ job: legacy });
    expect(seal).not.toHaveBeenCalled();
  });

  it('fails preparation before promotion without marking an unsafe start', async () => {
    const f = await setup();
    vi.spyOn(f.agent, 'prepareAtomicAssertionShare').mockRejectedValueOnce(new Error('invalid sealed payload'));
    const runPromote = vi.fn();
    expect((await f.run(await f.claim(), { runPromote })).outcome).toBe('failed_terminal');
    expect(runPromote).not.toHaveBeenCalled();
    expect((await f.queue.getStatus(f.jobId)).commitMarker.promoteStarted).toBe(false);
  });
});

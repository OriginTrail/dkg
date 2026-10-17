import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-agent', () => import('../../agent/src/index.js'));
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { createPromotionAgentForTest } from '../../agent/test/_helpers/promotion-agent.js';
import { makeTestKaNumberAllocator } from '../../agent/test/_helpers/ka-allocator.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { durableSynchronousShare } from '../src/daemon/routes/durable-synchronous-share.js';
import { runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';
import { executePromoteRequest } from '../src/daemon/worker/execute-promote-request.js';
import { daemonState } from '../src/daemon/state.js';
import { DurableShareFailure } from '../src/daemon/routes/durable-share-failure.js';

const CG = 'preparation-race', NAME = 'asset', AUTHOR = `0x${'11'.repeat(20)}`;
const stores: OxigraphStore[] = [];
afterEach(async () => { daemonState.promoteWorkerAvailable = false; await Promise.all(stores.splice(0).map(s => s.close())); });
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function setup() {
  const store = new OxigraphStore(); stores.push(store);
  const { agent, publisher } = await createPromotionAgentForTest(store, {
    agentAddress: AUTHOR, peerId: '12D3KooWRecovery', kaAllocator: makeTestKaNumberAllocator(),
  });
  agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'legacy', killSwitchActive: false });
  await publisher.assertionCreate(CG, NAME, AUTHOR);
  await publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:asset', predicate: 'urn:value', object: '"original"' }]);
  const finalized = await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR });
  // Use the actual draft query, finalizer and canonical materialization path.
  delete agent.prepareAtomicAssertionShare;
  const prepared = await agent.assertion.prepareDurableShare(CG, NAME);
  const request = { contextGraphId: CG, assertionName: NAME, entities: 'all' as const, ...prepared };
  const queue = agent.promoteQueue;
  const startWorker = (job: any) => runPromoteJob({ job, queue, workerId: 'owner', now: Date.now, log: () => undefined,
    runPromote: (r, executionAuthority) => executePromoteRequest(agent, r, { executionAuthority }) });
  const assertCompleted = async () => {
    expect(await store.countQuads(finalized.graphUri)).toBe(0);
    const payload = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${finalized.sharedGraphUri}> { ?s ?p ?o } }`);
    expect(payload.type === 'quads' && payload.quads.map(({ subject, predicate, object }) => ({ subject, predicate, object })))
      .toEqual([{ subject: 'urn:asset', predicate: 'urn:value', object: '"original"' }]);
    expect((await agent.assertion.prepareDurableShare(CG, NAME)).recoveryBinding).toEqual(prepared.recoveryBinding);
    expect(await publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    await expect(agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, { agentAddress: AUTHOR })).resolves.toBeDefined();
  };
  return { store, agent, publisher, finalized, prepared, request, queue, startWorker, assertCompleted };
}

it('rejects a competing real finalizer before it can restore WM behind owner cleanup', async () => {
  const { store, agent, publisher, finalized, prepared, request, queue, startWorker, assertCompleted } = await setup();
  const job = await agent.assertion.admitDurableShare(request, 'owner');
  const entered = barrier(), resume = barrier(), tail = barrier(), finish = barrier();
  const materialize = publisher.materializeCanonicalWorkingMemory.bind(publisher);
  const mutation = vi.spyOn(publisher, 'materializeCanonicalWorkingMemory').mockImplementation(async (...args) => {
    entered.release(); await resume.promise; return materialize(...args);
  });
  const handoff = agent.afterDurableSwmPromotionV1.bind(agent);
  vi.spyOn(agent, 'afterDurableSwmPromotionV1').mockImplementation(async (...args: any[]) => {
    tail.release(); await finish.promise; return handoff(...args);
  });
  daemonState.promoteWorkerAvailable = true;
  const competing = durableSynchronousShare(agent, CG, NAME).then(value => ({ value }), error => ({ error }));
  // On the defective implementation B reaches materialization. Let A clean WM
  // before releasing B, reproducing the review schedule without timing sleeps.
  await Promise.race([competing, entered.promise]);
  const worker = startWorker(job);
  try {
    await tail.promise;
    expect(await store.countQuads(finalized.graphUri)).toBe(0);
    resume.release();
    const rejected = await competing;
    expect('error' in rejected && rejected.error).toBeInstanceOf(DurableShareFailure);
    finish.release();
    expect((await worker).outcome).toBe('succeeded');
    expect(await store.countQuads(finalized.graphUri)).toBe(0);
    expect(mutation).not.toHaveBeenCalled();
    await assertCompleted();
    expect((await queue.getStatus(job.jobId))?.request.recoveryBinding).toEqual(prepared.recoveryBinding);
    expect(await queue.list({})).toHaveLength(1);
  } finally { resume.release(); finish.release(); await worker; await competing; }
});

it('holds the lifecycle lock across real finalization before a newly queued worker can clean WM', async () => {
  const { store, agent, publisher, finalized, prepared, request, queue, startWorker, assertCompleted } = await setup();
  const entered = barrier(), resume = barrier(), workerEntered = barrier();
  const materialize = publisher.materializeCanonicalWorkingMemory.bind(publisher);
  vi.spyOn(publisher, 'materializeCanonicalWorkingMemory').mockImplementationOnce(async (...args) => {
    entered.release(); await resume.promise; return materialize(...args);
  });
  const preparation = agent.assertion.prepareDurableShare(CG, NAME);
  await entered.promise;
  // Queue insertion itself is supported independently of HTTP admission. Its
  // worker must still obey the same lifecycle fence as the real finalizer.
  const job = await queue.enqueueAndClaim(request, 'owner');
  const promote = publisher.assertionPromote.bind(publisher);
  vi.spyOn(publisher, 'assertionPromote').mockImplementation(async (...args) => { workerEntered.release(); return promote(...args); });
  const mutation = vi.spyOn(publisher as any, 'assertionPromoteUnlocked');
  const worker = startWorker(job);
  try {
    await workerEntered.promise;
    expect(mutation).not.toHaveBeenCalled();
    expect(await store.countQuads(finalized.graphUri)).toBe(1);
    resume.release(); await preparation;
    expect((await worker).outcome).toBe('succeeded');
    expect(await store.countQuads(finalized.graphUri)).toBe(0);
    await assertCompleted();
    expect((await queue.getStatus(job.jobId))?.request.recoveryBinding).toEqual(prepared.recoveryBinding);
  } finally { resume.release(); await preparation; await worker; }
});

it('preserves the draft when ownership cannot be read before real finalization', async () => {
  const { store, agent, publisher, finalized } = await setup();
  const query = store.query.bind(store);
  vi.spyOn(store, 'query').mockImplementation(async (...args) => {
    if (args[1]?.source === 'publisher.asyncPromote.findActiveConflict') throw new Error('owner read unavailable');
    return query(...args);
  });
  const materialize = vi.spyOn(publisher, 'materializeCanonicalWorkingMemory');
  await expect(agent.assertion.prepareDurableShare(CG, NAME)).rejects.toThrow('owner read unavailable');
  expect(materialize).not.toHaveBeenCalled();
  expect(await store.countQuads(finalized.graphUri)).toBe(1);
  expect(await store.countQuads(finalized.sharedGraphUri)).toBe(0);
});

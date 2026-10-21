import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { OxigraphStore, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { PromoteJobLeaseError } from '@origintrail-official/dkg-publisher';
import { createPromotionAgentForTest } from '../../agent/test/_helpers/promotion-agent.js';
import { makeTestKaNumberAllocator } from '../../agent/test/_helpers/ka-allocator.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { readAssertionPromoteEvidence } from '../../publisher/src/assertion-promote-evidence.js';
import { ensureSubGraphRegistration } from '../../publisher/src/sub-graph-registration.js';
import { createPromoteWorkerSupervisor, runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';
import { createPromoteExecutionAuthority } from '../src/daemon/worker/promote-execution-authority.js';
import { executePromoteRequest } from '../src/daemon/worker/execute-promote-request.js';

const SIGNER = ethers.Wallet.createRandom();
const CG = 'async-recovery', NAME = 'asset', AUTHOR = SIGNER.address;
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(s => s.close())); });
async function setup(subGraphName?: string, oversized = false, mutable = false) {
  const store = new OxigraphStore(); stores.push(store);
  const { agent, publisher } = await createPromotionAgentForTest(store, {
    agentAddress: AUTHOR, peerId: '12D3KooWRecovery', kaAllocator: makeTestKaNumberAllocator(),
  });
  agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ mode: 'legacy', killSwitchActive: false });
  let time = Date.now();
  agent.configurePromoteQueue({ now: () => time, leaseMs: 1000, backoff: () => 0 });
  if (subGraphName) await ensureSubGraphRegistration(store, { contextGraphId: CG, subGraphName, createdBy: '12D3KooWRecovery', timestamp: new Date() });
  await publisher.assertionCreate(CG, NAME, AUTHOR, subGraphName);
  await publisher.assertionWrite(CG, NAME, AUTHOR, oversized
    ? Array.from({ length: 80 }, (_, i) => ({ subject: 'urn:large', predicate: `urn:value:${i}`, object: JSON.stringify('x'.repeat(55_000)) }))
    : [{ subject: 'urn:asset', predicate: 'urn:value', object: '"original"' }], subGraphName);
  const finalized = mutable ? undefined : await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR, subGraphName });
  const queue = agent.promoteQueue;
  const { jobId } = await agent.assertion.promoteAsync(CG, NAME, { subGraphName, agentAddress: AUTHOR });
  const claim = () => queue.claimNext('worker');
  const run = (job: any, overrides: any = {}) => runPromoteJob({ job, queue, workerId: 'worker', now: () => time,
    heartbeatIntervalMs: 0, log: () => {}, prepareJob: (j, authority) => agent.assertion.prepareQueuedShare(j, authority),
    runPromote: (request, executionAuthority) => executePromoteRequest(agent, request, { executionAuthority }), ...overrides });
  const prepare = (job: any) => agent.assertion.prepareQueuedShare(job, createPromoteExecutionAuthority(queue, job.jobId, job.lease.claimToken, () => time, () => {}));
  return { agent, publisher, queue, store, finalized, jobId, claim, run, prepare, expire: () => { time += 1001; } };
}

function useRealFinalizer(f: Awaited<ReturnType<typeof setup>>) {
    delete f.agent.prepareAtomicAssertionShare;
    const signer = SIGNER;
    f.agent.chain = { chainId: 'mock:31337', getEvmChainId: async () => 31337n,
      getKnowledgeAssetsLifecycleAddress: async () => AUTHOR, hasContractCode: async () => false };
    f.agent.kaNumberAllocator = makeTestKaNumberAllocator();
    f.agent.reconciledKaAuthors = new Set();
    vi.spyOn(f.publisher, 'publisherFallbackAuthorAddress').mockResolvedValue(signer.address);
    vi.spyOn(f.publisher, 'signAuthorAttestationAsPublisher').mockImplementation(async typed => {
      const sig = ethers.Signature.from(await signer.signTypedData(typed.domain, typed.types, typed.message));
      return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
    });
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

  it('finalizes an ordinary draft in the supervisor and recovers its original binding', async () => {
    const f = await setup(undefined, false, true);
    useRealFinalizer(f);
    expect((await readAssertionPromoteEvidence(f.store, CG, NAME, AUTHOR)).seal).toBeUndefined();
    let bound: unknown;
    const interruption = vi.spyOn(f.publisher, 'assertionPromote').mockImplementationOnce(async () => {
      const job = await f.queue.getStatus(f.jobId);
      bound = job.request.recoveryBinding;
      expect(bound).toBeDefined();
      expect((await readAssertionPromoteEvidence(f.store, CG, NAME, AUTHOR)).seal).toBeDefined();
      // Interrupt the actual supervisor at this boundary, before SWM mutation.
      await supervisor.stop();
      throw new Error('simulated process exit before SWM');
    });
    const supervisor = createPromoteWorkerSupervisor({ agent: f.agent, workerConcurrency: 1, shutdownTimeoutMs: 1,
      heartbeatIntervalMs: 0, bookkeepingRetryBudgetMs: 100, pollIntervalMs: 1000, postCommitRecoveryIntervalMs: 0, log: () => {} });
    try {
      await supervisor.start(); await supervisor.tickOnce();
      await expect.poll(async () => { const job = await f.queue.getStatus(f.jobId); return bound ?? (job.state !== 'running' && job.state !== 'queued' ? job : undefined); }, { timeout: 5000 }).toBeDefined();
      expect(bound, JSON.stringify(await f.queue.getStatus(f.jobId))).toBeDefined();
    } finally { await supervisor.stop(); interruption.mockRestore(); }
    expect((await f.queue.getStatus(f.jobId)).state).toBe('running');
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(false);
    f.expire();
    expect(await f.queue.recoverOnStartup()).toEqual({ reclaimed: 1, abandoned: 0 });
    const replacement = await f.claim();
    expect(replacement.jobId).toBe(f.jobId);
    expect(replacement.request.recoveryBinding).toEqual(bound);
    expect((await f.run(replacement)).outcome).toBe('succeeded');
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    expect(await f.queue.list({})).toHaveLength(1);
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
    const { job } = await f.prepare(first);
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
    const preparation = vi.spyOn(f.agent, 'prepareAtomicAssertionShare');
    await expect(f.prepare(await f.queue.getStatus(first.jobId))).rejects.toThrow('unstarted');
    expect(preparation).not.toHaveBeenCalled();
    f.expire();
    expect(await f.queue.recoverOnStartup()).toEqual({ reclaimed: 0, abandoned: 1 });
    expect((await f.queue.getStatus(f.jobId)).request.recoveryBinding).toBeUndefined();
  });

  it.each(['subset', 'missing-marker', 'committed-marker', 'blank-lane'])('rejects unsafe %s before seal preparation and under the binding lock', async mode => {
    const f = await setup(); const job = await f.claim();
    const binding = (await f.agent.assertion.prepareDurableShare(CG, NAME)).recoveryBinding;
    const unsafe = { ...job, request: { ...job.request }, commitMarker: job.commitMarker && { ...job.commitMarker } };
    if (mode === 'subset') unsafe.request.entities = ['urn:asset'];
    if (mode === 'missing-marker') unsafe.commitMarker = undefined;
    if (mode === 'committed-marker') unsafe.commitMarker.swmInserted = true;
    if (mode === 'blank-lane') unsafe.request.agentAddress = ' ';
    await f.queue.writeJob(unsafe);
    const preparation = vi.spyOn(f.agent, 'prepareAtomicAssertionShare');
    await expect(f.prepare(unsafe)).rejects.toThrow('unstarted');
    expect(preparation).not.toHaveBeenCalled();
    await expect(f.queue.bindRecovery(job.jobId, job.lease.claimToken, binding)).rejects.toThrow('unstarted');
  });

  it.each([[3, AUTHOR], [4, undefined]])('preserves queued format %s / lane %s without inventing authority', async (formatVersion, agentAddress) => {
    const f = await setup();
    const job = await f.claim();
    const legacy = { ...job, formatVersion, request: { ...job.request, agentAddress } };
    await f.queue.writeJob(legacy);
    const seal = vi.spyOn(f.agent, 'prepareAtomicAssertionShare');
    expect(await f.prepare(legacy)).toEqual({ job: legacy });
    expect(seal).not.toHaveBeenCalled();
    const runPromote = vi.fn(async () => ({ promotedCount: 1 }));
    expect((await f.run(legacy, { runPromote })).outcome).toBe('succeeded');
    expect(runPromote.mock.calls[0][0].recoveryBinding).toBeUndefined();
    expect((await f.queue.getStatus(f.jobId)).request.recoveryBinding).toBeUndefined();
  });

  it.each([false, true])('discounts preparation retries but not earlier bound execution (%s)', async earlierBoundExecution => {
    const f = await setup(undefined, true);
    const busy = () => new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'test.prepare', { storeOperation: 'query' });
    vi.spyOn(f.agent, 'prepareAtomicAssertionShare').mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy());
    for (let n = 1; n <= 2; n++) {
      expect((await f.run(await f.claim())).outcome).toBe('failed_retrying');
      expect((await f.queue.getStatus(f.jobId)).preparationAttempts).toBe(n);
    }
    if (earlierBoundExecution) {
      expect((await f.run(await f.claim(), { runPromote: async () => { throw busy(); } })).outcome).toBe('failed_retrying');
    }
    const outcome = await f.run(await f.claim());
    expect(outcome.outcome).toBe('failed_terminal');
    expect(Boolean(outcome.retiredNoEffect)).toBe(!earlierBoundExecution);
    const job = await f.queue.getStatus(f.jobId);
    expect(job.attempt.count).toBe(earlierBoundExecution ? 4 : 3);
    expect(job.preparationAttempts).toBe(2);
    expect(await f.store.countQuads(f.finalized.sharedGraphUri)).toBe(0);
    if (earlierBoundExecution) {
      await expect(f.agent.assertion.discard(CG, NAME, { agentAddress: AUTHOR })).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
      await expect(f.queue.clearTerminalJob(f.jobId)).resolves.toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    } else {
      await expect(f.agent.assertion.discard(CG, NAME, { agentAddress: AUTHOR })).resolves.toBeUndefined();
      await expect(f.queue.clearTerminalJob(f.jobId)).resolves.toEqual({ outcome: 'cleared' });
    }
  });

  it('retains proof of an expired preparation-only claim before first bound execution', async () => {
    const f = await setup(undefined, true);
    await f.claim();
    f.expire();
    expect(await f.queue.recoverOnStartup()).toEqual({ reclaimed: 1, abandoned: 0 });
    expect((await f.queue.getStatus(f.jobId)).preparationAttempts).toBe(1);
    const outcome = await f.run(await f.claim());
    expect(outcome.outcome).toBe('failed_terminal');
    expect(outcome.retiredNoEffect).toBe(true);
    await expect(f.agent.assertion.discard(CG, NAME, { agentAddress: AUTHOR })).resolves.toBeUndefined();
  });

  it.each([
    { existing: false, stage: 'materialize' }, { existing: true, stage: 'materialize' },
    { existing: false, stage: 'lifecycle' }, { existing: true, stage: 'lifecycle' },
  ])('rechecks authority during $stage (existing seal: $existing)', async ({ existing, stage }) => {
    const f = await setup(undefined, false, true); useRealFinalizer(f);
    if (existing) await f.agent.assertion.finalize(CG, NAME, { agentAddress: AUTHOR });
    const original = await f.publisher.assertionQuery(CG, NAME, AUTHOR);
    const job = await f.claim();
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(r => { release = r; });
    const reached = new Promise<void>(r => { entered = r; });
    const target = stage === 'materialize' ? f.publisher : f.agent;
    const method = stage === 'materialize' ? 'materializeCanonicalWorkingMemory' : '_stampPointerIfDivergedFromVm';
    const write = target[method].bind(target);
    const barrier = vi.spyOn(target, method).mockImplementationOnce(async (...args: any[]) => {
      const result = await write(...args); entered(); await blocked; return result;
    });
    const cleanup = vi.spyOn(f.publisher, 'cleanupCanonicalWorkingMemorySources');
    const running = f.run(job);
    try {
      await reached;
      f.expire(); await f.queue.recoverOnStartup();
      const replacement = await f.claim();
      release();
      expect((await running).outcome).toBe('failure_bookkeeping_uncertain');
      expect(cleanup).not.toHaveBeenCalled();
      if (!existing && stage === 'materialize')
        expect((await readAssertionPromoteEvidence(f.store, CG, NAME, AUTHOR)).seal).toBeUndefined();
      expect(await f.publisher.assertionQuery(CG, NAME, AUTHOR)).toEqual(original);
      barrier.mockRestore();
      expect((await f.run(replacement)).outcome).toBe('succeeded');
      expect(replacement.jobId).toBe(f.jobId);
      const content = await f.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s <urn:value> ?o BIND(<urn:value> AS ?p) } }`);
      expect(content.type === 'quads' && content.quads.map(q => q.object)).toEqual(['"original"']);
      expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    } finally { release(); await running; }
  });

  it.each(['current', 'cancel', 'replacement', 'shutdown'])('respects %s authority while awaiting the lifecycle fence', async mode => {
    const f = await setup(undefined, false, true);
    useRealFinalizer(f);
    const preparation = vi.spyOn(f.agent, 'prepareAtomicAssertionShare');
    const draft = await f.publisher.wmGraphUri(CG, AUTHOR, NAME);
    const before = await f.publisher.assertionQuery(CG, NAME, AUTHOR);
    const job = await f.claim();
    let release!: () => void, entered!: () => void, queried!: () => void;
    const blocked = new Promise<void>(r => { release = r; });
    const locked = new Promise<void>(r => { entered = r; });
    const queryDone = new Promise<void>(r => { queried = r; });
    const holder = f.publisher.prepareAssertionShareSeal(CG, NAME, AUTHOR, undefined, async () => { entered(); await blocked; });
    await locked;
    const read = f.publisher.assertionQuery.bind(f.publisher);
    vi.spyOn(f.publisher, 'assertionQuery').mockImplementation(async (...args: any[]) => { const rows = await read(...args); queried(); return rows; });
    const abort = new AbortController();
    const running = f.run(job, { shutdownSignal: abort.signal }).then(result => ({ result }), error => ({ error }));
    try {
      await queryDone;
      if (mode === 'shutdown') abort.abort();
      else if (mode !== 'current') {
        f.expire();
        await f.queue.recoverOnStartup();
        if (mode === 'cancel') await f.queue.cancel(job.jobId);
        else await f.claim();
      }
      release(); await holder;
      const outcome = await running;
      if (mode === 'current') {
        expect(outcome.result?.outcome).toBe('succeeded');
        expect((await f.queue.getStatus(f.jobId)).request.recoveryBinding).toBeDefined();
        await expect(preparation.mock.results[0].value).resolves.toBeUndefined();
        return;
      }
      if (mode === 'shutdown') {
        expect(outcome.error?.message).toContain('shutdown');
        await expect(preparation.mock.results[0].value).rejects.toThrow('shutdown');
      } else {
        expect(outcome.result?.outcome).toBe('failure_bookkeeping_uncertain');
        await expect(preparation.mock.results[0].value).rejects.toBeInstanceOf(PromoteJobLeaseError);
      }
      expect(await f.publisher.assertionQuery(CG, NAME, AUTHOR)).toEqual(before);
      expect(await f.store.countQuads(draft)).toBe(before.length);
      expect((await readAssertionPromoteEvidence(f.store, CG, NAME, AUTHOR)).seal).toBeUndefined();
    } finally { release(); await holder; await running; }
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

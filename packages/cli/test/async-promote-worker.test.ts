/**
 * Async-promote worker — unit tests.
 *
 * The worker module exports three concerns we test in isolation:
 *   - `classifyPromoteError(err)` — pure mapping (10 tests).
 *   - `runPromoteJob(...)` — per-job lifecycle including commit-marker
 *     bookkeeping and outcome reporting (8 tests).
 *   - `createPromoteWorkerSupervisor(...)` — multi-slot polling +
 *     shutdown drain (6 tests).
 *
 * Backed by a real `TripleStoreAsyncPromoteQueue` against an in-memory
 * `OxigraphStore`. The `agent.assertion.promote` call is a stub
 * controlled per-test (resolve / throw with specific message).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncPromoteQueue,
  type AsyncPromoteQueue,
  type PromoteJob,
  type PromoteRequest,
} from '@origintrail-official/dkg-publisher';
import {
  classifyPromoteError,
  createPromoteWorkerSupervisor,
  runPromoteJob,
} from '../src/daemon/worker/async-promote-worker.js';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('classifyPromoteError', () => {
  // RFC §10 / plan §10.3 — the three patterns surfaced by the rc.10 Graphify import
  // (`INTEGRATION_NOTES_GRAPHIFY.md`), plus the fatal default.

  it('classifies gossip-cap errors as cap_exceeded (non-retryable)', () => {
    const verdict = classifyPromoteError(
      new Error('Promoted assertion too large for gossip (5120 KB, limit 4 MB). Promote fewer entities per call.'),
    );
    expect(verdict).toEqual({ classification: 'cap_exceeded', retryable: false });
  });

  it('classifies typed SWM gossip-cap errors by code', () => {
    const err = new Error('custom wording') as Error & { code: string };
    err.code = 'SWM_GOSSIP_PAYLOAD_TOO_LARGE';

    const verdict = classifyPromoteError(err);

    expect(verdict).toEqual({ classification: 'cap_exceeded', retryable: false });
  });

  it('classifies 256 KB body-cap errors as cap_exceeded', () => {
    const verdict = classifyPromoteError(new Error('Request body too large (>262144 bytes)'));
    expect(verdict.classification).toBe('cap_exceeded');
    expect(verdict.retryable).toBe(false);
  });

  it('classifies generic PayloadTooLargeError as cap_exceeded', () => {
    const verdict = classifyPromoteError(new Error('payload too large for this endpoint'));
    expect(verdict.classification).toBe('cap_exceeded');
  });

  it('classifies fetch failures as transient (retryable)', () => {
    expect(classifyPromoteError(new Error('fetch failed'))).toEqual({
      classification: 'transient',
      retryable: true,
    });
    expect(classifyPromoteError(new Error('ECONNRESET reading socket'))).toEqual({
      classification: 'transient',
      retryable: true,
    });
    expect(classifyPromoteError(new Error('socket hang up'))).toEqual({
      classification: 'transient',
      retryable: true,
    });
  });

  // #1464 — the publisher tags a promote error's message with a "[promote:<step>] " prefix so the
  // failing step is NAMED. The step LABEL must never change the retry classification: the classifier
  // strips the tag before substring-matching. Regression for the gate-caught collision where the
  // step label "encodeWorkspaceGossipPayload" injected the "gossip" trigger token, flipping a
  // transient error to non-retryable cap_exceeded. Fails without the tag-strip.
  it('#1464 — strips the [promote:<step>] tag before classifying (label tokens do not change the verdict)', () => {
    // A transient error tagged at the gossip-encode step (label contains "gossip") stays retryable.
    expect(classifyPromoteError(new Error('[promote:encodeWorkspaceGossipPayload] rate limit exceeded — request timed out')))
      .toEqual({ classification: 'transient', retryable: true });
    // Identical to the same error untagged.
    expect(classifyPromoteError(new Error('rate limit exceeded — request timed out')))
      .toEqual({ classification: 'transient', retryable: true });
    // A GENUINE gossip-cap error (token in the ORIGINAL message) still classifies cap_exceeded even
    // when tagged — stripping removes only the injected prefix, never real tokens.
    expect(classifyPromoteError(new Error('[promote:assertionScopedQuads] Promoted assertion too large for gossip (limit 4 MB)')))
      .toEqual({ classification: 'cap_exceeded', retryable: false });
  });

  it('classifies timeout errors as transient', () => {
    expect(classifyPromoteError(new Error('Operation timed out'))).toEqual({
      classification: 'transient',
      retryable: true,
    });
    expect(classifyPromoteError(new Error('ETIMEDOUT connecting to 127.0.0.1'))).toEqual({
      classification: 'transient',
      retryable: true,
    });
  });

  it('classifies unknown errors as fatal (non-retryable)', () => {
    expect(classifyPromoteError(new Error('assertion not found: foo'))).toEqual({
      classification: 'fatal',
      retryable: false,
    });
    expect(classifyPromoteError(new Error('something exploded'))).toEqual({
      classification: 'fatal',
      retryable: false,
    });
  });

  it('handles non-Error throws (strings, undefined)', () => {
    expect(classifyPromoteError('boom').classification).toBe('fatal');
    expect(classifyPromoteError(undefined).classification).toBe('fatal');
  });
});

describe('runPromoteJob', () => {
  let store: OxigraphStore;
  let queue: AsyncPromoteQueue;
  let now: number;
  let idCounter: number;
  let logs: string[];

  beforeEach(() => {
    store = new OxigraphStore();
    now = 1_700_000_000_000;
    idCounter = 0;
    logs = [];
    queue = new TripleStoreAsyncPromoteQueue(store, {
      now: () => now,
      idGenerator: () => `job-${++idCounter}`,
      backoff: () => 60_000,
      maxRetries: 3,
    });
  });

  function makeRequest(overrides: Partial<PromoteRequest> = {}): PromoteRequest {
    return {
      contextGraphId: 'graphify',
      subGraphName: 'code',
      assertionName: 'shard-1',
      entities: 'all',
      ...overrides,
    };
  }

  async function enqueueAndClaim(req: PromoteRequest = makeRequest()): Promise<PromoteJob> {
    await queue.enqueue(req);
    const claimed = await queue.claimNext('worker-test');
    if (!claimed) throw new Error('expected claimable job');
    return claimed;
  }

  it('on success, records the recovery commit marker and transitions to succeeded', async () => {
    const job = await enqueueAndClaim();
    const result = await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        return { promotedCount: 42 };
      },
      now: () => now,
      heartbeatIntervalMs: 0,
      log: (m) => logs.push(m),
    });

    expect(result.outcome).toBe('succeeded');
    const final = await queue.getStatus(job.jobId);
    expect(final?.state).toBe('succeeded');
    expect(final?.commitMarker).toEqual({
      promoteStarted: true,
      swmInserted: true,
      wmCleaned: false,
      lifecycleStamped: false,
      gossiped: false,
    });
    expect(final?.result?.promotedCount).toBe(42);
  });

  it('Codex #665 — post-promote bookkeeping failure returns partial_promote_ambiguity and leaves job running', async () => {
    // Codex (#665#discussion_r3302646439): if `assertion.promote()` has
    // already returned successfully and the next `recordCommitMarker
    // ('swmInserted')` or `queue.succeed()` write fails (store hiccup,
    // lost lease, transient FS error, …), the previous behavior let the
    // outer worker catch park the job as `failed` with retryable=false.
    // Re-running through `/promote-async/{jobId}/recover` would then
    // promote already-promoted data — duplicate WM/SWM writes + re-gossip.
    //
    // The fix returns `partial_promote_ambiguity` and DOES NOT call
    // queue.fail(). The job stays in `running` state until the lease
    // expires; recoverOnStartup() then routes it into the abandoned
    // partial-promote bucket on next daemon boot.
    const job = await enqueueAndClaim();
    const failingQueue: AsyncPromoteQueue = {
      ...queue,
      recordCommitMarker: async (jobId, claimToken, step) => {
        if (step === 'swmInserted') {
          throw new Error('simulated store hiccup');
        }
        return queue.recordCommitMarker(jobId, claimToken, step);
      },
    } as AsyncPromoteQueue;

    const result = await runPromoteJob({
      job,
      queue: failingQueue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        return { promotedCount: 99 };
      },
      now: () => now,
      heartbeatIntervalMs: 0,
      log: (m) => logs.push(m),
    });

    expect(result.outcome).toBe('partial_promote_ambiguity');
    expect(result.error?.classification).toBe('fatal');
    expect(result.error?.retryable).toBe(false);
    // Job remains in `running` state until lease expiry — NOT immediately
    // `failed` — so /recover cannot re-promote it during the unsafe window.
    const final = await queue.getStatus(job.jobId);
    expect(final?.state).toBe('running');
    expect(final?.commitMarker?.promoteStarted).toBe(true);
    expect(final?.commitMarker?.swmInserted).toBe(false);
    // The loud log line operators need to see.
    expect(logs.some((l) => l.includes('PARTIAL-PROMOTE-AMBIGUITY'))).toBe(true);

    now += 6 * 60 * 1000;
    await queue.claimNext('worker-after-lease-expiry');
    const reconciled = await queue.getStatus(job.jobId);
    expect(reconciled?.state).toBe('failed');
    expect(reconciled?.reason).toContain('partial promote ambiguity');
    await expect(queue.recover(job.jobId)).rejects.toThrow(/Cannot recover job job-1: partial promote ambiguity/);
  });

  it('emits memoryGraphChanged on successful promote with >0 triples', async () => {
    const events: any[] = [];
    const job = await enqueueAndClaim();
    await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        return { promotedCount: 7 };
      },
      now: () => now,
      heartbeatIntervalMs: 0,
      log: () => {},
      emitMemoryGraphChanged: (e) => events.push(e),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      contextGraphId: 'graphify',
      subGraphName: 'code',
      operation: 'assertion_promoted',
      source: 'async-worker',
      counts: { triples: 7 },
      layers: ['wm', 'swm'],
    });
  });

  it('does NOT emit memoryGraphChanged when promotedCount is 0', async () => {
    const events: any[] = [];
    const job = await enqueueAndClaim();
    await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        return { promotedCount: 0 };
      },
      now: () => now,
      heartbeatIntervalMs: 0,
      log: () => {},
      emitMemoryGraphChanged: (e) => events.push(e),
    });
    expect(events).toHaveLength(0);
  });

  it('on transient error, transitions to failed_retrying with backoff', async () => {
    const job = await enqueueAndClaim();
    const result = await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async () => {
        throw new Error('fetch failed');
      },
      now: () => now,
      heartbeatIntervalMs: 0,
      log: () => {},
    });
    expect(result.outcome).toBe('failed_retrying');
    expect(result.error?.classification).toBe('transient');
    const final = await queue.getStatus(job.jobId);
    expect(final?.state).toBe('failed_retrying');
    expect(final?.attempt.nextRetryAt).toBeGreaterThan(now);
  });

  it('on cap_exceeded error, transitions to failed (terminal)', async () => {
    const job = await enqueueAndClaim();
    const result = await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async () => {
        throw new Error('Promoted assertion too large for gossip (6000 KB, limit 4 MB)');
      },
      now: () => now,
      heartbeatIntervalMs: 0,
      log: () => {},
    });
    expect(result.outcome).toBe('failed_terminal');
    expect(result.error?.classification).toBe('cap_exceeded');
    const final = await queue.getStatus(job.jobId);
    expect(final?.state).toBe('failed');
  });

  it('on fatal error, transitions to failed (terminal)', async () => {
    const job = await enqueueAndClaim();
    const result = await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async () => {
        throw new Error('assertion not found: shard-1');
      },
      now: () => now,
      heartbeatIntervalMs: 0,
      log: () => {},
    });
    expect(result.outcome).toBe('failed_terminal');
    expect(result.error?.classification).toBe('fatal');
  });

  it('after maxRetries transient failures in a row, settles in failed (terminal)', async () => {
    const req = makeRequest({ assertionName: 'flaky' });
    await queue.enqueue(req);
    for (let i = 0; i < 5; i++) {
      const claimed = await queue.claimNext('worker-test');
      if (!claimed) break;
      await runPromoteJob({
        job: claimed,
        queue,
        workerId: 'worker-test',
        runPromote: async () => {
          throw new Error('fetch failed');
        },
        now: () => now,
        heartbeatIntervalMs: 0,
        log: () => {},
      });
      now += 120_000; // > backoff so next claimNext picks it up
    }
    const all = await queue.list({});
    const job = all[0];
    expect(job?.state).toBe('failed');
    expect(job?.attempt.count).toBe(3); // maxRetries=3 reached
  });

  it('throws if invoked with a job that has no lease', async () => {
    await queue.enqueue(makeRequest());
    const queued = (await queue.list({ state: ['queued'] }))[0]!;
    await expect(
      runPromoteJob({
        job: queued,
        queue,
        workerId: 'worker-test',
        runPromote: async () => ({ promotedCount: 0 }),
        now: () => now,
        heartbeatIntervalMs: 0,
        log: () => {},
      }),
    ).rejects.toThrow(/active lease/);
  });
});

describe('createPromoteWorkerSupervisor', () => {
  let store: OxigraphStore;
  let queue: AsyncPromoteQueue;
  let logs: string[];

  function makeRequest(name: string, overrides: Partial<PromoteRequest> = {}): PromoteRequest {
    return { contextGraphId: 'cg', assertionName: name, entities: 'all', ...overrides };
  }

  function makeAgentStub(promote: (req: PromoteRequest) => Promise<{ promotedCount: number }>) {
    return {
      promoteQueue: queue,
      assertion: {
        async promote(
          cgId: string,
          name: string,
          opts: { entities?: any; subGraphName?: string; agentAddress?: string; authorAgentAddress?: string },
        ) {
          return promote({
            contextGraphId: cgId,
            assertionName: name,
            entities: opts.entities ?? 'all',
            subGraphName: opts.subGraphName,
            ...(opts.agentAddress ? { agentAddress: opts.agentAddress } : {}),
            ...(opts.authorAgentAddress ? { authorAgentAddress: opts.authorAgentAddress } : {}),
          });
        },
      },
    } as any;
  }

  beforeEach(() => {
    store = new OxigraphStore();
    logs = [];
    queue = new TripleStoreAsyncPromoteQueue(store, {
      now: () => Date.now(),
      backoff: () => 50,
      maxRetries: 2,
    });
  });

  afterEach(async () => {
    // best-effort cleanup
  });

  it('start() then tickOnce() picks up queued jobs and runs them to succeeded', async () => {
    await queue.enqueue(makeRequest('a'));
    await queue.enqueue(makeRequest('b'));
    await queue.enqueue(makeRequest('c'));

    const sup = createPromoteWorkerSupervisor({
      agent: makeAgentStub(async () => ({ promotedCount: 1 })),
      workerConcurrency: 2,
      pollIntervalMs: 1_000_000, // disable auto-tick; we drive manually
      heartbeatIntervalMs: 0,
      log: (m) => logs.push(m),
      workerIdPrefix: 'test',
    });

    await sup.start();
    expect(await sup.tickOnce()).toBe(2); // 2 slots, both claim
    // Wait for in-flight jobs to drain.
    await sup.stop();

    const stats = await queue.getStats();
    expect(stats.succeeded).toBe(2);
    expect(stats.queued).toBe(1);

    // Second start+tick claims the remaining one.
    await sup.start();
    expect(await sup.tickOnce()).toBeGreaterThanOrEqual(1);
    await sup.stop();

    expect((await queue.getStats()).succeeded).toBe(3);
  });

  it('passes the stored enqueue storage lane and author into agent.promote', async () => {
    const agentAddress = '0x2222222222222222222222222222222222222222';
    const authorAgentAddress = '0x1111111111111111111111111111111111111111';
    await queue.enqueue(makeRequest('agent-a-share', { agentAddress, authorAgentAddress }));
    const seen: PromoteRequest[] = [];

    const sup = createPromoteWorkerSupervisor({
      agent: makeAgentStub(async (req) => {
        seen.push(req);
        return { promotedCount: 1 };
      }),
      workerConcurrency: 1,
      pollIntervalMs: 1_000_000,
      heartbeatIntervalMs: 0,
      log: (m) => logs.push(m),
      workerIdPrefix: 'test',
    });

    await sup.start();
    expect(await sup.tickOnce()).toBe(1);
    await sup.stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      assertionName: 'agent-a-share',
      agentAddress,
      authorAgentAddress,
    });
  });

  it('a tick on an empty queue picks up zero jobs and does not throw', async () => {
    const sup = createPromoteWorkerSupervisor({
      agent: makeAgentStub(async () => ({ promotedCount: 0 })),
      workerConcurrency: 4,
      pollIntervalMs: 1_000_000,
      heartbeatIntervalMs: 0,
      log: () => {},
      workerIdPrefix: 'test',
    });
    await sup.start();
    expect(await sup.tickOnce()).toBe(0);
    await sup.stop();
  });

  it('rejects a heartbeat interval that is not shorter than the queue lease', () => {
    expect(() =>
      createPromoteWorkerSupervisor({
        agent: makeAgentStub(async () => ({ promotedCount: 0 })),
        heartbeatIntervalMs: 5 * 60 * 1000,
        log: () => {},
      }),
    ).toThrow(/heartbeatIntervalMs.*shorter than the queue lease/);
  });

  it('two slots never pick the same job (per-assertion lock holds across workers)', async () => {
    // Two jobs with the SAME uniqueness key shouldn't even both be enqueueable;
    // but two DIFFERENT jobs targeting the same CG should run in parallel.
    await queue.enqueue(makeRequest('first'));
    await queue.enqueue(makeRequest('second'));

    let inFlight = 0;
    let maxInFlight = 0;
    const sup = createPromoteWorkerSupervisor({
      agent: makeAgentStub(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return { promotedCount: 1 };
      }),
      workerConcurrency: 4,
      pollIntervalMs: 1_000_000,
      heartbeatIntervalMs: 0,
      log: () => {},
      workerIdPrefix: 'test',
    });
    await sup.start();
    await sup.tickOnce();
    await sup.stop();
    expect(maxInFlight).toBeLessThanOrEqual(2); // we only had 2 distinct jobs
    expect((await queue.getStats()).succeeded).toBe(2);
  });

  it('counters track outcomes across runs', async () => {
    await queue.enqueue(makeRequest('ok'));
    await queue.enqueue(makeRequest('flaky'));

    const sup = createPromoteWorkerSupervisor({
      agent: makeAgentStub(async (req) => {
        if (req.assertionName === 'flaky') throw new Error('fetch failed');
        return { promotedCount: 1 };
      }),
      workerConcurrency: 2,
      pollIntervalMs: 1_000_000,
      heartbeatIntervalMs: 0,
      log: () => {},
      workerIdPrefix: 'test',
    });
    await sup.start();
    await sup.tickOnce();
    await sup.stop();

    const c = sup.getCounters();
    expect(c.attempted).toBe(2);
    expect(c.succeeded).toBe(1);
    expect(c.failedRetrying).toBe(1);
    expect(c.failedTerminal).toBe(0);
  });

  it('shutdown timeout abandons in-flight jobs without modifying queue state', async () => {
    await queue.enqueue(makeRequest('slow'));
    let releaseSlow: (() => void) | null = null;
    const slowPromote = new Promise<{ promotedCount: number }>((resolve) => {
      releaseSlow = () => resolve({ promotedCount: 1 });
    });
    const sup = createPromoteWorkerSupervisor({
      agent: makeAgentStub(() => slowPromote),
      workerConcurrency: 1,
      pollIntervalMs: 1_000_000,
      heartbeatIntervalMs: 0,
      shutdownTimeoutMs: 50,
      log: (m) => logs.push(m),
      workerIdPrefix: 'test',
    });
    await sup.start();
    await sup.tickOnce();
    // Job is in flight; stop now and watch the timeout fire.
    await sup.stop();
    expect(logs.some((m) => m.includes('Shutdown timeout'))).toBe(true);
    expect(sup.getCounters().interruptedAtShutdown).toBe(1);
    // The job is still `running` per the queue — RFC §6.2: do NOT mark
    // `running → queued` on shutdown.
    const stats = await queue.getStats();
    expect(stats.running).toBe(1);
    expect(stats.succeeded).toBe(0);

    // Cleanup — let the in-flight promote complete so vitest doesn't
    // wait on it forever.
    releaseSlow!();
    await slowPromote;
  });

  it('stop() waits for a poll callback that has claimed work but not published inFlight yet', async () => {
    await queue.enqueue(makeRequest('interval-claim-race'));
    const claimStarted = deferred();
    const releaseClaim = deferred();
    const promoteStarted = deferred();
    const releasePromote = deferred<{ promotedCount: number }>();
    const wrappedQueue = Object.create(queue) as AsyncPromoteQueue;
    wrappedQueue.claimNext = async (workerId: string) => {
      claimStarted.resolve();
      await releaseClaim.promise;
      return queue.claimNext(workerId);
    };
    const sup = createPromoteWorkerSupervisor({
      agent: {
        promoteQueue: wrappedQueue,
        assertion: {
          async promote() {
            promoteStarted.resolve();
            return releasePromote.promise;
          },
        },
      } as any,
      workerConcurrency: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 0,
      shutdownTimeoutMs: 500,
      log: (m) => logs.push(m),
      workerIdPrefix: 'test',
    });
    await sup.start();
    await claimStarted.promise;

    let stopResolved = false;
    const stopPromise = sup.stop().then(() => {
      stopResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopResolved).toBe(false);

    releaseClaim.resolve();
    await promoteStarted.promise;
    releasePromote.resolve({ promotedCount: 1 });
    await stopPromise;

    expect(stopResolved).toBe(true);
    expect(logs.some((m) => m.includes('Shutdown timeout'))).toBe(false);
    expect((await queue.getStats()).succeeded).toBe(1);
  });

  it('runs recoverOnStartup() during start()', async () => {
    // Build a queue with a stale `running` job that had already entered
    // promote, then verify start() parks it for operator recovery.
    let nowFn = 0;
    const recoverableQueue = new TripleStoreAsyncPromoteQueue(store, {
      now: () => nowFn,
      backoff: () => 50,
      leaseMs: 1000,
    });
    nowFn = 1_000_000;
    const staleJobId = await recoverableQueue.enqueue(makeRequest('stale'));
    const claimed = await recoverableQueue.claimNext('worker-old');
    await recoverableQueue.recordCommitMarker(staleJobId, claimed!.lease!.claimToken, 'promoteStarted');
    nowFn += 60_000; // lease expired

    const sup = createPromoteWorkerSupervisor({
      agent: { promoteQueue: recoverableQueue, assertion: { promote: async () => ({ promotedCount: 1 }) } } as any,
      workerConcurrency: 1,
      pollIntervalMs: 1_000_000,
      heartbeatIntervalMs: 0,
      log: (m) => logs.push(m),
      workerIdPrefix: 'test',
    });
    await sup.start();
    expect((await recoverableQueue.getStats()).failed).toBe(1);
    expect((await recoverableQueue.getStats()).running).toBe(0);
    expect(logs.some((m) => m.includes('abandoned=1'))).toBe(true);
    await sup.stop();
  });

  it('refuses to start polling when recoverOnStartup() fails', async () => {
    const sup = createPromoteWorkerSupervisor({
      agent: {
        promoteQueue: {
          recoverOnStartup: async () => {
            throw new Error('store offline');
          },
          claimNext: async () => {
            throw new Error('must not poll after failed recovery');
          },
        },
        assertion: { promote: async () => ({ promotedCount: 1 }) },
      } as any,
      workerConcurrency: 1,
      pollIntervalMs: 1,
      log: (m) => logs.push(m),
      workerIdPrefix: 'test',
    });
    await expect(sup.start()).rejects.toThrow(/recoverOnStartup failed: store offline/);
    expect(sup.getCounters().attempted).toBe(0);
  });
});

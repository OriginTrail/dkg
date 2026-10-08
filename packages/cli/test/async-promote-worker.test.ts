/**
 * Async-promote worker — unit tests.
 *
 * Worker orchestration coverage (pure classifier cases live in
 * async-promote-error-classification.test.ts):
 *   - `runPromoteJob(...)` — per-job lifecycle including commit-marker
 *     bookkeeping and outcome reporting.
 *   - `createPromoteWorkerSupervisor(...)` — multi-slot polling +
 *     shutdown drain.
 *
 * Backed by a real `TripleStoreAsyncPromoteQueue` against an in-memory
 * `OxigraphStore`. The `agent.assertion.promote` call is a stub
 * controlled per-test (resolve / throw with specific message).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import {
  OxigraphStore,
  StoreOperationTimeoutError,
  StoreSchedulerBusyError,
} from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncPromoteQueue,
  createPromotePostCommitFailure,
  createPromoteRetryableFailure,
  type AsyncPromoteQueue,
  type PromoteRequest,
} from '@origintrail-official/dkg-publisher';
import { classifyExactSwmGraphReplaceFailure } from '../../publisher/test/_helpers/promote-replay-safety.js';
import { RFC64_LEGACY_SWM_BOUNDARY_RETIREMENT_IN_PROGRESS_CODE } from '@origintrail-official/dkg-core';
import {
  createPromoteWorkerSupervisor,
  runPromoteJob,
} from '../src/daemon/worker/async-promote-worker.js';
import {
  createAsyncPromoteWorkerFixture,
  deferred,
  promoteFailureDiagnostics,
  retryableBookkeepingFailure,
  type AsyncPromoteWorkerFixture,
} from './_helpers/async-promote-worker-fixture.js';
import { createClaimFailureBackoff } from '../src/daemon/worker/claim-failure-backoff.js';
import { promoteJobToView } from '../src/daemon/routes/promote-job-view.js';

const PROMOTE_RETRYABLE_FAILURE_CODE = 'PROMOTE_RETRYABLE_FAILURE';

describe('claim failure backoff', () => {
  it('grows from 250ms to the 30s cap with injected time and randomness', () => {
    let now = 1_000;
    const backoff = createClaimFailureBackoff({
      now: () => now,
      random: () => 0.5,
    });

    expect(backoff.recordFailure()).toBe(250);
    expect(backoff.isDue()).toBe(false);
    now += 250;
    expect(backoff.isDue()).toBe(true);
    expect(backoff.recordFailure()).toBe(500);
    now += 500;
    for (let i = 0; i < 10; i += 1) {
      now += backoff.recordFailure();
    }
    expect(backoff.recordFailure()).toBe(30_000);
  });

  it('resets the next failure to the base delay', () => {
    let now = 1_000;
    const backoff = createClaimFailureBackoff({
      now: () => now,
      random: () => 0.5,
    });

    expect(backoff.recordFailure()).toBe(250);
    now += 250;
    expect(backoff.recordFailure()).toBe(500);
    backoff.reset();
    expect(backoff.isDue()).toBe(true);
    expect(backoff.recordFailure()).toBe(250);
  });

  it('applies both ±20% jitter bounds while retaining the absolute cap', () => {
    const low = createClaimFailureBackoff({ now: () => 0, random: () => 0 });
    const high = createClaimFailureBackoff({ now: () => 0, random: () => 1 });

    expect(low.recordFailure()).toBe(200);
    expect(high.recordFailure()).toBe(300);
    for (let i = 0; i < 10; i += 1) high.recordFailure();
    expect(high.recordFailure()).toBe(30_000);
  });
});

describe('runPromoteJob', () => {
  let fixture: AsyncPromoteWorkerFixture;
  let queue: AsyncPromoteQueue;
  let logs: string[];
  let makeRequest: AsyncPromoteWorkerFixture['makeRequest'];
  let enqueueAndClaim: AsyncPromoteWorkerFixture['enqueueAndClaim'];

  beforeEach(() => {
    fixture = createAsyncPromoteWorkerFixture();
    ({ queue, logs, makeRequest, enqueueAndClaim } = fixture);
  });

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
      now: fixture.clock.now,
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
    // ('swmInserted')` or `queue.succeed()` write fails permanently (or
    // loses its lease), the previous behavior let the
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
      effectiveLeaseMs: 15 * 60 * 1000,
      ...queue,
      recordCommitMarker: async (jobId, claimToken, step) => {
        if (step === 'swmInserted') {
          throw new Error('simulated non-retryable bookkeeping failure');
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
      now: fixture.clock.now,
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

    fixture.clock.advance(16 * 60 * 1000);
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
      now: fixture.clock.now,
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
      now: fixture.clock.now,
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
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        throw new Error('fetch failed');
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      log: (message) => logs.push(message),
    });
    expect(result.outcome).toBe('failed_retrying');
    expect(result.error?.classification).toBe('transient');
    const final = await queue.getStatus(job.jobId);
    expect(final?.state).toBe('failed_retrying');
    expect(final?.attempt.nextRetryAt).toBeGreaterThan(fixture.clock.now());
    expect(promoteFailureDiagnostics(logs)).toEqual([
      expect.objectContaining({
        event: 'async_promote_attempt_failed',
        jobId: job.jobId,
        attempt: 1,
        maxAttempts: 3,
        promoteStartedMarkerPersisted: true,
        swmCommitObserved: false,
        stage: 'unknown',
        classification: 'transient',
        retryable: true,
      }),
    ]);
  });

  it('keeps a serialized cross-boundary generic failure queued for retry', async () => {
    const job = await enqueueAndClaim();
    const result = await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        throw { code: PROMOTE_RETRYABLE_FAILURE_CODE };
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      log: (message) => logs.push(message),
    });

    expect(result).toMatchObject({
      outcome: 'failed_retrying',
      error: { classification: 'transient', retryable: true },
    });
    expect(await queue.getStatus(job.jobId)).toMatchObject({ state: 'failed_retrying' });
    expect(promoteFailureDiagnostics(logs)).toEqual([
      expect.objectContaining({
        classification: 'transient',
        retryable: true,
        errorName: 'PromoteRetryableFailureError',
        errorCode: PROMOTE_RETRYABLE_FAILURE_CODE,
      }),
    ]);
  });

  it('logs only a typed, bounded authority reason behind a retryable promote prerequisite', async () => {
    const job = await enqueueAndClaim();
    await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        throw createPromoteRetryableFailure(Object.assign(new Error('private detail'), {
          code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
          reason: 'finalized-name-absence-unaccepted',
          detail: 'private detail',
        }));
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      log: (message) => logs.push(message),
    });
    const diagnostic = promoteFailureDiagnostics(logs)[0];
    expect(diagnostic).toMatchObject({
      errorCode: PROMOTE_RETRYABLE_FAILURE_CODE,
      authorityReason: 'finalized-name-absence-unaccepted',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private detail');
    expect(diagnostic).not.toHaveProperty('causeCode');
    // An authority error that carries no throw site logs none.
    expect(diagnostic).not.toHaveProperty('authoritySite');
  });

  // GH#3067 — the log said which authority reason ended an attempt but not
  // which check raised it, so a loop failure and a failed chain read looked alike.
  describe('throw site and store failure of an attempt (GH#3067)', () => {
    async function logOf(thrown: unknown) {
      const job = await enqueueAndClaim();
      const result = await runPromoteJob({
        job,
        queue,
        workerId: 'worker-test',
        runPromote: async (_request, markPromoteStarted) => {
          await markPromoteStarted();
          throw thrown;
        },
        now: fixture.clock.now,
        heartbeatIntervalMs: 0,
        log: (message) => logs.push(message),
      });
      return { result, diagnostic: promoteFailureDiagnostics(logs)[0], job };
    }

    const authorityCause = (extra: Record<string, unknown>) => Object.assign(new Error('private detail'), {
      code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
      reason: 'chain-participant-authority-unavailable',
      detail: 'private detail',
      ...extra,
    });

    it.each([
      'transport-unavailable',
      'transport-changed',
      'revision-moved',
      'recipient-set-changed',
    ])('logs the closed throw site %s behind a retryable authority failure', async (site) => {
      const { diagnostic } = await logOf(createPromoteRetryableFailure(authorityCause({ site })));

      expect(diagnostic).toMatchObject({
        errorCode: PROMOTE_RETRYABLE_FAILURE_CODE,
        authorityReason: 'chain-participant-authority-unavailable',
        authoritySite: site,
      });
      expect(JSON.stringify(diagnostic)).not.toContain('private detail');
    });

    it.each([
      'AKIAIOSFODNN7EXAMPLE',
      'https://rpc.example/key',
      'toString',
      '__proto__',
      'constructor',
      'x'.repeat(1_000),
      42,
      null,
      { site: 'revision-moved' },
    ])('drops a throw site that is not in the closed set (%j) without leaking it', async (site) => {
      const { result, diagnostic } = await logOf(createPromoteRetryableFailure(authorityCause({ site })));

      expect(result.outcome).toBe('failed_retrying');
      expect(diagnostic).not.toHaveProperty('authoritySite');
      expect(diagnostic).toMatchObject({ authorityReason: 'chain-participant-authority-unavailable' });
      if (typeof site === 'string') expect(JSON.stringify(diagnostic)).not.toContain(site);
    });

    it('survives a throw site whose getter throws and still does the queue bookkeeping', async () => {
      const hostile = authorityCause({});
      Object.defineProperty(hostile, 'site', { get() { throw new Error('hostile getter'); } });

      const { result, diagnostic, job } = await logOf(createPromoteRetryableFailure(hostile));

      expect(result.outcome).toBe('failed_retrying');
      expect(await queue.getStatus(job.jobId)).toMatchObject({ state: 'failed_retrying' });
      expect(diagnostic).not.toHaveProperty('authoritySite');
    });

    it('does not read a throw site from an error that is not an authority error', async () => {
      const { diagnostic } = await logOf(createPromoteRetryableFailure(
        Object.assign(new Error('x'), { code: 'SOMETHING_ELSE', reason: 'chain-participant-authority-unavailable', site: 'revision-moved' }),
      ));

      expect(diagnostic).not.toHaveProperty('authoritySite');
    });

    it.each([
      {
        name: 'a queue wait timeout',
        thrown: () => new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'publisher.asyncPromote.claimNext.candidates'),
        storeFailure: 'queue_wait',
      },
      {
        name: 'a full queue',
        thrown: () => new StoreSchedulerBusyError('queue_full', 'normal', 'publisher.asyncPromote.write'),
        storeFailure: 'queue_full',
      },
      {
        name: 'a store deadline before the operation started',
        thrown: () => new StoreOperationTimeoutError({ backend: 'blazegraph', operation: 'query', outcome: 'not_started' }),
        storeFailure: 'store_timeout_not_started',
      },
      {
        name: 'a store deadline of a read that was already running',
        thrown: () => new StoreOperationTimeoutError({ backend: 'blazegraph', operation: 'query', outcome: 'indeterminate' }),
        storeFailure: 'store_timeout_indeterminate',
      },
    ])('names $name from a closed set instead of an unknown error', async ({ thrown, storeFailure }) => {
      const { diagnostic } = await logOf(thrown());

      expect(diagnostic).toMatchObject({ storeFailure });
      expect(diagnostic).not.toHaveProperty('authorityReason');
      expect(diagnostic).not.toHaveProperty('authoritySite');
    });

    it('names a store failure that a retryable promote failure wraps as its cause', async () => {
      const { diagnostic } = await logOf(createPromoteRetryableFailure(
        new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'agent.query'),
      ));

      expect(diagnostic).toMatchObject({ storeFailure: 'queue_wait' });
    });

    it('does not invent a store failure for an error that only looks like one', async () => {
      const { diagnostic } = await logOf(Object.assign(new Error('queue wait timeout'), {
        code: 'NOT_A_STORE_ERROR',
        reason: 'queue_wait_timeout',
        outcome: 'not_started',
      }));

      expect(diagnostic).not.toHaveProperty('storeFailure');
    });
  });

  it('names the legacy SWM retirement fence behind a retryable promote, from a closed set', async () => {
    const job = await enqueueAndClaim();
    await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        throw createPromoteRetryableFailure(Object.assign(
          new Error('RFC-64 legacy SWM boundary retirement is in progress; retry promotion'),
          { code: 'RFC64_LEGACY_SWM_BOUNDARY_RETIREMENT_IN_PROGRESS' },
        ));
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      log: (message) => logs.push(message),
    });
    expect(promoteFailureDiagnostics(logs)[0]).toMatchObject({
      classification: 'transient',
      retryable: true,
      errorCode: PROMOTE_RETRYABLE_FAILURE_CODE,
      causeCode: 'RFC64_LEGACY_SWM_BOUNDARY_RETIREMENT_IN_PROGRESS',
    });
    expect(await queue.getStatus(job.jobId)).toMatchObject({ state: 'failed_retrying' });
    // The allowlist is built from the shared contract code, so the wire value is what gets named.
    expect(RFC64_LEGACY_SWM_BOUNDARY_RETIREMENT_IN_PROGRESS_CODE)
      .toBe('RFC64_LEGACY_SWM_BOUNDARY_RETIREMENT_IN_PROGRESS');
  });

  describe('a promote refused by the legacy SWM retirement fence', () => {
    const fenceFailure = () => createPromoteRetryableFailure(Object.assign(
      new Error('RFC-64 legacy SWM boundary retirement is in progress; retry promotion'),
      { code: 'RFC64_LEGACY_SWM_BOUNDARY_RETIREMENT_IN_PROGRESS' },
    ));

    it('is retried by the queue and completes on the second attempt with the same request', async () => {
      await queue.enqueue(makeRequest({ assertionName: 'fenced-share' }));
      const seen: PromoteRequest[] = [];
      const attempt = async (refuse: boolean) => {
        const claimed = await queue.claimNext('worker-test');
        if (!claimed) throw new Error('nothing to claim');
        const result = await runPromoteJob({
          job: claimed,
          queue,
          workerId: 'worker-test',
          runPromote: async (request, markPromoteStarted) => {
            seen.push(request);
            await markPromoteStarted();
            if (refuse) throw fenceFailure();
            return { promotedCount: 1 };
          },
          now: fixture.clock.now,
          heartbeatIntervalMs: 0,
          log: (message) => logs.push(message),
        });
        return { claimed, result };
      };

      const first = await attempt(true);
      expect(first.result).toMatchObject({
        outcome: 'failed_retrying',
        error: { classification: 'transient', retryable: true },
      });
      expect(await queue.getStatus(first.claimed.jobId)).toMatchObject({
        state: 'failed_retrying',
        attempt: { count: 1 },
      });

      fixture.clock.advance(120_000);
      const second = await attempt(false);
      expect(second.result.outcome).toBe('succeeded');
      expect(second.claimed.jobId).toBe(first.claimed.jobId);
      expect(await queue.getStatus(first.claimed.jobId)).toMatchObject({
        state: 'succeeded',
        attempt: { count: 2 },
      });
      expect(seen).toHaveLength(2);
      expect(seen[1]).toEqual(seen[0]);
    });

    it('keeps retrying past its attempt budget for an hour after enqueue, then ends failed yet retryable; recover requeues it', async () => {
      await queue.enqueue(makeRequest({ assertionName: 'fenced-forever' }));
      // One attempt every 10 minutes: the budget of 3 is spent after 20 minutes,
      // the window of the typed prerequisite failure ends at 60.
      for (let attempt = 1; attempt <= 7; attempt += 1) {
        const claimed = await queue.claimNext('worker-test');
        expect(claimed).not.toBeNull();
        await runPromoteJob({
          job: claimed!,
          queue,
          workerId: 'worker-test',
          runPromote: async (_request, markPromoteStarted) => {
            await markPromoteStarted();
            throw fenceFailure();
          },
          now: fixture.clock.now,
          heartbeatIntervalMs: 0,
          log: (message) => logs.push(message),
        });
        if (attempt < 7) {
          expect((await queue.list({}))[0]).toMatchObject({
            state: 'failed_retrying',
            attempt: { count: attempt, maxRetries: 3 },
          });
        }
        fixture.clock.advance(10 * 60_000);
      }
      const [job] = await queue.list({});
      expect(job).toMatchObject({ state: 'failed', attempt: { count: 7 } });
      expect(promoteJobToView(job)).toMatchObject({
        state: 'failed',
        attempts: 7,
        maxAttempts: 3,
        lastError: {
          code: 'transient',
          retryable: true,
          diagnosticCode: 'PROMOTE_RETRYABLE_FAILURE',
          message: 'A promote prerequisite is temporarily unavailable',
        },
      });
      // It is not a post-commit failure, so the recovery sweep leaves it for the operator.
      await expect(queue.recoverPostCommitFailures()).resolves.toEqual([]);
      await queue.recover(job.jobId);
      expect(await queue.getStatus(job.jobId)).toMatchObject({ state: 'queued' });
    });
  });

  it.each([
    'AKIAIOSFODNN7EXAMPLE',
    'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
    'rfc64_legacy_swm_boundary_retirement_in_progress',
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
  ])('never logs the cause code %s: it is outside the closed set, however token-shaped', async (code) => {
    const job = await enqueueAndClaim();
    await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        throw createPromoteRetryableFailure(Object.assign(new Error('private detail'), { code }));
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      log: (message) => logs.push(message),
    });
    const diagnostic = promoteFailureDiagnostics(logs)[0];
    expect(diagnostic).toMatchObject({ errorCode: PROMOTE_RETRYABLE_FAILURE_CODE });
    expect(diagnostic).not.toHaveProperty('causeCode');
    // The authority marker keeps its own reason field; a stray secret must not appear anywhere.
    if (code === 'AKIAIOSFODNN7EXAMPLE') expect(logs.join('\n')).not.toContain(code);
  });

  it('identifies a metadata-revision retry without logging the context graph id', async () => {
    const job = await enqueueAndClaim();
    await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        throw createPromoteRetryableFailure(Object.assign(new Error('private graph id'), {
          code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
          reason: 'local-existence-unavailable',
          detail: 'Context graph "private graph id" metadata authority changed while resolving its agent gate',
        }));
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      log: (message) => logs.push(message),
    });
    const diagnostic = promoteFailureDiagnostics(logs)[0];
    expect(diagnostic).toMatchObject({
      authorityReason: 'local-existence-unavailable',
      authorityOrigin: 'agent-gate-revision',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private graph id');
  });

  it('uses publisher-owned diagnostics for a certified replay-safe failure', async () => {
    const job = await enqueueAndClaim();
    const replaySafeFailure = classifyExactSwmGraphReplaceFailure(
      new StoreOperationTimeoutError({
        backend: 'oxigraph-server',
        operation: 'replaceGraph',
        outcome: 'indeterminate',
      }),
    );

    await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        throw replaySafeFailure;
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      log: (message) => logs.push(message),
    });

    expect(promoteFailureDiagnostics(logs)).toEqual([
      expect.objectContaining({
        classification: 'transient',
        retryable: true,
        errorName: 'PromoteReplaySafeError',
        errorCode: 'PROMOTE_REPLAY_SAFE_FAILURE',
      }),
    ]);
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
      now: fixture.clock.now,
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
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      log: (message) => logs.push(message),
    });
    expect(result.outcome).toBe('failed_terminal');
    expect(result.error?.classification).toBe('fatal');
    expect((await queue.getStatus(job.jobId))?.state).toBe('failed');
    expect(promoteFailureDiagnostics(logs)).toEqual([
      expect.objectContaining({
        promoteStartedMarkerPersisted: false,
        swmCommitObserved: false,
        classification: 'fatal',
        retryable: false,
      }),
    ]);
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
        now: fixture.clock.now,
        heartbeatIntervalMs: 0,
        log: () => {},
      });
      fixture.clock.advance(120_000); // > backoff so next claimNext picks it up
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
        now: fixture.clock.now,
        heartbeatIntervalMs: 0,
        log: () => {},
      }),
    ).rejects.toThrow(/active lease/);
  });

  it('persists the publisher diagnostic code of a post-commit failure for the recovery sweep', async () => {
    const job = await enqueueAndClaim();
    const result = await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        throw createPromotePostCommitFailure(new Error('durable tail failed'));
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      log: (message) => logs.push(message),
    });
    expect(result.outcome).toBe('failed_terminal');
    expect((await queue.getStatus(job.jobId))?.attempt.lastError).toMatchObject({
      classification: 'fatal',
      retryable: false,
      diagnosticCode: 'PROMOTE_POST_COMMIT_FAILURE',
    });

    // An upstream error without a publisher disposition persists no code.
    const untyped = await enqueueAndClaim(makeRequest({ assertionName: 'untyped' }));
    await runPromoteJob({
      job: untyped,
      queue,
      workerId: 'worker-test',
      runPromote: async () => {
        throw new Error('assertion not found');
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      log: (message) => logs.push(message),
    });
    const untypedError = (await queue.getStatus(untyped.jobId))?.attempt.lastError;
    expect(untypedError?.classification).toBe('fatal');
    expect(untypedError).not.toHaveProperty('diagnosticCode');
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
    vi.useRealTimers();
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

  it('logs a job run that crashes and goes on to run the next job', async () => {
    // The first claimed job loses its lease, so its run throws before any
    // promote. The supervisor has to report that and stay in service: with no
    // lease there is nothing to park, and the next job must still complete.
    const crashLogs: string[] = [];
    let claims = 0;
    const firstClaimLeaseless = Object.create(queue) as AsyncPromoteQueue;
    firstClaimLeaseless.claimNext = async (workerId) => {
      const claimed = await queue.claimNext(workerId);
      if (!claimed) return claimed;
      claims += 1;
      return claims === 1 ? { ...claimed, lease: undefined } : claimed;
    };
    await queue.enqueue(makeRequest('crashing'));
    await queue.enqueue(makeRequest('healthy'));
    const sup = createPromoteWorkerSupervisor({
      agent: {
        promoteQueue: firstClaimLeaseless,
        assertion: { promote: async () => ({ promotedCount: 1 }) },
      } as any,
      workerConcurrency: 1,
      pollIntervalMs: 1_000_000,
      heartbeatIntervalMs: 0,
      log: (message) => { crashLogs.push(message); },
      workerIdPrefix: 'test',
    });

    await sup.start();
    try {
      expect(await sup.tickOnce()).toBe(1);
      await vi.waitFor(() => {
        expect(crashLogs.filter((line) => line.includes('crashed processing'))).toEqual([
          expect.stringMatching(/^Worker test-slot-0 crashed processing \S+: .*active lease/),
        ]);
      });

      // Still in service: the same started supervisor frees the slot, claims
      // the next job and completes it. The poll is disabled in this test, so
      // the claim is driven by an explicit tick.
      expect(await sup.tickOnce()).toBe(1);
      await vi.waitFor(async () => {
        expect((await queue.getStats()).succeeded).toBe(1);
      });
      expect(sup.getCounters()).toMatchObject({ attempted: 2, succeeded: 1 });
    } finally {
      await sup.stop();
    }
  });

  it('wakes immediately on enqueue while retaining a slow durable fallback poll', async () => {
    const promoted = deferred();
    const sup = createPromoteWorkerSupervisor({
      agent: makeAgentStub(async () => {
        promoted.resolve();
        return { promotedCount: 1 };
      }),
      workerConcurrency: 4,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 0,
      log: () => {},
      workerIdPrefix: 'test',
    });
    await sup.start();

    await queue.enqueue(makeRequest('signalled'));
    await Promise.race([
      promoted.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('enqueue wake timed out')), 500)),
    ]);
    await sup.stop();

    expect((await queue.getStats()).succeeded).toBe(1);
  });

  it('retains the exact 100ms fallback for durable work written through another queue instance', async () => {
    vi.useFakeTimers();
    const externalQueue = new TripleStoreAsyncPromoteQueue(store, {
      now: () => Date.now(),
      backoff: () => 50,
      maxRetries: 2,
    });
    const promoted = deferred();
    const sup = createPromoteWorkerSupervisor({
      agent: makeAgentStub(async () => {
        promoted.resolve();
        return { promotedCount: 1 };
      }),
      workerConcurrency: 1,
      heartbeatIntervalMs: 0,
      log: () => {},
      workerIdPrefix: 'durable-fallback',
    });
    await sup.start();

    // This queue instance has no scheduler attached, so the supervisor can
    // observe the durable write only through its public 100ms fallback poll.
    await externalQueue.enqueue(makeRequest('external-write'));
    await vi.advanceTimersByTimeAsync(99);
    expect((await queue.getStats()).running).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await promoted.promise;
    await sup.stop();

    expect((await queue.getStats()).succeeded).toBe(1);
  });

  it('wakes only the latest supervisor after scheduler handoff and stale stop', async () => {
    const firstOwnerCalls: string[] = [];
    const currentOwnerCalls: string[] = [];
    const firstCurrentRun = deferred();
    const secondCurrentRun = deferred();
    const firstSupervisor = createPromoteWorkerSupervisor({
      agent: makeAgentStub(async (request) => {
        firstOwnerCalls.push(request.assertionName);
        return { promotedCount: 1 };
      }),
      workerConcurrency: 1,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 0,
      log: () => {},
      workerIdPrefix: 'superseded',
    });
    const currentSupervisor = createPromoteWorkerSupervisor({
      agent: makeAgentStub(async (request) => {
        currentOwnerCalls.push(request.assertionName);
        if (currentOwnerCalls.length === 1) firstCurrentRun.resolve();
        if (currentOwnerCalls.length === 2) secondCurrentRun.resolve();
        return { promotedCount: 1 };
      }),
      workerConcurrency: 1,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 0,
      log: () => {},
      workerIdPrefix: 'current',
    });

    await firstSupervisor.start();
    await currentSupervisor.start();
    await queue.enqueue(makeRequest('after-handoff'));
    await Promise.race([
      firstCurrentRun.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('handoff wake timed out')), 500)),
    ]);
    expect(firstOwnerCalls).toEqual([]);

    // This detach belongs to the superseded attachment and must not remove
    // the current supervisor's scheduler ownership.
    await firstSupervisor.stop();
    await queue.enqueue(makeRequest('after-stale-stop'));
    await Promise.race([
      secondCurrentRun.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('post-stop wake timed out')), 500)),
    ]);
    await currentSupervisor.stop();

    expect(firstOwnerCalls).toEqual([]);
    expect(currentOwnerCalls).toEqual(['after-handoff', 'after-stale-stop']);
  });

  it('rolls startup back when scheduler attachment throws and can retry cleanly', async () => {
    let attachAttempts = 0;
    const wrappedQueue = new Proxy(queue, {
      get(target, prop, receiver) {
        if (prop === 'workScheduling') {
          return {
            attachScheduler(scheduler: { onWorkAvailable: () => void }) {
              attachAttempts += 1;
              if (attachAttempts === 1) throw new Error('scheduler attachment failed');
              return target.workScheduling.attachScheduler(scheduler);
            },
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as AsyncPromoteQueue;
    const promoted = deferred();
    const agent = makeAgentStub(async () => {
      promoted.resolve();
      return { promotedCount: 1 };
    });
    agent.promoteQueue = wrappedQueue;
    const sup = createPromoteWorkerSupervisor({
      agent,
      workerConcurrency: 1,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 0,
      log: () => {},
      workerIdPrefix: 'startup-rollback',
    });

    await expect(sup.start()).rejects.toThrow('scheduler attachment failed');
    await expect(sup.start()).resolves.toBeUndefined();
    await queue.enqueue(makeRequest('after-startup-retry'));
    await Promise.race([
      promoted.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('startup retry wake timed out')), 500)),
    ]);
    await sup.stop();

    expect(attachAttempts).toBe(2);
    expect((await queue.getStats()).succeeded).toBe(1);
  });

  it('wakes immediately on resume when queued work was observed while paused', async () => {
    const promoted = deferred();
    let promoteCalls = 0;
    const sup = createPromoteWorkerSupervisor({
      agent: makeAgentStub(async () => {
        promoteCalls += 1;
        promoted.resolve();
        return { promotedCount: 1 };
      }),
      workerConcurrency: 1,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 0,
      log: () => {},
      workerIdPrefix: 'resume',
    });
    await sup.start();
    await queue.pause();
    await queue.enqueue(makeRequest('paused'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(promoteCalls).toBe(0);

    await queue.resume();
    await Promise.race([
      promoted.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('resume wake timed out')), 500)),
    ]);
    await sup.stop();

    expect(promoteCalls).toBe(1);
    expect((await queue.getStats()).succeeded).toBe(1);
  });

  it('drains a backlog larger than worker concurrency from a single resume wake', async () => {
    await queue.pause();
    await queue.enqueue(makeRequest('backlog-a'));
    await queue.enqueue(makeRequest('backlog-b'));
    await queue.enqueue(makeRequest('backlog-c'));

    const allPromoted = deferred();
    const promoted: string[] = [];
    const sup = createPromoteWorkerSupervisor({
      agent: makeAgentStub(async (request) => {
        promoted.push(request.assertionName);
        if (promoted.length === 3) allPromoted.resolve();
        return { promotedCount: 1 };
      }),
      workerConcurrency: 1,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 0,
      log: () => {},
      workerIdPrefix: 'backlog',
    });
    await sup.start();

    await queue.resume();
    await Promise.race([
      allPromoted.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('backlog drain timed out')), 2_000)),
    ]);
    await sup.stop();

    expect([...promoted].sort()).toEqual(['backlog-a', 'backlog-b', 'backlog-c']);
    expect((await queue.getStats()).succeeded).toBe(3);
  });

  it('stops probing remaining idle slots after the first empty claim', async () => {
    let claimCalls = 0;
    const wrappedQueue = Object.create(queue) as AsyncPromoteQueue;
    wrappedQueue.claimNext = async (workerId: string) => {
      claimCalls += 1;
      return queue.claimNext(workerId);
    };
    const sup = createPromoteWorkerSupervisor({
      agent: {
        promoteQueue: wrappedQueue,
        assertion: { promote: async () => ({ promotedCount: 0 }) },
      } as any,
      workerConcurrency: 4,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 0,
      log: () => {},
      workerIdPrefix: 'test',
    });
    await sup.start();
    expect(await sup.tickOnce()).toBe(0);
    await sup.stop();

    expect(claimCalls).toBe(1);
  });

  it('backs off repeated claim failures instead of polling the store continuously', async () => {
    let now = 10_000;
    let claimCalls = 0;
    const wrappedQueue = Object.create(queue) as AsyncPromoteQueue;
    wrappedQueue.claimNext = async () => {
      claimCalls += 1;
      throw new Error('store unavailable');
    };
    const sup = createPromoteWorkerSupervisor({
      agent: {
        promoteQueue: wrappedQueue,
        assertion: { promote: async () => ({ promotedCount: 0 }) },
      } as any,
      workerConcurrency: 4,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 0,
      now: () => now,
      random: () => 0.5,
      log: (message) => logs.push(message),
      workerIdPrefix: 'claim-backoff',
    });

    await sup.start();
    for (let i = 0; i < 400; i += 1) await sup.tickOnce();
    expect(claimCalls).toBe(1);

    now += 249;
    expect(await sup.tickOnce()).toBe(0);
    expect(claimCalls).toBe(1);
    now += 1;
    expect(await sup.tickOnce()).toBe(0);
    expect(claimCalls).toBe(2);

    now += 499;
    expect(await sup.tickOnce()).toBe(0);
    expect(claimCalls).toBe(2);
    now += 1;
    expect(await sup.tickOnce()).toBe(0);
    expect(claimCalls).toBe(3);
    expect(logs.some((message) => message.includes('retrying in 500ms'))).toBe(true);

    await sup.stop();
  });

  it('automatically retries a failed claim when the backoff deadline arrives', async () => {
    vi.useFakeTimers();
    let claimCalls = 0;
    const wrappedQueue = Object.create(queue) as AsyncPromoteQueue;
    wrappedQueue.claimNext = async () => {
      claimCalls += 1;
      throw new Error('store unavailable');
    };
    const sup = createPromoteWorkerSupervisor({
      agent: {
        promoteQueue: wrappedQueue,
        assertion: { promote: async () => ({ promotedCount: 0 }) },
      } as any,
      workerConcurrency: 1,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 0,
      random: () => 0.5,
      log: (message) => logs.push(message),
      workerIdPrefix: 'automatic-claim-retry',
    });

    await sup.start();
    await queue.enqueue(makeRequest('automatic-claim-retry'));
    await vi.advanceTimersByTimeAsync(0);
    expect(claimCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(claimCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(claimCalls).toBe(2);
    expect(logs.some((message) => message.includes('retrying in 500ms'))).toBe(true);

    await sup.stop();
  });

  it('resets claim backoff after the queue recovers', async () => {
    let now = 10_000;
    let claimCalls = 0;
    const wrappedQueue = Object.create(queue) as AsyncPromoteQueue;
    wrappedQueue.claimNext = async () => {
      claimCalls += 1;
      if (claimCalls === 2) return null;
      throw new Error('store unavailable');
    };
    const sup = createPromoteWorkerSupervisor({
      agent: {
        promoteQueue: wrappedQueue,
        assertion: { promote: async () => ({ promotedCount: 0 }) },
      } as any,
      workerConcurrency: 1,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 0,
      now: () => now,
      random: () => 0.5,
      log: (message) => logs.push(message),
      workerIdPrefix: 'claim-recovery',
    });

    await sup.start();
    expect(await sup.tickOnce()).toBe(0);
    now += 250;
    expect(await sup.tickOnce()).toBe(0);
    expect(claimCalls).toBe(2);
    expect(await sup.tickOnce()).toBe(0);
    expect(claimCalls).toBe(3);
    expect(logs.at(-1)).toContain('retrying in 250ms');

    await sup.stop();
  });

  it('rejects a heartbeat interval that is not shorter than the queue lease', () => {
    expect(() =>
      createPromoteWorkerSupervisor({
        agent: makeAgentStub(async () => ({ promotedCount: 0 })),
        heartbeatIntervalMs: 15 * 60 * 1000,
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

  it('shutdown timeout stops bookkeeping retries and heartbeats before returning', async () => {
    await queue.enqueue(makeRequest('bookkeeping-recovery'));
    const retrySleepStarted = deferred();
    const retrySleep = deferred();
    const wrappedQueue = Object.create(queue) as AsyncPromoteQueue;
    const recordCommitMarker = queue.recordCommitMarker.bind(queue);
    const heartbeat = queue.heartbeat.bind(queue);
    let swmMarkerWrites = 0;
    let heartbeatWrites = 0;
    wrappedQueue.recordCommitMarker = async (jobId, claimToken, step) => {
      if (step === 'swmInserted') {
        swmMarkerWrites += 1;
        throw retryableBookkeepingFailure();
      }
      return recordCommitMarker(jobId, claimToken, step);
    };
    wrappedQueue.heartbeat = async (jobId, claimToken) => {
      heartbeatWrites += 1;
      return heartbeat(jobId, claimToken);
    };

    const sup = createPromoteWorkerSupervisor({
      agent: {
        promoteQueue: wrappedQueue,
        assertion: { promote: async () => ({ promotedCount: 1 }) },
      } as any,
      workerConcurrency: 1,
      pollIntervalMs: 1_000_000,
      heartbeatIntervalMs: 5,
      bookkeepingRetryIntervalMs: 60_000,
      shutdownTimeoutMs: 25,
      sleep: async () => {
        retrySleepStarted.resolve();
        await retrySleep.promise;
      },
      log: (m) => logs.push(m),
      workerIdPrefix: 'test',
    });
    await sup.start();
    await sup.tickOnce();
    await retrySleepStarted.promise;

    await sup.stop();
    const writesAtStop = swmMarkerWrites;
    const heartbeatsAtStop = heartbeatWrites;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(writesAtStop).toBe(1);
    expect(swmMarkerWrites).toBe(writesAtStop);
    expect(heartbeatWrites).toBe(heartbeatsAtStop);
    expect(sup.getCounters().interruptedAtShutdown).toBe(1);
    expect((await queue.getStats()).running).toBe(1);
    expect((await queue.getStats()).succeeded).toBe(0);
    expect((await queue.getStats()).failed).toBe(0);

    retrySleep.resolve();
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
      bookkeepingRetryBudgetMs: 500,
      log: (m) => logs.push(m),
      workerIdPrefix: 'test',
    });
    await sup.start();
    expect((await recoverableQueue.getStats()).failed).toBe(1);
    expect((await recoverableQueue.getStats()).running).toBe(0);
    expect(logs.some((m) => m.includes('abandoned=1'))).toBe(true);
    await sup.stop();
  });

  it('validates worker timing against the queue effective lease', () => {
    const shortLeaseQueue = new TripleStoreAsyncPromoteQueue(store, { leaseMs: 1_000 });
    const agent = {
      promoteQueue: shortLeaseQueue,
      assertion: { promote: async () => ({ promotedCount: 1 }) },
    } as any;

    expect(() => createPromoteWorkerSupervisor({
      agent,
      heartbeatIntervalMs: 1_000,
      bookkeepingRetryBudgetMs: 500,
    })).toThrow(/heartbeatIntervalMs.*1000ms/);
    expect(() => createPromoteWorkerSupervisor({
      agent,
      heartbeatIntervalMs: 0,
      bookkeepingRetryBudgetMs: 1_000,
    })).toThrow(/bookkeepingRetryBudgetMs.*1000ms/);
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
  describe('post-commit recovery sweep', () => {
    const POST_COMMIT_MESSAGE = 'A promote post-commit step failed after Shared Memory was committed';

    /**
     * Seed through `target` so a running supervisor's enqueue wake cannot
     * claim the row first (a second queue instance on the same store has no
     * scheduler attached, mirroring durable rows written by another process).
     */
    async function seedPostCommitFailure(name: string, target: AsyncPromoteQueue = queue): Promise<string> {
      const jobId = await target.enqueue(makeRequest(name));
      const claimed = await target.claimNext('old-worker');
      await target.fail(jobId, claimed!.lease!.claimToken, {
        message: POST_COMMIT_MESSAGE,
        retryable: false,
        classification: 'fatal',
        recordedAt: Date.now(),
        diagnosticCode: 'PROMOTE_POST_COMMIT_FAILURE',
      });
      expect((await target.getStatus(jobId))?.state).toBe('failed');
      return jobId;
    }

    function recoveryEvents(): Array<Record<string, unknown>> {
      return logs
        .filter((line) => line.includes('"event":"async_promote_post_commit_recovery"'))
        .map((line) => JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>);
    }

    async function waitFor(predicate: () => boolean, label: string): Promise<void> {
      const deadline = Date.now() + 2_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    it('requeues a terminal post-commit failure at startup and replays it to success', async () => {
      const jobId = await seedPostCommitFailure('post-commit');
      const sup = createPromoteWorkerSupervisor({
        agent: makeAgentStub(async () => ({ promotedCount: 0 })),
        workerConcurrency: 1,
        pollIntervalMs: 1_000_000,
        postCommitRecoveryIntervalMs: 0,
        heartbeatIntervalMs: 0,
        log: (m) => logs.push(m),
        workerIdPrefix: 'test',
      });
      await sup.start();

      const requeued = (await queue.getStatus(jobId))!;
      expect(requeued.state).toBe('failed_retrying');
      expect(requeued.attempt).toMatchObject({ count: 1, maxRetries: 2 });
      expect(recoveryEvents()).toEqual([expect.objectContaining({
        trigger: 'startup', jobId, action: 'requeued', attempt: 1, maxAttempts: 2, nextRetryAt: expect.any(Number),
      })]);
      expect(sup.getCounters().postCommitRequeued).toBe(1);

      // The replay runs through the normal claim path once the backoff passes.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await sup.tickOnce()).toBe(1);
      await sup.stop();
      expect((await queue.getStatus(jobId))?.state).toBe('succeeded');
      expect(sup.getCounters().succeeded).toBe(1);
    });

    it('repeats the sweep on the configured interval and marks a spent budget exhausted', async () => {
      const sup = createPromoteWorkerSupervisor({
        agent: makeAgentStub(async () => ({ promotedCount: 0 })),
        workerConcurrency: 1,
        pollIntervalMs: 1_000_000,
        postCommitRecoveryIntervalMs: 20,
        heartbeatIntervalMs: 0,
        log: (m) => logs.push(m),
        workerIdPrefix: 'test',
      });
      await sup.start();
      expect(recoveryEvents()).toEqual([]);

      const externalQueue = new TripleStoreAsyncPromoteQueue(store, {
        now: () => Date.now(),
        backoff: () => 50,
        maxRetries: 2,
      });
      const jobId = await seedPostCommitFailure('periodic', externalQueue);
      await waitFor(() => recoveryEvents().some((e) => e.jobId === jobId), 'the periodic sweep');
      expect(recoveryEvents()).toEqual([expect.objectContaining({
        trigger: 'periodic', jobId, action: 'requeued', attempt: 1, maxAttempts: 2,
      })]);
      expect((await queue.getStatus(jobId))?.state).toBe('failed_retrying');

      // A second post-commit failure on the replay spends the two-attempt budget.
      await new Promise((resolve) => setTimeout(resolve, 60));
      const replay = await queue.claimNext('replay-worker');
      expect(replay?.jobId).toBe(jobId);
      expect(replay?.attempt.count).toBe(2);
      await queue.fail(jobId, replay!.lease!.claimToken, {
        message: POST_COMMIT_MESSAGE,
        retryable: false,
        classification: 'fatal',
        recordedAt: Date.now(),
        diagnosticCode: 'PROMOTE_POST_COMMIT_FAILURE',
      });
      await waitFor(() => recoveryEvents().some((e) => e.action === 'exhausted'), 'the exhausted verdict');
      await sup.stop();
      expect(recoveryEvents().filter((e) => e.action === 'exhausted')).toEqual([expect.objectContaining({
        trigger: 'periodic', jobId, action: 'exhausted', attempt: 2, maxAttempts: 2,
      })]);
      const exhausted = (await queue.getStatus(jobId))!;
      expect(exhausted.state).toBe('failed');
      expect(exhausted.reason).toContain('automatic post-commit recovery exhausted after 2 attempts');
      expect(sup.getCounters()).toMatchObject({ postCommitRequeued: 1, postCommitExhausted: 1 });
      // The manual route keeps working on the exhausted row.
      await queue.recover(jobId);
      expect((await queue.getStatus(jobId))?.state).toBe('queued');
    });

    it('logs a failing sweep without blocking startup or polling', async () => {
      const brokenQueue = Object.create(queue) as AsyncPromoteQueue;
      brokenQueue.recoverPostCommitFailures = async () => {
        throw new Error('control graph unavailable');
      };
      await queue.enqueue(makeRequest('still-runs'));
      const sup = createPromoteWorkerSupervisor({
        agent: { ...makeAgentStub(async () => ({ promotedCount: 1 })), promoteQueue: brokenQueue },
        workerConcurrency: 1,
        pollIntervalMs: 1_000_000,
        postCommitRecoveryIntervalMs: 0,
        heartbeatIntervalMs: 0,
        log: (m) => logs.push(m),
        workerIdPrefix: 'test',
      });
      await sup.start();
      expect(logs.some((m) => m.includes('post-commit recovery sweep failed (startup): control graph unavailable'))).toBe(true);
      expect(await sup.tickOnce()).toBe(1);
      await sup.stop();
      expect((await queue.getStats()).succeeded).toBe(1);
    });
  });
});

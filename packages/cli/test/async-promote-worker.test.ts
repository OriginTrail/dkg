/**
 * Async-promote worker — unit tests.
 *
 * The worker module exports three concerns we test in isolation:
 *   - `classifyPromoteError(err)` — pure mapping.
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
import { ContextGraphAuthorityUnavailableError } from '@origintrail-official/dkg-agent';
import {
  OxigraphStore,
  StoreOperationTimeoutError,
} from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncPromoteQueue,
  type AsyncPromoteQueue,
  type PromoteRequest,
  type PromoteTerminalJobClearer,
} from '@origintrail-official/dkg-publisher';
import { classifyExactSwmGraphReplaceFailure } from '../../publisher/test/_helpers/promote-replay-safety.js';
import {
  classifyPromoteError,
  createPromoteWorkerSupervisor,
  runPromoteJob,
} from '../src/daemon/worker/async-promote-worker.js';
import {
  createAsyncPromoteWorkerFixture,
  retryableBookkeepingFailure,
  retryableSchedulerBusyFailure,
  type AsyncPromoteWorkerFixture,
} from './_helpers/async-promote-worker-fixture.js';
import { createClaimFailureBackoff } from '../src/daemon/worker/claim-failure-backoff.js';

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

const PROMOTE_FAILURE_LOG_PREFIX = '[async-promote-worker] ';

function promoteFailureDiagnostics(logs: readonly string[]): Record<string, unknown>[] {
  return logs
    .filter((line) => line.startsWith(PROMOTE_FAILURE_LOG_PREFIX))
    .map((line) => JSON.parse(line.slice(PROMOTE_FAILURE_LOG_PREFIX.length)) as Record<string, unknown>)
    .filter((entry) => entry['event'] === 'async_promote_attempt_failed');
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

  it('retries a fail-closed context-graph authority outage', () => {
    expect(classifyPromoteError(new ContextGraphAuthorityUnavailableError(
      'signing authority is temporarily unavailable',
      { reason: 'chain-participant-authority-unavailable' },
    ))).toEqual({ classification: 'transient', retryable: true });
  });

  it('does not retry an authoritative empty signing roster', () => {
    expect(classifyPromoteError(
      new Error('authoritative signing roster is empty'),
    )).toEqual({ classification: 'fatal', retryable: false });
  });

  it('requires typed outcomes for managed-store and scheduler failures', () => {
    for (const message of [
      'STORE_OPERATION_TIMEOUT Managed Oxigraph is recovering; query was not started',
      'Managed Oxigraph recovery interrupted query execution',
      'Managed Oxigraph recovery interrupted listGraphs; outcome is indeterminate',
      'Managed Oxigraph recovery interrupted countQuads; outcome is indeterminate',
      'Store scheduler queue wait timeout',
    ]) {
      expect(classifyPromoteError(new Error(message))).toEqual({
        classification: 'fatal',
        retryable: false,
      });
    }
    expect(classifyPromoteError(retryableSchedulerBusyFailure())).toEqual({
      classification: 'transient',
      retryable: true,
    });
  });

  it('retries typed indeterminate reads and producer-certified replay while failing closed for raw writes', () => {
    for (const operation of [
      'query',
      'construct',
      'hasGraph',
      'listGraphs',
      'listGraphsByPrefix',
      'countQuads',
    ] as const) {
      expect(classifyPromoteError(new StoreOperationTimeoutError({
        backend: 'oxigraph-server',
        operation,
        outcome: 'indeterminate',
      }))).toEqual({ classification: 'transient', retryable: true });
    }

    const rawReplaceFailure = new StoreOperationTimeoutError({
      backend: 'oxigraph-server',
      operation: 'replaceGraph',
      outcome: 'indeterminate',
      message: 'Managed Oxigraph recovery interrupted replaceGraph; outcome is indeterminate',
    });
    expect(classifyPromoteError(rawReplaceFailure)).toEqual({
      classification: 'fatal',
      retryable: false,
    });
    expect(classifyPromoteError(
      classifyExactSwmGraphReplaceFailure(rawReplaceFailure),
    )).toEqual({ classification: 'transient', retryable: true });
    expect(classifyPromoteError(classifyExactSwmGraphReplaceFailure(
      new StoreOperationTimeoutError({
        backend: 'oxigraph-server',
        operation: 'replaceGraph',
        outcome: 'indeterminate',
        message: 'payload too large while reading the indeterminate timeout response',
      }),
    ))).toEqual({ classification: 'transient', retryable: true });
    expect(classifyPromoteError({
      code: 'PROMOTE_REPLAY_SAFE_FAILURE',
      stage: 'atomic-exact-swm-graph-replacement',
      cause: rawReplaceFailure,
    })).toEqual({ classification: 'fatal', retryable: false });
    for (const malformed of [
      { code: 'PROMOTE_REPLAY_SAFE_FAILURE', cause: rawReplaceFailure },
      {
        code: 'PROMOTE_REPLAY_SAFE_FAILURE',
        stage: 'other',
        cause: rawReplaceFailure,
      },
      {
        code: 'PROMOTE_REPLAY_SAFE_FAILURE',
        stage: 'atomic-exact-swm-graph-replacment',
        cause: rawReplaceFailure,
      },
      {
        code: 'PROMOTE_REPLAY_SAFE_FAILURE',
        stage: 'atomic-exact-swm-graph-replacement',
      },
    ]) {
      expect(classifyPromoteError(malformed)).toEqual({
        classification: 'fatal',
        retryable: false,
      });
    }

    for (const message of [
      'insert timed out',
      'insert timeout after dispatch',
    ]) {
      expect(classifyPromoteError(new StoreOperationTimeoutError({
        backend: 'oxigraph-server',
        operation: 'insert',
        outcome: 'indeterminate',
        message,
      }))).toEqual({ classification: 'fatal', retryable: false });
    }
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

  it('logs bounded tagged failure evidence that survives terminal cleanup without leaking the message', async () => {
    const job = await enqueueAndClaim();
    const sensitiveMessage = 'query failed for secret-sentinel and https://rpc.example/private-key';
    const failure = Object.assign(
      new Error(`[promote:assertionScopedQuads] ${sensitiveMessage}`),
      { name: 'CuratorRejectedError', code: 'CURATOR_REJECTED' },
    );
    const order: string[] = [];
    let diagnosticPresentWhenFailBegan = false;
    const fail = queue.fail.bind(queue);
    queue.fail = async (jobId, claimToken, error) => {
      order.push('queue.fail.begin');
      diagnosticPresentWhenFailBegan = promoteFailureDiagnostics(logs).length === 1;
      await fail(jobId, claimToken, error);
      order.push('queue.fail.end');
    };

    const result = await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        throw failure;
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      log: (message) => {
        order.push('diagnostic');
        logs.push(message);
      },
    });

    expect(result.outcome).toBe('failed_terminal');
    expect(order).toEqual(['diagnostic', 'queue.fail.begin', 'queue.fail.end']);
    expect(diagnosticPresentWhenFailBegan).toBe(true);
    const diagnostics = promoteFailureDiagnostics(logs);
    expect(diagnostics).toEqual([
      {
        event: 'async_promote_attempt_failed',
        schemaVersion: 1,
        jobId: job.jobId,
        attempt: 1,
        maxAttempts: 3,
        promoteStartedMarkerPersisted: true,
        swmCommitObserved: false,
        stage: 'assertionScopedQuads',
        classification: 'fatal',
        retryable: false,
        errorName: 'CuratorRejectedError',
        errorCode: 'CURATOR_REJECTED',
      },
    ]);
    expect(diagnostics[0]).not.toHaveProperty('messageFingerprint');
    expect(logs.join('\n')).not.toContain('secret-sentinel');
    expect(logs.join('\n')).not.toContain('rpc.example');

    const clearer = queue as AsyncPromoteQueue & PromoteTerminalJobClearer;
    await expect(clearer.clearTerminalJob(job.jobId)).resolves.toEqual({ outcome: 'cleared' });
    await expect(queue.getStatus(job.jobId)).resolves.toBeNull();
    expect(promoteFailureDiagnostics(logs)).toEqual(diagnostics);
  });

  it('maps unowned stages and unsafe error identity to bounded unknown values', async () => {
    const job = await enqueueAndClaim();
    const sensitiveMessage = 'opaque secret-sentinel failure';
    const alphanumericSecretToken = 'AKIAIOSFODNN7EXAMPLE';
    const failure = Object.assign(new Error(`[promote:callerControlled] ${sensitiveMessage}`), {
      name: `Error${alphanumericSecretToken}`,
      code: alphanumericSecretToken,
    });

    await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        throw failure;
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      log: (message) => logs.push(message),
    });

    expect(promoteFailureDiagnostics(logs)).toEqual([
      expect.objectContaining({
        stage: 'unknown',
        errorName: 'unknown',
        errorCode: 'unknown',
      }),
    ]);
    expect(promoteFailureDiagnostics(logs)[0]).not.toHaveProperty('messageFingerprint');
    expect(logs.join('\n')).not.toContain('secret-sentinel');
    expect(logs.join('\n')).not.toContain(alphanumericSecretToken);
    expect((await queue.getStatus(job.jobId))?.state).toBe('failed');
  });

  it('keeps fail-closed queue bookkeeping intact when the diagnostic logger throws', async () => {
    const job = await enqueueAndClaim();

    const result = await runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        throw new Error('[promote:assertionScopedQuads] unknown fatal failure');
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      log: () => {
        throw new Error('logger unavailable');
      },
    });

    expect(result).toMatchObject({
      outcome: 'failed_terminal',
      error: { classification: 'fatal', retryable: false },
    });
    expect((await queue.getStatus(job.jobId))?.state).toBe('failed');
  });

  it('does not wait for an unresolved logger before queue.fail reaches terminal state', async () => {
    const job = await enqueueAndClaim();
    const pendingLog = deferred<void>();
    let loggerSettled = false;
    void pendingLog.promise.then(() => {
      loggerSettled = true;
    });

    const fail = queue.fail.bind(queue);
    let failCompleted = false;
    queue.fail = async (jobId, claimToken, error) => {
      await fail(jobId, claimToken, error);
      failCompleted = true;
    };

    const resultPromise = runPromoteJob({
      job,
      queue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        await markPromoteStarted();
        throw new Error('[promote:assertionScopedQuads] unknown fatal failure');
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      log: () => pendingLog.promise,
    });
    let runSettled = false;
    void resultPromise.then(
      () => {
        runSettled = true;
      },
      () => {
        runSettled = true;
      },
    );

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(loggerSettled).toBe(false);
      expect(failCompleted).toBe(true);
      expect(runSettled).toBe(true);
      expect((await queue.getStatus(job.jobId))?.state).toBe('failed');
    } finally {
      pendingLog.resolve();
    }

    await expect(resultPromise).resolves.toMatchObject({
      outcome: 'failed_terminal',
      error: { classification: 'fatal', retryable: false },
    });
  });

  it('does not await an async diagnostic logger and absorbs its rejection', async () => {
    const job = await enqueueAndClaim();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const result = await runPromoteJob({
        job,
        queue,
        workerId: 'worker-test',
        runPromote: async (_request, markPromoteStarted) => {
          await markPromoteStarted();
          throw new Error('[promote:assertionScopedQuads] unknown fatal failure');
        },
        now: fixture.clock.now,
        heartbeatIntervalMs: 0,
        log: async () => {
          throw new Error('async logger unavailable');
        },
      });

      expect(result).toMatchObject({
        outcome: 'failed_terminal',
        error: { classification: 'fatal', retryable: false },
      });
      expect((await queue.getStatus(job.jobId))?.state).toBe('failed');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
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
});

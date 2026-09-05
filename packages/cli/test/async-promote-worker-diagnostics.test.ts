import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { StoreOperationTimeoutError } from '@origintrail-official/dkg-storage';
import type { AsyncPromoteQueue, PromoteTerminalJobClearer } from '@origintrail-official/dkg-publisher';
import { classifyExactSwmGraphReplaceFailure } from '../../publisher/test/_helpers/promote-replay-safety.js';
import { runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';
import { createAsyncPromoteWorkerFixture, deferred, type AsyncPromoteWorkerFixture } from './_helpers/async-promote-worker-fixture.js';

const PROMOTE_FAILURE_LOG_PREFIX = '[async-promote-worker] ';

function promoteFailureDiagnostics(logs: readonly string[]): Record<string, unknown>[] {
  return logs
    .filter((line) => line.startsWith(PROMOTE_FAILURE_LOG_PREFIX))
    .map((line) => JSON.parse(line.slice(PROMOTE_FAILURE_LOG_PREFIX.length)) as Record<string, unknown>)
    .filter((entry) => entry['event'] === 'async_promote_attempt_failed');
}

describe('promote worker diagnostics and hostile loggers', () => {
  let fixture: AsyncPromoteWorkerFixture;
  let queue: AsyncPromoteQueue;
  let logs: string[];
  let enqueueAndClaim: AsyncPromoteWorkerFixture['enqueueAndClaim'];
  beforeEach(() => {
    fixture = createAsyncPromoteWorkerFixture();
    ({ queue, logs, enqueueAndClaim } = fixture);
  });
  afterEach(async () => { await fixture.store.close(); });

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

});

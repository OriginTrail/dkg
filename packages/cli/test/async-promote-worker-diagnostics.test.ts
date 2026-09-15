/**
 * Async-promote diagnostic and hostile-logger coverage.
 *
 * These cases are kept separate from the queue orchestration matrix so the
 * privacy, ordering, and sink-isolation contract has one focused home.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { StoreOperationTimeoutError } from '@origintrail-official/dkg-storage';
import {
  type AsyncPromoteQueue,
  type PromoteTerminalJobClearer,
} from '@origintrail-official/dkg-publisher';
import { classifyExactSwmGraphReplaceFailure } from '../../publisher/test/_helpers/promote-replay-safety.js';
import { runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';
import {
  createAsyncPromoteWorkerFixture,
  type AsyncPromoteWorkerFixture,
} from './_helpers/async-promote-worker-fixture.js';

const PROMOTE_FAILURE_LOG_PREFIX = '[async-promote-worker] ';

function promoteFailureDiagnostics(logs: readonly string[]): Record<string, unknown>[] {
  return logs
    .filter((line) => line.startsWith(PROMOTE_FAILURE_LOG_PREFIX))
    .map((line) => JSON.parse(line.slice(PROMOTE_FAILURE_LOG_PREFIX.length)) as Record<string, unknown>)
    .filter((entry) => entry['event'] === 'async_promote_attempt_failed');
}

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

describe('runPromoteJob diagnostics', () => {
  let fixture: AsyncPromoteWorkerFixture;
  let queue: AsyncPromoteQueue;
  let logs: string[];
  let enqueueAndClaim: AsyncPromoteWorkerFixture['enqueueAndClaim'];

  beforeEach(() => {
    fixture = createAsyncPromoteWorkerFixture();
    ({ queue, logs, enqueueAndClaim } = fixture);
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

  it('sanitizes caller-controlled error identity at the worker logging boundary', async () => {
    const job = await enqueueAndClaim();
    const secretToken = 'AKIAIOSFODNN7EXAMPLE';
    const failure = Object.assign(new Error('[promote:callerControlled] secret-sentinel failure'), {
      name: `Error${secretToken}`,
      code: secretToken,
    });
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
      log: (message) => logs.push(message),
    });

    expect(result.outcome).toBe('failed_terminal');
    expect(promoteFailureDiagnostics(logs)).toEqual([expect.objectContaining({
      stage: 'unknown', errorName: 'unknown', errorCode: 'unknown',
      classification: 'fatal', retryable: false,
    })]);
    expect(promoteFailureDiagnostics(logs)[0]).not.toHaveProperty('messageFingerprint');
    expect(logs.join('\n')).not.toContain(secretToken);
    expect(logs.join('\n')).not.toContain('secret-sentinel');
    expect(logs.join('\n')).not.toContain('callerControlled');
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

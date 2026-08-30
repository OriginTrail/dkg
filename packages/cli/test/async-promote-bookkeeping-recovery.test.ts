import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AsyncPromoteQueue,
} from '@origintrail-official/dkg-publisher';

import { runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';
import {
  createAsyncPromoteWorkerFixture,
  retryableBookkeepingFailure,
  retryableSchedulerBusyFailure,
  type AsyncPromoteWorkerFixture,
} from './_helpers/async-promote-worker-fixture.js';

describe('async promote bookkeeping recovery', () => {
  let fixture: AsyncPromoteWorkerFixture;
  let queue: AsyncPromoteQueue;
  let logs: string[];

  beforeEach(() => {
    fixture = createAsyncPromoteWorkerFixture();
    ({ queue, logs } = fixture);
  });

  it('retries transient queue.fail bookkeeping without rerunning promote', async () => {
    const job = await fixture.enqueueAndClaim();
    const recoveringQueue = Object.create(queue) as AsyncPromoteQueue;
    const fail = queue.fail.bind(queue);
    let failCalls = 0;
    let promoteCalls = 0;
    recoveringQueue.fail = async (jobId, claimToken, error) => {
      failCalls += 1;
      if (failCalls <= 2) {
        throw retryableSchedulerBusyFailure();
      }
      return fail(jobId, claimToken, error);
    };

    const result = await runPromoteJob({
      job,
      queue: recoveringQueue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        promoteCalls += 1;
        await markPromoteStarted();
        throw retryableBookkeepingFailure();
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      bookkeepingRetryIntervalMs: 5_000,
      bookkeepingRetryBudgetMs: 20_000,
      sleep: fixture.clock.sleep,
      log: (message) => logs.push(message),
    });

    expect(result).toMatchObject({
      outcome: 'failed_retrying',
      error: { classification: 'transient', retryable: true },
    });
    expect(promoteCalls).toBe(1);
    expect(failCalls).toBe(3);
    expect((await queue.getStatus(job.jobId))?.state).toBe('failed_retrying');
    expect(logs.some((line) => line.includes('Queue bookkeeping recovery started'))).toBe(true);
  });

  it('retries transient post-promote bookkeeping without rerunning a successful promote', async () => {
    const job = await fixture.enqueueAndClaim();
    const recoveringQueue = Object.create(queue) as AsyncPromoteQueue;
    const recordCommitMarker = queue.recordCommitMarker.bind(queue);
    const succeed = queue.succeed.bind(queue);
    let swmMarkerCalls = 0;
    let succeedCalls = 0;
    let promoteCalls = 0;
    recoveringQueue.recordCommitMarker = async (jobId, claimToken, step) => {
      if (step === 'swmInserted') {
        swmMarkerCalls += 1;
        if (swmMarkerCalls === 1) {
          throw retryableBookkeepingFailure();
        }
      }
      return recordCommitMarker(jobId, claimToken, step);
    };
    recoveringQueue.succeed = async (jobId, claimToken, result) => {
      succeedCalls += 1;
      if (succeedCalls === 1) {
        throw retryableBookkeepingFailure();
      }
      return succeed(jobId, claimToken, result);
    };

    const result = await runPromoteJob({
      job,
      queue: recoveringQueue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        promoteCalls += 1;
        await markPromoteStarted();
        return { promotedCount: 99 };
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      bookkeepingRetryIntervalMs: 5_000,
      bookkeepingRetryBudgetMs: 20_000,
      sleep: fixture.clock.sleep,
      log: (message) => logs.push(message),
    });

    expect(result.outcome).toBe('succeeded');
    expect(promoteCalls).toBe(1);
    expect(swmMarkerCalls).toBe(2);
    expect(succeedCalls).toBe(2);
    const final = await queue.getStatus(job.jobId);
    expect(final?.state).toBe('succeeded');
    expect(final?.commitMarker?.swmInserted).toBe(true);
    expect(final?.result?.promotedCount).toBe(99);
  });

  it('shares one recovery deadline across all post-promote bookkeeping writes', async () => {
    const job = await fixture.enqueueAndClaim();
    const recoveringQueue = Object.create(queue) as AsyncPromoteQueue;
    const recordCommitMarker = queue.recordCommitMarker.bind(queue);
    const startedAt = fixture.clock.now();
    let swmMarkerCalls = 0;
    let succeedCalls = 0;
    let promoteCalls = 0;
    recoveringQueue.recordCommitMarker = async (jobId, claimToken, step) => {
      if (step === 'swmInserted') {
        swmMarkerCalls += 1;
        if (swmMarkerCalls <= 2) {
          throw retryableBookkeepingFailure();
        }
      }
      return recordCommitMarker(jobId, claimToken, step);
    };
    recoveringQueue.succeed = async () => {
      succeedCalls += 1;
      throw retryableBookkeepingFailure();
    };

    const result = await runPromoteJob({
      job,
      queue: recoveringQueue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        promoteCalls += 1;
        await markPromoteStarted();
        return { promotedCount: 99 };
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      bookkeepingRetryIntervalMs: 5_000,
      bookkeepingRetryBudgetMs: 10_000,
      sleep: fixture.clock.sleep,
      log: (message) => logs.push(message),
    });

    expect(result.outcome).toBe('partial_promote_ambiguity');
    expect(promoteCalls).toBe(1);
    expect(swmMarkerCalls).toBe(3);
    expect(succeedCalls).toBe(1);
    expect(fixture.clock.now()).toBe(startedAt + 10_000);
    const final = await queue.getStatus(job.jobId);
    expect(final?.state).toBe('running');
    expect(final?.commitMarker?.swmInserted).toBe(true);
  });

  it('stops persistent transient bookkeeping retries at the shared deadline', async () => {
    const job = await fixture.enqueueAndClaim();
    const recoveringQueue = Object.create(queue) as AsyncPromoteQueue;
    const recordCommitMarker = queue.recordCommitMarker.bind(queue);
    const succeed = queue.succeed.bind(queue);
    const startedAt = fixture.clock.now();
    let swmMarkerCalls = 0;
    let succeedCalls = 0;
    let promoteCalls = 0;
    recoveringQueue.recordCommitMarker = async (jobId, claimToken, step) => {
      if (step === 'swmInserted') {
        swmMarkerCalls += 1;
        throw retryableBookkeepingFailure();
      }
      return recordCommitMarker(jobId, claimToken, step);
    };
    recoveringQueue.succeed = async (jobId, claimToken, result) => {
      succeedCalls += 1;
      return succeed(jobId, claimToken, result);
    };

    const result = await runPromoteJob({
      job,
      queue: recoveringQueue,
      workerId: 'worker-test',
      runPromote: async (_request, markPromoteStarted) => {
        promoteCalls += 1;
        await markPromoteStarted();
        return { promotedCount: 99 };
      },
      now: fixture.clock.now,
      heartbeatIntervalMs: 0,
      bookkeepingRetryIntervalMs: 5_000,
      bookkeepingRetryBudgetMs: 10_000,
      sleep: fixture.clock.sleep,
      log: (message) => logs.push(message),
    });

    expect(result.outcome).toBe('partial_promote_ambiguity');
    expect(promoteCalls).toBe(1);
    expect(swmMarkerCalls).toBe(3);
    expect(succeedCalls).toBe(0);
    expect(fixture.clock.now()).toBe(startedAt + 10_000);
    const final = await queue.getStatus(job.jobId);
    expect(final?.state).toBe('running');
    expect(final?.commitMarker?.swmInserted).toBe(false);
  });

});

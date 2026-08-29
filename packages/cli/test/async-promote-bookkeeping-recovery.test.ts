import { beforeEach, describe, expect, it } from 'vitest';
import {
  OxigraphStore,
  StoreOperationTimeoutError,
  StoreSchedulerBusyError,
} from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncPromoteQueue,
  type AsyncPromoteQueue,
  type PromoteJob,
  type PromoteRequest,
} from '@origintrail-official/dkg-publisher';

import { runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';

function retryableBookkeepingFailure(): StoreOperationTimeoutError {
  return new StoreOperationTimeoutError({
    backend: 'managed-oxigraph',
    operation: 'replaceSubject',
    storeOperation: 'replaceSubject',
    outcome: 'not_started',
    message: 'Managed Oxigraph is recovering; write was not started',
  });
}

function retryableSchedulerBusyFailure(): StoreSchedulerBusyError {
  return new StoreSchedulerBusyError(
    'queue_wait_timeout',
    'normal',
    'publisher.asyncPromote.write',
    { storeOperation: 'replaceSubject' },
  );
}

describe('async promote bookkeeping recovery', () => {
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

  it('retries transient queue.fail bookkeeping without rerunning promote', async () => {
    const job = await enqueueAndClaim();
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
      now: () => now,
      heartbeatIntervalMs: 0,
      bookkeepingRetryIntervalMs: 5_000,
      bookkeepingRetryBudgetMs: 20_000,
      sleep: async (ms) => {
        now += ms;
      },
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
    const job = await enqueueAndClaim();
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
      now: () => now,
      heartbeatIntervalMs: 0,
      bookkeepingRetryIntervalMs: 5_000,
      bookkeepingRetryBudgetMs: 20_000,
      sleep: async (ms) => {
        now += ms;
      },
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
    const job = await enqueueAndClaim();
    const recoveringQueue = Object.create(queue) as AsyncPromoteQueue;
    const recordCommitMarker = queue.recordCommitMarker.bind(queue);
    const startedAt = now;
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
      now: () => now,
      heartbeatIntervalMs: 0,
      bookkeepingRetryIntervalMs: 5_000,
      bookkeepingRetryBudgetMs: 10_000,
      sleep: async (ms) => {
        now += ms;
      },
      log: (message) => logs.push(message),
    });

    expect(result.outcome).toBe('partial_promote_ambiguity');
    expect(promoteCalls).toBe(1);
    expect(swmMarkerCalls).toBe(3);
    expect(succeedCalls).toBe(1);
    expect(now).toBe(startedAt + 10_000);
    const final = await queue.getStatus(job.jobId);
    expect(final?.state).toBe('running');
    expect(final?.commitMarker?.swmInserted).toBe(true);
  });

  it('stops persistent transient bookkeeping retries at the shared deadline', async () => {
    const job = await enqueueAndClaim();
    const recoveringQueue = Object.create(queue) as AsyncPromoteQueue;
    const recordCommitMarker = queue.recordCommitMarker.bind(queue);
    const succeed = queue.succeed.bind(queue);
    const startedAt = now;
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
      now: () => now,
      heartbeatIntervalMs: 0,
      bookkeepingRetryIntervalMs: 5_000,
      bookkeepingRetryBudgetMs: 10_000,
      sleep: async (ms) => {
        now += ms;
      },
      log: (message) => logs.push(message),
    });

    expect(result.outcome).toBe('partial_promote_ambiguity');
    expect(promoteCalls).toBe(1);
    expect(swmMarkerCalls).toBe(3);
    expect(succeedCalls).toBe(0);
    expect(now).toBe(startedAt + 10_000);
    const final = await queue.getStatus(job.jobId);
    expect(final?.state).toBe('running');
    expect(final?.commitMarker?.swmInserted).toBe(false);
  });

});

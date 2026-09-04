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

export interface AsyncPromoteWorkerTestClock {
  readonly now: () => number;
  readonly advance: (milliseconds: number) => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface AsyncPromoteWorkerFixture {
  readonly store: OxigraphStore;
  readonly queue: AsyncPromoteQueue;
  readonly clock: AsyncPromoteWorkerTestClock;
  readonly logs: string[];
  readonly makeRequest: (overrides?: Partial<PromoteRequest>) => PromoteRequest;
  readonly enqueueAndClaim: (
    request?: PromoteRequest,
    workerId?: string,
  ) => Promise<PromoteJob>;
}

export function retryableBookkeepingFailure(): StoreOperationTimeoutError {
  return new StoreOperationTimeoutError({
    backend: 'managed-oxigraph',
    operation: 'replaceSubject',
    storeOperation: 'replaceSubject',
    outcome: 'not_started',
    message: 'Managed Oxigraph is recovering; write was not started',
  });
}

export function retryableSchedulerBusyFailure(): StoreSchedulerBusyError {
  return new StoreSchedulerBusyError(
    'queue_wait_timeout',
    'normal',
    'publisher.asyncPromote.write',
    { storeOperation: 'replaceSubject' },
  );
}

export function createAsyncPromoteWorkerFixture(): AsyncPromoteWorkerFixture {
  const store = new OxigraphStore();
  const logs: string[] = [];
  let currentNow = 1_700_000_000_000;
  let idCounter = 0;
  const clock: AsyncPromoteWorkerTestClock = {
    now: () => currentNow,
    advance: (milliseconds) => {
      currentNow += milliseconds;
      return currentNow;
    },
    sleep: async (milliseconds) => {
      currentNow += milliseconds;
    },
  };
  const queue: AsyncPromoteQueue = new TripleStoreAsyncPromoteQueue(store, {
    now: clock.now,
    idGenerator: () => `job-${++idCounter}`,
    backoff: () => 60_000,
    maxRetries: 3,
  });
  const makeRequest = (overrides: Partial<PromoteRequest> = {}): PromoteRequest => ({
    contextGraphId: 'graphify',
    subGraphName: 'code',
    assertionName: 'shard-1',
    entities: 'all',
    ...overrides,
  });
  const enqueueAndClaim = async (
    request: PromoteRequest = makeRequest(),
    workerId = 'worker-test',
  ): Promise<PromoteJob> => {
    await queue.enqueue(request);
    const claimed = await queue.claimNext(workerId);
    if (!claimed) throw new Error('expected claimable job');
    return claimed;
  };

  return { store, queue, clock, logs, makeRequest, enqueueAndClaim };
}

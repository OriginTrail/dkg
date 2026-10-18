import type { AsyncLiftPublisher } from '../../src/index.js';

export function createRunnerPublisher(overrides: Partial<AsyncLiftPublisher> = {}): AsyncLiftPublisher {
  return {
    lift: async () => {},
    claimNext: async () => null,
    update: async () => {},
    getStatus: async () => null,
    list: async () => [],
    processNext: async () => null,
    recordPublishResult: async () => {},
    recordPublishFailure: async () => {},
    recover: async () => 0,
    reconcileTransactions: async () => 0,
    drainDetachedExecutions: async () => {},
    getStats: () => ({}),
    pause: () => {},
    resume: () => {},
    cancel: async () => {},
    retry: async () => {},
    clear: async () => {},
    ...overrides,
  } as unknown as AsyncLiftPublisher;
}

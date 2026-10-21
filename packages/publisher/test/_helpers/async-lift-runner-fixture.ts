import { AsyncLiftClaimGate } from '../../src/async-lift-claim-gate.js';
import type { AsyncLiftPublisher } from '../../src/index.js';

export function createRunnerPublisher(overrides: Partial<AsyncLiftPublisher> = {}): AsyncLiftPublisher {
  const claimGate = new AsyncLiftClaimGate(async commit => { commit?.(); });
  return {
    claimGate,
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
    pause: () => claimGate.hold(),
    resume: () => claimGate.release(),
    cancel: async () => {},
    retry: async () => {},
    clear: async () => {},
    ...overrides,
  } as unknown as AsyncLiftPublisher;
}

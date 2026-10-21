import { createAsyncLiftClaimControl } from '../../src/async-lift-claim-gate.js';
import type { AsyncLiftPublisher } from '../../src/index.js';

export function createRunnerPublisher(overrides: Partial<AsyncLiftPublisher> = {}): AsyncLiftPublisher {
  const claimControl = overrides.claimControl ?? createAsyncLiftClaimControl(async commit => { commit?.(); }, () => {});
  return {
    claimControl,
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
    pause: () => claimControl.hold(),
    resume: () => claimControl.release(),
    cancel: async () => {},
    retry: async () => {},
    clear: async () => {},
    ...overrides,
  } as unknown as AsyncLiftPublisher;
}

import type { DurableSyncBudget } from '../src/sync/requester/durable-sync.js';

export function uniformDurableSyncBudget(
  createDeadline: () => number,
): DurableSyncBudget {
  return {
    createContextGraphBudget: () => ({
      fetchDeadline: createDeadline(),
      createGraphScopedAuthenticationDeadline: createDeadline,
    }),
  };
}

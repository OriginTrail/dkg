import type { DurableSyncBudget } from '../src/sync/requester/durable-sync-budget.js';

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

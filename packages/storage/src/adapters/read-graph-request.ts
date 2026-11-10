import {
  spliceReadGraphPlan,
  type ReadGraphWriteOptions,
  type ReadGraphWritePlan,
} from '../read-graph/adapter-contract.js';
import type { QueryOptions } from '../triple-store.js';

/**
 * How an adapter sends the read-graph operations of one write: in the same
 * request as the data change (see `read-graph/adapter-contract.ts`), so the
 * backend commits both or neither. A write without operations sends exactly
 * the request it sent before.
 */
function operationsOf(options: QueryOptions | undefined): ReadGraphWritePlan | undefined {
  const plan = (options as ReadGraphWriteOptions | undefined)?.readGraphPlan;
  return plan && plan.before.length + plan.after.length > 0 ? plan : undefined;
}

/** Refuse, before anything is sent, a plan on a write whose request cannot carry operations. */
export function refuseReadGraphOperations(options: QueryOptions | undefined, write: string): void {
  if (operationsOf(options)) throw new Error(`${write} cannot send read-graph operations in its request`);
}

/**
 * One update request: the plan's `before` operations, the write's own update,
 * then the plan's `after` operations. Without operations the update is
 * returned as it is.
 */
export function withReadGraphOperations(update: string, options: QueryOptions | undefined): string {
  const plan = operationsOf(options);
  if (!plan) return update;
  // The splice adds the separators, so a caller's own trailing one would make two.
  return spliceReadGraphPlan(plan, [update.replace(/\s*;\s*$/, '')]);
}

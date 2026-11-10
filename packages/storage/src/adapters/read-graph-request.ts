import { stripSparqlLiteralsAndComments } from '@origintrail-official/dkg-core';
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
 * returned as it is. The adapter's own update text ends with an operation,
 * not a separator.
 */
export function withReadGraphOperations(update: string, options: QueryOptions | undefined): string {
  const plan = operationsOf(options);
  return plan ? spliceReadGraphPlan(plan, [update]) : update;
}

/**
 * {@link withReadGraphOperations} for a caller's own update text, which may end
 * with a `;` separator, also before a trailing comment. That separator is
 * removed first, because the splice adds its own.
 */
export function withReadGraphOperationsAroundCallerUpdate(sparql: string, options: QueryOptions | undefined): string {
  return operationsOf(options) ? withReadGraphOperations(withoutFinalSeparator(sparql), options) : sparql;
}

function withoutFinalSeparator(sparql: string): string {
  // Same length as the text, with strings, IRIs and comments blanked.
  const masked = stripSparqlLiteralsAndComments(sparql);
  const end = masked.trimEnd().length;
  return masked[end - 1] === ';' ? sparql.slice(0, end - 1) + sparql.slice(end) : sparql;
}

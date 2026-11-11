import { prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
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
 * removed first, because the splice adds its own. A prologue (`PREFIX` and
 * `BASE` declarations) that opens the caller's text stays at the start of the
 * request, before the plan's operations: Oxigraph accepts a prologue only
 * there, and the plan's operations use absolute IRIs, which it does not change.
 *
 * Both come from one pass of the SPARQL lexical scanner, which treats comments
 * as whitespace and masks strings, IRIs and comments.
 */
export function withReadGraphOperationsAroundCallerUpdate(sparql: string, options: QueryOptions | undefined): string {
  if (!operationsOf(options)) return sparql;
  const { tokens, prologue, masked } = prepareSparql(sparql);
  const start = prologue.endTokenIndex > 0 ? tokens[prologue.endTokenIndex - 1]!.end : 0;
  const spliced = withReadGraphOperations(withoutFinalSeparator(sparql.slice(start), masked.slice(start)), options);
  return start > 0 ? `${sparql.slice(0, start)}\n${spliced}` : spliced;
}

/** `text` without a final `;`, found in `masked`: the same text with strings, IRIs and comments blanked. */
function withoutFinalSeparator(text: string, masked: string): string {
  const end = masked.trimEnd().length;
  return masked[end - 1] === ';' ? text.slice(0, end - 1) + text.slice(end) : text;
}

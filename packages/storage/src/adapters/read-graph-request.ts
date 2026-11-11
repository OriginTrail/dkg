import { prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import {
  spliceReadGraphPlan,
  type ReadGraphWriteOptions,
  type ReadGraphWritePlan,
} from '../read-graph/adapter-contract.js';
import type { GraphWriteScope } from '../graph-write-gen.js';
import type { QueryOptions } from '../triple-store.js';

/**
 * How an adapter sends the read-graph operations of one write: in the same
 * request as the data change (see `read-graph/adapter-contract.ts`), so the
 * backend commits both or neither. A write without operations sends exactly
 * the request it sent before.
 */
export function operationsOf(options: QueryOptions | undefined): ReadGraphWritePlan | undefined {
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
 * Both come from one linear pass of the SPARQL lexical scanner. A comment counts
 * as whitespace, and the separator is the last token only when it is a `;` of
 * its own, so a `;` inside a string, an IRI, a comment or an escaped prefixed
 * name (`ex:a\;`) is never taken for it.
 */
export function withReadGraphOperationsAroundCallerUpdate(sparql: string, options: QueryOptions | undefined): string {
  if (!operationsOf(options)) return sparql;
  const { tokens, prologue } = prepareSparql(sparql);
  const start = prologue.endTokenIndex > 0 ? tokens[prologue.endTokenIndex - 1]!.end : 0;
  const last = tokens.length > prologue.endTokenIndex ? tokens[tokens.length - 1] : undefined;
  const operations = last?.kind === 'symbol' && last.logicalValue === ';'
    ? sparql.slice(start, last.start) + sparql.slice(last.end)
    : sparql.slice(start);
  const spliced = withReadGraphOperations(operations, options);
  return start > 0 ? `${sparql.slice(0, start)}\n${spliced}` : spliced;
}

/**
 * The graphs a write may change: the scope of its own update, and the read
 * graphs its plan maintains, which change in the same request. An unscoped
 * write stays unscoped.
 */
export function withReadGraphs(scope: GraphWriteScope, options: QueryOptions | undefined): GraphWriteScope {
  const plan = operationsOf(options);
  return plan && scope.kind === 'graphs' ? { kind: 'graphs', graphs: [...scope.graphs, ...plan.readGraphs] } : scope;
}

import type { QueryOptions } from '../triple-store.js';

/**
 * The read-graph operations of one write, sent in the write's own request.
 *
 * The read-graph layer hands an adapter, with each write that changes a member
 * graph, the SPARQL Update operations that keep its read graphs equal to the
 * union of their member graphs: some run before the data change and some
 * after it. The adapter sends them in the same request as the data change, so
 * the backend commits all of them or none. A write without operations sends
 * exactly the request it sent before read graphs existed.
 */
export interface ReadGraphWritePlan {
  /** The read graphs the plan maintains, in the order the layer locked them. */
  readonly readGraphs: readonly string[];
  /** Operations that must see the member graphs before the change. */
  readonly before: readonly string[];
  /** Operations that must see the member graphs after the change. */
  readonly after: readonly string[];
}

/** The options of a write that carries a plan. Only the read-graph layer sets `readGraphPlan`. */
export interface ReadGraphWriteOptions extends QueryOptions {
  readonly readGraphPlan?: ReadGraphWritePlan;
}

/** The write methods whose read-graph operations an adapter sends with the data change. */
export type ReadGraphPlannedMethod =
  | 'delete' | 'deleteByPattern' | 'deleteByPatternWithoutCount' | 'deleteBySubjectPrefix'
  | 'dropGraph' | 'replaceAssetGroup' | 'replaceGraph' | 'replaceGraphAndSubject'
  | 'replaceSubject' | 'replaceSubjectAndInsert' | 'rfc64AuthorCommitCasV1' | 'update';

/** What an adapter declares about read graphs. */
export interface ReadGraphAdapterCapabilities {
  /** The planned methods the adapter sends in one request with the data change. */
  readonly methods: readonly ReadGraphPlannedMethod[];
  /** Whether the engine runs update requests one at a time. */
  readonly serialUpdates: boolean;
}

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
  // A second separator after the update's own trailing one is a syntax error,
  // and a newline before each separator ends a trailing comment.
  return [...plan.before, update.replace(/\s*;\s*$/, ''), ...plan.after].join('\n;\n');
}

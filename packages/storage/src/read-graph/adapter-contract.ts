// SPDX-License-Identifier: Apache-2.0

/**
 * The contract between the read-graph layer and a store adapter.
 *
 * The layer is the innermost decorator, directly above the adapter, so it sees
 * every write with the terms as stored. For a write that touches a member graph
 * of a read graph it computes a {@link ReadGraphWritePlan}: the SPARQL UPDATE
 * operations to run before and after the caller's change. The adapter sends
 * them in the same request as the change, at the point where its own update
 * text is final, so the asset graphs and the read graphs change together or
 * not at all. The adapter keeps its own staging, cleanup and receipt handling.
 *
 * An `insert` never carries a plan: the layer adds the read-graph quads to the
 * same call, which is one request on every adapter. When the inserted quads
 * change membership (a registry fact in a `_meta` graph) and so need
 * operations, the layer sends that write as one `update` instead: the
 * `INSERT DATA` with its operations around it. Every other write that changes
 * triples carries a plan, and an adapter declares which of those methods it
 * can send in one request ({@link ReadGraphAdapterCapabilities}). The layer
 * never hands a plan to a method its adapter has not declared, and the daemon
 * refuses read graphs on a store whose adapter leaves any of them out
 * ({@link missingReadGraphMethods}).
 *
 * With no plan, or a plan with no operations, an adapter sends exactly the
 * request it sends today.
 */

import type { QueryOptions, TripleStore } from '../triple-store.js';

/** How a store with read graphs treats one method of {@link TripleStore}. */
export type ReadGraphMaintenance =
  /** Reads, capabilities and lifecycle: no triple changes. */
  | 'read'
  /** Changes no triple (`createGraph` makes an empty graph). */
  | 'none'
  /**
   * The same triples go into each read graph, in the same call. An insert that
   * changes membership is sent as an `update` with its operations instead.
   */
  | 'insert'
  /** After the delete, each deleted triple leaves a read graph unless another member still holds it. */
  | 'delete'
  /**
   * Before the delete, the matching triples leave a read graph unless a member
   * other than the target graph holds them. A pattern delete without a target
   * graph is refused on a store with read graphs.
   */
  | 'delete-matching'
  /** The reference procedure, over every member graph the request replaces or drops. */
  | 'reference'
  /** The reference procedure, restricted to the triples of the replaced subject. */
  | 'reference-subject'
  /**
   * The reference procedure for the replaced subject, plus a copy of each
   * companion subject's rows that the call adds to the same graph.
   */
  | 'reference-subject-and-insert'
  /**
   * The reference procedure, over the member graphs the caller declares. An
   * update without a declaration is refused unless it declares that it
   * touches no member graph.
   */
  | 'declared';

type MethodName<T> = { [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown ? K : never }[keyof T];

/** Every method of {@link TripleStore}. */
export type TripleStoreMethodName = MethodName<TripleStore>;

/**
 * The maintenance of every {@link TripleStore} method. The table is complete
 * by type: a method added to `TripleStore` without a row here fails to compile,
 * so no write can reach a store with read graphs unplanned.
 */
export const READ_GRAPH_METHOD_MAINTENANCE = Object.freeze({
  withQueryReadAdmission: 'read',
  // A logical mutation is a span; the writes inside it go through the methods below.
  runLogicalMutation: 'read',
  getPressureSnapshot: 'read',
  insert: 'insert',
  delete: 'delete',
  deleteByPattern: 'delete-matching',
  deleteByPatternWithoutCount: 'delete-matching',
  // A SPARQL UPDATE sent through `query` is refused on a store with read graphs; `update` declares its graphs.
  query: 'read',
  rfc64ExactBindingsReadV1: 'read',
  rfc64SemanticReadV1: 'read',
  rfc64SharedProjectionStreamV1: 'read',
  hasGraph: 'read',
  createGraph: 'none',
  dropGraph: 'reference',
  replaceGraph: 'reference',
  replaceAssetGroup: 'reference',
  replaceGraphAndSubject: 'reference',
  replaceSubject: 'reference-subject',
  replaceSubjectAndInsert: 'reference-subject-and-insert',
  rfc64AuthorCommitCasV1: 'reference',
  graphEnumerationVisibility: 'read',
  listGraphs: 'read',
  readGraphInventory: 'read',
  listGraphsByPrefix: 'read',
  deleteBySubjectPrefix: 'delete-matching',
  update: 'declared',
  countQuads: 'read',
  flush: 'read',
  close: 'read',
} as const satisfies Record<TripleStoreMethodName, ReadGraphMaintenance>);

type MethodsCarryingPlans<T extends Record<string, ReadGraphMaintenance>> = {
  [K in keyof T]: T[K] extends 'read' | 'none' | 'insert' ? never : K;
}[keyof T];

/** The write methods whose adapter sends a {@link ReadGraphWritePlan} in the request that changes the data. */
export type ReadGraphPlannedMethod = MethodsCarryingPlans<typeof READ_GRAPH_METHOD_MAINTENANCE>;

/** Every method in {@link ReadGraphPlannedMethod}, in a fixed order. */
export const READ_GRAPH_PLANNED_METHODS: readonly ReadGraphPlannedMethod[] = Object.freeze(
  (Object.keys(READ_GRAPH_METHOD_MAINTENANCE) as TripleStoreMethodName[])
    .filter((method): method is ReadGraphPlannedMethod => !['read', 'none', 'insert'].includes(READ_GRAPH_METHOD_MAINTENANCE[method]))
    .sort(),
);

/**
 * What the layer hands an adapter for one write. The adapter sends, in one
 * request: every `before` operation in order, then its own operations for the
 * change, then every `after` operation in order, as {@link spliceReadGraphPlan}
 * joins them. Operations are complete SPARQL UPDATE operations without a
 * trailing `;`, with absolute IRIs only (no prefixed names, no relative IRIs),
 * and refer to terms only as stored. A plan with no operations is not handed
 * over.
 */
export interface ReadGraphWritePlan {
  /** The read graphs the plan maintains, in the order the layer locked them. */
  readonly readGraphs: readonly string[];
  /** Operations that must see the member graphs before the change, such as a retraction that reads old contents. */
  readonly before: readonly string[];
  /** Operations that must see the member graphs after the change, such as a copy of new contents. */
  readonly after: readonly string[];
}

/**
 * The options a planned method receives from the layer: the caller's options
 * plus the plan. Only the layer sets `readGraphPlan`, on a fresh options
 * object for each call; an adapter that has not declared the method never
 * receives one.
 */
export interface ReadGraphWriteOptions extends QueryOptions {
  readonly readGraphPlan?: ReadGraphWritePlan;
}

/** What an adapter declares about read graphs. */
export interface ReadGraphAdapterCapabilities {
  /** The planned methods this adapter sends in one request with the data change. */
  readonly methods: readonly ReadGraphPlannedMethod[];
  /**
   * Whether the engine runs update requests one at a time. When it does, a
   * request whose response was lost cannot interleave with a later one; when
   * it does not, the layer marks the read graphs of such a write dirty.
   */
  readonly serialUpdates: boolean;
  /**
   * Whether the adapter sends, in one request like any other delete, a planned
   * `delete` whose quads include a blank node and a planned `deleteByPattern`
   * whose pattern holds one. Absent means it does. `false` means it refuses
   * those plans before anything changes, because its engine deletes a stored
   * blank node by identity and SPARQL can name one only by shape; a delete
   * without a plan keeps its exact semantics, so the layer marks the affected
   * read graphs dirty and sends the delete without one.
   */
  readonly plansBlankNodeDeletes?: boolean;
}

/** An adapter that declares its read-graph capabilities. */
export interface ReadGraphCapableAdapter {
  readonly readGraphCapabilities: ReadGraphAdapterCapabilities;
}

/** The declared capabilities of a store object, or `undefined` when it declares none. */
export function readGraphCapabilitiesOf(store: unknown): ReadGraphAdapterCapabilities | undefined {
  if (typeof store !== 'object' || store === null || !('readGraphCapabilities' in store)) return undefined;
  const capabilities = (store as Partial<ReadGraphCapableAdapter>).readGraphCapabilities;
  return typeof capabilities === 'object' && capabilities !== null ? capabilities : undefined;
}

/**
 * The planned methods an adapter leaves out, among those the store object
 * implements. Read graphs may be built on a store only when this is empty.
 */
export function missingReadGraphMethods(
  store: Partial<Record<TripleStoreMethodName, unknown>>,
  capabilities: ReadGraphAdapterCapabilities | undefined,
): ReadGraphPlannedMethod[] {
  const declared = new Set<string>(capabilities?.methods ?? []);
  return READ_GRAPH_PLANNED_METHODS.filter((method) => typeof store[method] === 'function' && !declared.has(method));
}

/**
 * The text of one request: the plan's `before` operations, the adapter's own
 * operations, then the plan's `after` operations, each on its own lines and
 * separated by `;` on a line of its own, so a `#` comment at the end of the
 * caller's text cannot swallow the separator. Pass the adapter's own text as
 * one element without a trailing `;`: with no plan, or a plan with no
 * operations, it comes back unchanged. A plan operation that ends with `;` is
 * refused.
 */
export function spliceReadGraphPlan(plan: ReadGraphWritePlan | undefined, operations: readonly string[]): string {
  for (const operation of [...(plan?.before ?? []), ...(plan?.after ?? [])]) {
    if (/;\s*$/.test(operation)) throw new Error('A read-graph plan operation must not end with ";"');
  }
  return [...(plan?.before ?? []), ...operations, ...(plan?.after ?? [])].join('\n;\n');
}

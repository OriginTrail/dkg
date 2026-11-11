// SPDX-License-Identifier: Apache-2.0
import {
  MemoryLayer, SEMANTICS_UNSUPPORTED_CODE, TrustLevel, VIEW_NOT_READY_CODE, VIEW_QUERY_SEMANTICS,
  isReadGraphEligibleContextGraphId, readGraphIri, readScope,
  type GetView, type ReadGraphKey, type ViewQuerySemantics,
} from '@origintrail-official/dkg-core';
import {
  CURRENT_READ_GRAPH_VERSIONS, servingReadGraphGeneration,
  type ReadGraphStateRow, type ReadGraphVersions, type WorkingMemoryIdentityRule,
} from '@origintrail-official/dkg-storage';
import type { QueryOptions } from './query-engine.js';
import { ScopedQueryViolationError } from './scoped-query-error.js';
import { withDatasetClauses } from './sparql-graph-dataset.js';
import type { PreparedGraphScope } from './sparql-graph-scope.js';
import { transitionGraphScope } from './sparql-query-transition.js';

/** The read graphs a node keeps, as merged view queries see them. */
export interface ViewReadGraphs {
  /** Whether the node keeps this read graph: read graphs are on for its context graph and layer. */
  keeps(key: ReadGraphKey): boolean;
  /** The state row of a read graph in the node's process-wide copy, or `undefined` while it has none. */
  state(readGraph: string): ReadGraphStateRow | undefined;
  /** Which agent owns the drafts written under a working-memory address. */
  readonly identity: WorkingMemoryIdentityRule;
  /** What a view query without `semantics` gets on a context graph; `per-asset` when absent. */
  defaultSemantics?(contextGraphId: string): ViewQuerySemantics;
  /** The read-graph versions this release serves; the current ones when absent. */
  readonly versions?: ReadGraphVersions;
}

/** A view query's plan: today's per-asset route, or one read graph at the generation it was planned with. */
export type ViewDatasetPlan =
  | { readonly kind: 'per-asset' }
  | MergedViewDatasetPlan;

export interface MergedViewDatasetPlan {
  readonly kind: 'merged';
  readonly readGraph: string;
  readonly generation: number;
}

export const VIEW_NOT_READY_RETRY_AFTER_SECONDS = 10;

/** A merged view query whose read graph is being built or repaired, or changed twice while it ran. */
export class ViewNotReadyError extends Error {
  readonly code = VIEW_NOT_READY_CODE;
  readonly retryable = true;
  readonly retryAfterSeconds = VIEW_NOT_READY_RETRY_AFTER_SECONDS;
  readonly hint = 'Retry after the Retry-After interval, or ask for semantics "per-asset".';

  constructor() {
    super('The view is not ready for a merged query');
    this.name = 'ViewNotReadyError';
  }
}

/** `semantics: "merged"` asked for where it does not apply. */
export class SemanticsUnsupportedError extends Error {
  readonly code = SEMANTICS_UNSUPPORTED_CODE;
  readonly hint = 'Drop the semantics option, or ask for "per-asset".';

  constructor(what: string) {
    super(`semantics "merged" does not apply to ${what}`);
    this.name = 'SemanticsUnsupportedError';
  }
}

/** The semantics a request asked for, checked; `undefined` when it asked for none. */
export function requestedViewSemantics(options: QueryOptions | undefined): ViewQuerySemantics | undefined {
  const requested: unknown = options?.semantics;
  if (requested === undefined) return undefined;
  if (!(VIEW_QUERY_SEMANTICS as readonly unknown[]).includes(requested)) {
    throw new ScopedQueryViolationError(`Invalid semantics ${JSON.stringify(requested)}: expected "merged" or "per-asset"`);
  }
  return requested as ViewQuerySemantics;
}

/** A query without a view is matched per asset or reads the whole store; `merged` needs a view. */
export function assertNoMergedSemanticsWithoutView(options: QueryOptions | undefined): void {
  if (requestedViewSemantics(options) === 'merged') throw new SemanticsUnsupportedError('a query without a view');
}

const SHARED_LAYERS = {
  'shared-working-memory': MemoryLayer.SharedWorkingMemory,
  'verifiable-memory': MemoryLayer.VerifiableMemory,
} as const;

/**
 * Plan a view query, after the caller's authority was decided:
 * - the semantics it asked for, or else the node's default for the context graph, or `per-asset`;
 * - `merged` does not apply to a working-memory read by assertion name, a `verifiedGraph`
 *   read, `minTrust` above SelfAttested, `includePrivate`, `graphSuffix` or
 *   `includeSharedMemory`, nor to a scope this node keeps no read graph for. Asked for there,
 *   it is refused with {@link SemanticsUnsupportedError}; by default, the query is per asset;
 * - a merged plan names the scope's read graph and the generation it is ready at. A read
 *   graph that is not ready is answered with {@link ViewNotReadyError}.
 */
export function planViewDataset(
  view: GetView,
  contextGraphId: string,
  options: QueryOptions,
  readGraphs: ViewReadGraphs | undefined,
): ViewDatasetPlan {
  const requested = requestedViewSemantics(options);
  const semantics = requested ?? readGraphs?.defaultSemantics?.(contextGraphId) ?? 'per-asset';
  if (semantics === 'per-asset') return { kind: 'per-asset' };
  const target = mergedReadGraph(view, contextGraphId, options, readGraphs);
  if (target.kind === 'unsupported') {
    if (requested === 'merged') throw new SemanticsUnsupportedError(target.what);
    return { kind: 'per-asset' };
  }
  const generation = servingGeneration(target.readGraphs, target.readGraph);
  if (generation === undefined) throw new ViewNotReadyError();
  return { kind: 'merged', readGraph: target.readGraph, generation };
}

/** Whether a merged query's read graph is still ready at the generation it was planned with. */
export function isViewDatasetPlanCurrent(plan: MergedViewDatasetPlan, readGraphs: ViewReadGraphs): boolean {
  return servingGeneration(readGraphs, plan.readGraph) === plan.generation;
}

/**
 * A merged query with its dataset: the read graph as its default graph, and the given named
 * graphs, the authorized graphs of its GRAPH portions, as its named graphs.
 */
export function withMergedViewDataset(
  scope: PreparedGraphScope, readGraph: string, namedGraphs: readonly string[],
): PreparedGraphScope {
  const placed = (current: PreparedGraphScope, graphs: readonly string[], keyword: 'FROM' | 'FROM NAMED') => {
    const source = withDatasetClauses(current, graphs, keyword);
    if (source === null) throw new ScopedQueryViolationError('This query has no place for a dataset');
    return transitionGraphScope(current, source);
  };
  const withDefault = placed(scope, [readGraph], 'FROM');
  return namedGraphs.length ? placed(withDefault, namedGraphs, 'FROM NAMED') : withDefault;
}

function servingGeneration(readGraphs: ViewReadGraphs, readGraph: string): number | undefined {
  return servingReadGraphGeneration(readGraphs.state(readGraph), readGraphs.versions ?? CURRENT_READ_GRAPH_VERSIONS);
}

type MergedTarget =
  | { readonly kind: 'read-graph'; readonly readGraph: string; readonly readGraphs: ViewReadGraphs }
  | { readonly kind: 'unsupported'; readonly what: string };

/** The read graph a merged view query reads, or what merged does not apply to. */
function mergedReadGraph(
  view: GetView, contextGraphId: string, options: QueryOptions, readGraphs: ViewReadGraphs | undefined,
): MergedTarget {
  const unsupported = (what: string): MergedTarget => ({ kind: 'unsupported', what });
  if (view === 'working-memory' && options.assertionName) return unsupported('a working-memory read by assertion name');
  if (options.verifiedGraph) return unsupported('a read of one verified graph');
  const minTrust = options.minTrust ?? options._minTrust;
  if (view === 'verifiable-memory' && minTrust !== undefined && minTrust > TrustLevel.SelfAttested) {
    return unsupported('minTrust above SelfAttested');
  }
  if (options.includePrivate) return unsupported('includePrivate');
  if (options.graphSuffix || options.includeSharedMemory || options.includeWorkspace) {
    return unsupported('graphSuffix or includeSharedMemory');
  }
  const noReadGraph = unsupported('this scope on this node');
  if (!readGraphs || !isReadGraphEligibleContextGraphId(contextGraphId)) return noReadGraph;
  const scope = readScope(contextGraphId, options.subGraphName);
  let key: ReadGraphKey;
  if (view === 'working-memory') {
    const owner = options.agentAddress === undefined ? undefined : readGraphs.identity.ownerOf(options.agentAddress);
    if (owner === undefined) return noReadGraph;
    key = { scope, layer: MemoryLayer.WorkingMemory, agentAddress: owner };
  } else {
    key = { scope, layer: SHARED_LAYERS[view] };
  }
  if (!readGraphs.keeps(key)) return noReadGraph;
  try {
    return { kind: 'read-graph', readGraph: readGraphIri(key), readGraphs };
  } catch {
    return noReadGraph;
  }
}

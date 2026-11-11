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
  /**
   * Whether requests are answered from this kept read graph; every kept one is when absent.
   * One that is kept but not served still answers the semantic-delta sampler.
   */
  serves?(key: ReadGraphKey): boolean;
  /** The state row of a read graph in the node's process-wide copy, or `undefined` while it has none. */
  state(readGraph: string): ReadGraphStateRow | undefined;
  /** Which agent owns the drafts written under a working-memory address. */
  readonly identity: WorkingMemoryIdentityRule;
  /** What a view query without `semantics` gets on a context graph; `per-asset` when absent. */
  defaultSemantics?(contextGraphId: string): ViewQuerySemantics;
  /** The read-graph versions this release serves; the current ones when absent. */
  readonly versions?: ReadGraphVersions;
  /** Runs work under a read graph's write lock, so no write lands in it meanwhile. */
  withWriteLock?<T>(readGraph: string, work: () => Promise<T>): Promise<T>;
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

const TRUST_LEVELS: readonly unknown[] = [
  TrustLevel.SelfAttested, TrustLevel.Endorsed, TrustLevel.PartiallyVerified, TrustLevel.ConsensusVerified,
];

/**
 * A verifiable-memory `minTrust` must be one of the TrustLevel values. "minTrust" and "must be
 * one of" match the daemon's 400 wording, so the HTTP path maps the refusal to a client error.
 */
export function assertValidViewMinTrust(minTrust: unknown): void {
  if (minTrust === undefined || (typeof minTrust === 'number' && Number.isInteger(minTrust) && TRUST_LEVELS.includes(minTrust))) return;
  throw new Error(
    `Invalid minTrust ${JSON.stringify(minTrust)}: must be one of TrustLevel.SelfAttested (0), ` +
    `Endorsed (1), PartiallyVerified (2), ConsensusVerified (3). The HTTP /api/query route ` +
    `accepts the string forms "SelfAttested" | "Endorsed" | "PartiallyVerified" | ` +
    `"ConsensusVerified" and normalises them; in-process callers must pass the numeric enum.`,
  );
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
 *   `includeSharedMemory`, nor to a scope this node keeps or serves no read graph for. Asked for there,
 *   it is refused with {@link SemanticsUnsupportedError}; by default, the query is per asset;
 * - a merged plan names the scope's read graph and the generation it is ready at. A read
 *   graph that is not ready is answered with {@link ViewNotReadyError}; by default, one
 *   without a state row is answered per asset.
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
  const target = mergedReadGraph(view, contextGraphId, options, readGraphs, 'request');
  if (target.kind === 'unsupported') {
    if (requested === 'merged') throw new SemanticsUnsupportedError(target.what);
    return { kind: 'per-asset' };
  }
  const row = target.readGraphs.state(target.readGraph);
  // A default does not send a query to a read graph the node holds no state for, as for a
  // context graph it holds nothing of: that query is answered per asset.
  if (row === undefined && requested === undefined) return { kind: 'per-asset' };
  const generation = servingReadGraphGeneration(row, target.readGraphs.versions ?? CURRENT_READ_GRAPH_VERSIONS);
  if (generation === undefined) throw new ViewNotReadyError();
  return { kind: 'merged', readGraph: target.readGraph, generation };
}

/**
 * The merged plan a sample of a view query is measured with, whatever semantics the query asked
 * for, also where requests are not answered merged yet: `undefined` where merged does not apply
 * or the read graph is not ready. It never throws.
 */
export function mergedViewDatasetPlan(
  view: GetView, contextGraphId: string, options: QueryOptions, readGraphs: ViewReadGraphs | undefined,
): MergedViewDatasetPlan | undefined {
  try {
    const target = mergedReadGraph(view, contextGraphId, options, readGraphs, 'sample');
    if (target.kind === 'unsupported') return undefined;
    const generation = servingGeneration(target.readGraphs, target.readGraph);
    return generation === undefined ? undefined : { kind: 'merged', readGraph: target.readGraph, generation };
  } catch {
    return undefined;
  }
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

/** The read graph a merged view query reads, for a request or for a sample, or what merged does not apply to. */
function mergedReadGraph(
  view: GetView, contextGraphId: string, options: QueryOptions, readGraphs: ViewReadGraphs | undefined,
  use: 'request' | 'sample',
): MergedTarget {
  const unsupported = (what: string): MergedTarget => ({ kind: 'unsupported', what });
  if (view === 'working-memory' && options.assertionName) return unsupported('a working-memory read by assertion name');
  if (options.verifiedGraph) return unsupported('a read of one verified graph');
  const minTrust = options.minTrust ?? options._minTrust;
  if (view === 'verifiable-memory') assertValidViewMinTrust(minTrust);
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
  if (!readGraphs.keeps(key) || (use === 'request' && readGraphs.serves?.(key) === false)) return noReadGraph;
  try {
    return { kind: 'read-graph', readGraph: readGraphIri(key), readGraphs };
  } catch {
    return noReadGraph;
  }
}

// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import { getMetrics, TrustLevel } from '@origintrail-official/dkg-core';
import type { QueryOptions } from './query-engine.js';
import type { QueryReadPlan } from './query-read-plan.js';
import type { PreparedGraphScope } from './sparql-graph-scope.js';

/**
 * Candidate limits on the number of graphs one query routes per asset. A query
 * over a candidate is counted once for each candidate it exceeds; none is refused.
 */
export const QUERY_SCOPE_LIMIT_CANDIDATES: readonly number[] = [1_000, 2_000, 5_000, 10_000, 20_000];
const SLICE_CLASS_BOUNDS: readonly number[] = [100, ...QUERY_SCOPE_LIMIT_CANDIDATES];

const VIEW_LABELS: ReadonlyMap<string, string> = new Map([
  ['working-memory', 'wm'],
  ['shared-working-memory', 'swm'],
  ['verifiable-memory', 'vm'],
]);

/**
 * The labels of one query: its route and the classes it falls in. Each has a
 * few fixed values; none carries a graph or context-graph name.
 */
export interface QueryScopeClass {
  readonly route: 'view' | 'legacy' | 'unscoped';
  readonly view: string;
  readonly graph: 'none' | 'variable' | 'explicit';
  readonly min_trust: 'true' | 'false';
  readonly private: 'true' | 'false';
}

export function classifyQueryScope(
  scope: PreparedGraphScope,
  plan: QueryReadPlan,
  options: QueryOptions | undefined,
): QueryScopeClass {
  const route = plan.kind === 'scoped' ? 'legacy' : plan.kind;
  const view = plan.kind === 'view' ? VIEW_LABELS.get(plan.options.view) ?? 'other' : 'none';
  const explicitOnly = scope.graphTargets.length > 0 && scope.graphTargets.every(target => target.kind === 'iri');
  const minTrust = options?.minTrust ?? options?._minTrust;
  return {
    route,
    view,
    graph: !scope.hasGraphClause ? 'none' : explicitOnly ? 'explicit' : 'variable',
    // The trust rewrite runs only on verifiable memory, and only above the floor.
    min_trust: view === 'vm' && typeof minTrust === 'number' && minTrust > TrustLevel.SelfAttested ? 'true' : 'false',
    // Only the legacy route reads private partitions.
    private: route === 'legacy' && options?.includePrivate === true ? 'true' : 'false',
  };
}

/** The class of a slice for store time: the smallest bound it fits under. */
export function sliceClass(graphs: number): string {
  const bound = SLICE_CLASS_BOUNDS.find(limit => graphs <= limit);
  return bound === undefined ? `gt_${SLICE_CLASS_BOUNDS[SLICE_CLASS_BOUNDS.length - 1]}` : `le_${bound}`;
}

/**
 * One query's meter. The engine classifies the query once its read plan is
 * known, its route reports each graph list it routes the query over (the
 * slice), and each read of the caller's query is timed. When the answer
 * settles, a classified query is counted by route and class, and a routed one
 * records its slice size, its store time by slice size, and each candidate
 * limit it exceeds. A query rejected before its plan is not counted.
 *
 * The slice is the set the route authorizes the query for and binds it to, as
 * VALUES, UNION branches or a dataset. The `graph` label keeps reads of
 * explicit graphs apart in every series.
 *
 * The meter lives in the query's async context ({@link meterQueryScope}), the
 * way the default store-work priority does, so the engine's route functions
 * report to it without taking it as a parameter. A report after the answer
 * settled, from work the query left running, is ignored.
 */
class QueryScopeMeter {
  private scopeClass: QueryScopeClass | undefined;
  private readonly slices: (readonly string[])[] = [];
  private storeMs = 0;
  private storeReads = 0;
  private settled = false;

  classify(scopeClass: QueryScopeClass): void {
    if (!this.settled) this.scopeClass = scopeClass;
  }

  route(graphs: readonly string[]): void {
    if (!this.settled) this.slices.push(graphs);
  }

  startRead(): () => void {
    const startedAt = performance.now();
    return () => {
      if (this.settled) return;
      this.storeMs += performance.now() - startedAt;
      this.storeReads += 1;
    };
  }

  record(): void {
    if (this.settled) return;
    this.settled = true;
    if (!this.scopeClass) return;
    try {
      const metrics = getMetrics();
      const { route, graph } = this.scopeClass;
      metrics.queryScopeRequestsTotal.add(1, { ...this.scopeClass });
      if (route === 'unscoped' || this.slices.length === 0) return;
      const lists = new Set(this.slices);
      const graphs = lists.size === 1 ? this.slices[0]!.length : new Set(this.slices.flat()).size;
      metrics.queryScopeSliceGraphs.record(graphs, { route, graph });
      if (this.storeReads > 0) {
        metrics.queryScopeStoreMs.record(this.storeMs, { route, graph, slice: sliceClass(graphs) });
      }
      for (const limit of QUERY_SCOPE_LIMIT_CANDIDATES) {
        if (graphs > limit) metrics.queryScopeOverLimitTotal.add(1, { route, graph, limit: String(limit) });
      }
    } catch {
      // Telemetry must never change a query's answer.
    }
  }
}

const runningMeters = new AsyncLocalStorage<QueryScopeMeter>();

/**
 * Run one query with its own meter in its async context, and record the meter
 * when the answer settles, whatever the outcome. A query run inside another
 * gets a meter of its own.
 */
export function meterQueryScope<T>(run: () => Promise<T>): Promise<T> {
  const meter = new QueryScopeMeter();
  return runningMeters.run(meter, run).finally(() => meter.record());
}

/** Classify the running query, once its read plan is known. */
export function classifyMeteredQuery(scope: PreparedGraphScope, plan: QueryReadPlan, options: QueryOptions | undefined): void {
  runningMeters.getStore()?.classify(classifyQueryScope(scope, plan, options));
}

/** A graph list the running query is routed over, one asset graph at a time. */
export function reportRoutedGraphs(graphs: readonly string[]): void {
  runningMeters.getStore()?.route(graphs);
}

/** Start timing one store read of the running query's caller query; call the result when the read ends. */
export function startRoutedRead(): (() => void) | undefined {
  return runningMeters.getStore()?.startRead();
}

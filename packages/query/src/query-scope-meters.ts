// SPDX-License-Identifier: Apache-2.0
import { getMetrics, TrustLevel } from '@origintrail-official/dkg-core';
import type { QueryOptions } from './query-engine.js';
import type { QueryReadPlan } from './query-read-plan.js';
import type { StoreReadLane } from './query-store-read-context.js';
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
 * One query's meter. Its route reports each graph list it routes the query
 * over (the slice), and the caller's reads are timed. When the answer settles,
 * the query is counted by route and class, and a routed query records its
 * slice size, its store time by slice size, and each candidate limit it exceeds.
 */
export class QueryScopeMeter {
  private readonly slices: (readonly string[])[] = [];
  private storeMs = 0;
  private storeReads = 0;

  constructor(private readonly scopeClass: QueryScopeClass) {}

  /** A lane whose `query` runs the caller's query; its reads are timed. */
  observe<T extends StoreReadLane>(reads: T): T {
    return {
      ...reads,
      query: async (sparql: string) => {
        const startedAt = performance.now();
        try {
          return await reads.query(sparql);
        } finally {
          this.storeMs += performance.now() - startedAt;
          this.storeReads += 1;
        }
      },
    };
  }

  /** A graph list the query is routed over, one asset graph at a time. */
  route(graphs: readonly string[]): void {
    this.slices.push(graphs);
  }

  /** Records the query once its answer settles, whatever the outcome. */
  settle<T>(answer: Promise<T>): Promise<T> {
    return answer.finally(() => this.record());
  }

  private record(): void {
    try {
      const metrics = getMetrics();
      const { route, graph } = this.scopeClass;
      metrics.queryScopeRequestsTotal.add(1, { ...this.scopeClass });
      if (route === 'unscoped' || this.slices.length === 0) return;
      const lists = new Set(this.slices);
      const graphs = lists.size === 1 ? this.slices[0]!.length : new Set(this.slices.flat()).size;
      metrics.queryScopeSliceGraphs.record(graphs, { route, graph });
      if (this.storeReads > 0) {
        metrics.queryScopeStoreMs.record(this.storeMs, { route, slice: sliceClass(graphs) });
      }
      for (const limit of QUERY_SCOPE_LIMIT_CANDIDATES) {
        if (graphs > limit) metrics.queryScopeOverLimitTotal.add(1, { route, graph, limit: String(limit) });
      }
    } catch {
      // Telemetry must never change a query's answer.
    }
  }
}

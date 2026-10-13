import type { QueryOptions } from './query-engine.js';
import type { PreparedGraphScope } from './sparql-graph-scope.js';
import { staticScopedRouteGraphs } from './static-scoped-route-graphs.js';

type ScopedRoute = ReturnType<typeof staticScopedRouteGraphs>;
export type QueryReadPlan = { kind: 'unscoped' | 'view' } | {
  kind: 'scoped'; contextGraphId: string; graphs: ScopedRoute;
  needsDiscovery: boolean; expandGraphVariables: boolean;
  swmRouted: boolean; dataRouted: boolean;
  discovery: 'admission-owned' | 'shared';
};

/** Resolve route policy once; execution and admission consume the same decision. */
export function resolveQueryReadPlan(scope: PreparedGraphScope, options: QueryOptions | undefined,
  supportsCompleteAdmission: boolean): QueryReadPlan {
  if (!options?.contextGraphId || options.view) return { kind: options?.view ? 'view' : 'unscoped' };
  const graphs = staticScopedRouteGraphs(options.contextGraphId, options);
  const allowed = [...graphs.staticContentGraphs, ...graphs.metaAllowList, ...graphs.staticPrivateAllowList];
  const needsDiscovery = !scope.hasGraphClause
    || scope.graphTargets.some(target => target.kind !== 'iri' || !allowed.includes(target.iri));
  const expandGraphVariables = options.includeContextGraphPartitions === true
    && scope.graphVariables.length > 0 && !graphs.isSwmOnlyRoute;
  return { kind: 'scoped', contextGraphId: options.contextGraphId, graphs, needsDiscovery, expandGraphVariables,
    swmRouted: Boolean((options.includeSharedMemory ?? options.includeWorkspace) || graphs.isSwmOnlyRoute),
    dataRouted: !graphs.isSwmOnlyRoute,
    // Other routes can depend on a decorator refresh queued behind an owned slot.
    discovery: supportsCompleteAdmission && expandGraphVariables && !options.includePrivate
      ? 'admission-owned' : 'shared',
  };
}

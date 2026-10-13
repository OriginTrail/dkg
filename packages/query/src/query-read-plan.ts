import type { QueryOptions } from './query-engine.js';
import type { PreparedGraphScope } from './sparql-graph-scope.js';
import { staticScopedRouteGraphs } from './static-scoped-route-graphs.js';

type ScopedRoute = ReturnType<typeof staticScopedRouteGraphs>;
export type QueryReadPlan = { kind: 'unscoped' | 'view' } | {
  kind: 'scoped'; contextGraphId: string; graphs: ScopedRoute;
  targets: readonly { root: string; family: 'data' | 'shared-memory' }[];
  discovery: {
    mode: 'admission-owned' | 'shared'; expandGraphVariables: boolean;
    contentPrefixes: readonly { root: string; prefix: string }[];
    privatePartitions: boolean;
  };
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
  const targets = graphs.staticContentGraphs.map(root => ({ root,
    family: root === graphs.dataGraph ? 'data' as const : 'shared-memory' as const }));
  // Authorization discovery has narrower precedence than combined execution:
  // an explicit SWM suffix never admits VM partitions or root metadata.
  const contentPrefixes = needsDiscovery ? targets
    .filter(target => target.family !== 'data' || !graphs.isSwmOnlyRoute)
    .map(({ root, family }) => ({ root, prefix: `${root}/${family === 'data' ? '_verifiable_memory/' : ''}` })) : [];
  return { kind: 'scoped', contextGraphId: options.contextGraphId, graphs, targets,
    discovery: { expandGraphVariables, contentPrefixes, privatePartitions: !!options.includePrivate && needsDiscovery,
      // Other routes can depend on a decorator refresh queued behind an owned slot.
      mode: supportsCompleteAdmission && expandGraphVariables && !options.includePrivate
        ? 'admission-owned' : 'shared',
    },
  };
}

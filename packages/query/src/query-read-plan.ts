import type { QueryReadAdmissionCapability } from '@origintrail-official/dkg-storage';
import { resolveDraftAccessPolicy, type DraftAccessPolicy } from './content-partition-policy.js';
import type { QueryOptions } from './query-engine.js';
import { assertExactGraphRead, type PreparedGraphScope } from './sparql-graph-scope.js';
import { scopedPartitionPolicyFromRoute } from './scoped-content-graph-policy.js';
import { staticScopedRouteGraphs } from './static-scoped-route-graphs.js';

type ScopedRoute = ReturnType<typeof staticScopedRouteGraphs>;
export type QueryReadPlan = { kind: 'unscoped' } | {
  kind: 'view'; options: QueryOptions & { contextGraphId: string; view: NonNullable<QueryOptions['view']> };
} | {
  kind: 'scoped'; contextGraphId: string; graphs: Omit<ScopedRoute, 'execution'>;
  execution: ScopedRoute['execution']; draftAccess: DraftAccessPolicy; includeSharedMemoryMeta: boolean;
  fallbackPolicy: 'compatibility' | 'preserve-scope'; excludedGraphPrefixes: readonly string[];
  discovery: {
    catalog: { kind: 'none' | 'shared' }
      | { kind: 'admission-owned'; owner: QueryReadAdmissionCapability }
      | { kind: 'exact'; candidates: readonly string[]; policy: ReturnType<typeof scopedPartitionPolicyFromRoute> };
    contentPrefixes: readonly { root: string; prefix: string }[];
    privatePartitions: boolean;
  };
};

/** Resolve route policy once; execution and admission consume the same decision. */
export function resolveQueryReadPlan(scope: PreparedGraphScope, options: QueryOptions | undefined,
  completeAdmissionOwner: QueryReadAdmissionCapability | null): QueryReadPlan {
  if (options?.exactContextGraphPartitions && (!options.contextGraphId || options.view
    || options.includeContextGraphPartitions !== true || scope.graphVariables.length > 0))
    throw new Error('Exact context-graph reads require a scoped, concrete GRAPH query with partition access');
  if (options?.view) {
    if (!options.contextGraphId) throw new Error(`view '${options.view}' requires a contextGraphId to scope the query`);
    return { kind: 'view', options: { ...options, contextGraphId: options.contextGraphId, view: options.view } };
  }
  if (!options?.contextGraphId) return { kind: 'unscoped' };
  const { execution, ...graphs } = staticScopedRouteGraphs(options.contextGraphId, options);
  const draftAccess = resolveDraftAccessPolicy(options);
  const exact = options.exactContextGraphPartitions === true;
  if (exact) {
    assertExactGraphRead(scope);
    if (options.includePrivate) throw new Error('Exact partition reads only admit public graphs');
  }
  const allowed = [...graphs.staticContentGraphs, ...graphs.metaAllowList, ...graphs.staticPrivateAllowList];
  const needsDiscovery = !scope.hasGraphClause
    || scope.graphTargets.some(target => target.kind !== 'iri' || !allowed.includes(target.iri));
  const expandGraphVariables = options.includeContextGraphPartitions === true
    && scope.graphVariables.length > 0 && !graphs.isSwmOnlyRoute;
  const targets = execution.kind === 'combined' ? [execution.data, execution.sharedMemory] : [execution.target];
  // Authorization discovery has narrower precedence than combined execution:
  // an explicit SWM suffix never admits VM partitions or root metadata.
  const contentPrefixes = needsDiscovery ? targets
    .filter(target => target.family !== 'data' || !graphs.isSwmOnlyRoute)
    .map(({ root, family }) => ({ root, prefix: `${root}/${family === 'data' ? '_verifiable_memory/' : ''}` })) : [];
  return { kind: 'scoped', contextGraphId: options.contextGraphId, graphs, execution,
    draftAccess, includeSharedMemoryMeta: options.includeSharedMemoryMeta === true,
    fallbackPolicy: options.requireCompleteGraphScope ? 'preserve-scope' : 'compatibility',
    excludedGraphPrefixes: [...(options.excludeGraphPrefixes ?? [])],
    discovery: { contentPrefixes, privatePartitions: !!options.includePrivate && needsDiscovery,
      // Complete dynamic routes use the catalog inventory for prefix reads;
      // private discovery adds metadata queries within the same owned admission.
      catalog: exact ? { kind: 'exact', candidates: scope.graphTargets.flatMap(target => target.kind === 'iri' ? [target.iri] : []),
        policy: scopedPartitionPolicyFromRoute(options.contextGraphId, { ...graphs, execution }, draftAccess, options.includeSharedMemoryMeta === true) }
        : !expandGraphVariables ? { kind: 'none' }
        : completeAdmissionOwner
          ? { kind: 'admission-owned', owner: completeAdmissionOwner } : { kind: 'shared' },
    },
  };
}

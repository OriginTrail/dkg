import type { QueryReadAdmissionCapability } from '@origintrail-official/dkg-storage';
import type { QueryOptions } from './query-engine.js';
import { type PreparedGraphScope } from './sparql-graph-scope.js';
import { createScopedContentGraphRoutePolicy, scopedRouteContentPrefixes } from './scoped-content-graph-policy.js';

export type QueryReadPlan = { kind: 'unscoped' } | {
  kind: 'view'; options: QueryOptions & { contextGraphId: string; view: NonNullable<QueryOptions['view']> };
} | {
  kind: 'scoped'; policy: ReturnType<typeof createScopedContentGraphRoutePolicy>;
  fallbackPolicy: 'compatibility' | 'preserve-scope'; excludedGraphPrefixes: readonly string[];
  discovery: {
    catalog: { kind: 'none' | 'shared' }
      | { kind: 'admission-owned'; owner: QueryReadAdmissionCapability };
    contentPrefixes: readonly { root: string; prefix: string }[];
    privatePartitions: boolean;
  };
};

/** Resolve route policy once; execution and admission consume the same decision. */
export function resolveQueryReadPlan(scope: PreparedGraphScope, options: QueryOptions | undefined,
  completeAdmissionOwner: QueryReadAdmissionCapability | null): QueryReadPlan {
  if (options?.view) {
    if (!options.contextGraphId) throw new Error(`view '${options.view}' requires a contextGraphId to scope the query`);
    return { kind: 'view', options: { ...options, contextGraphId: options.contextGraphId, view: options.view } };
  }
  if (!options?.contextGraphId) return { kind: 'unscoped' };
  const policy = createScopedContentGraphRoutePolicy(options.contextGraphId, options);
  const allowed = [...policy.staticContentGraphs, ...policy.metaAllowList, ...policy.staticPrivateAllowList];
  const needsDiscovery = !scope.hasGraphClause
    || scope.graphTargets.some(target => target.kind !== 'iri' || !allowed.includes(target.iri));
  const expandGraphVariables = options.includeContextGraphPartitions === true
    && scope.graphVariables.length > 0 && !policy.isSwmOnlyRoute;
  const contentPrefixes = needsDiscovery ? scopedRouteContentPrefixes(policy) : [];
  return { kind: 'scoped', policy,
    fallbackPolicy: options.requireCompleteGraphScope ? 'preserve-scope' : 'compatibility',
    excludedGraphPrefixes: [...(options.excludeGraphPrefixes ?? [])],
    discovery: { contentPrefixes, privatePartitions: !!options.includePrivate && needsDiscovery,
      // Complete dynamic routes use the catalog inventory for prefix reads;
      // private discovery adds metadata queries within the same owned admission.
      catalog: !expandGraphVariables ? { kind: 'none' }
        : completeAdmissionOwner
          ? { kind: 'admission-owned', owner: completeAdmissionOwner } : { kind: 'shared' },
    },
  };
}

import { requireGraphScopeRewrite, rewriteGraphRoute, type PreparedGraphScope } from './sparql-graph-scope.js';

/** Authorized explicit GRAPH scopes already own their routing; discover only unscoped queries. */
export async function resolveLegacyRouteScope(scope: PreparedGraphScope, root: string,
  family: 'data' | 'shared-memory', discover: (prefix: string) => Promise<string[]>): Promise<PreparedGraphScope> {
  if (scope.hasGraphClause) return scope;
  const data = family === 'data';
  const graphs = await discover(data ? `${root}/_verifiable_memory/` : `${root}/`);
  return requireGraphScopeRewrite(rewriteGraphRoute(scope,
    data && graphs.length ? [root, ...graphs] : graphs, root,
    data ? 'deduplicated-values-union' : 'union-only'));
}

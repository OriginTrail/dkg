import type { SparqlEngineFamily } from '@origintrail-official/dkg-storage';
import { reportRoutedGraphs } from './query-scope-meters.js';
import { requireGraphScopeRewrite, rewriteGraphRoute, rewriteGraphSet, type PreparedGraphScope } from './sparql-graph-scope.js';

interface LegacyRouteScopeOptions {
  root: string;
  family: 'data' | 'shared-memory';
  discover: (prefix: string) => Promise<string[]>;
  authorizedDatasetGraphs: readonly string[];
  fallbackPolicy?: 'compatibility' | 'preserve-scope';
  engine?: SparqlEngineFamily | null;
}

/**
 * Explicit GRAPH queries use the read plan's authorized dataset. For mixed
 * default patterns that plan discovers content first; keep its filtered list
 * instead of replacing it with an unfiltered prefix scan here.
 */
export async function resolveLegacyRouteScope(scope: PreparedGraphScope, {
  root, family, discover, authorizedDatasetGraphs, fallbackPolicy = 'compatibility', engine = null,
}: LegacyRouteScopeOptions): Promise<PreparedGraphScope> {
  if (scope.hasGraphClause) {
    const rewritten = rewriteGraphSet(scope, authorizedDatasetGraphs, 'union-only', engine);
    if (rewritten.kind === 'ready') reportRoutedGraphs(authorizedDatasetGraphs);
    return requireGraphScopeRewrite(rewritten);
  }
  const data = family === 'data';
  const graphs = await discover(data ? `${root}/_verifiable_memory/` : `${root}/`);
  return requireGraphScopeRewrite(rewriteGraphRoute(scope,
    data && graphs.length ? [root, ...graphs] : graphs, root,
    data ? 'deduplicated-values-union' : 'union-only', fallbackPolicy, engine, reportRoutedGraphs));
}

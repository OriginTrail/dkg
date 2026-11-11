import type { SparqlEngineFamily } from '@origintrail-official/dkg-storage';
import { requireGraphScopeRewrite, rewriteGraphRoute, rewriteGraphSet, type PreparedGraphScope } from './sparql-graph-scope.js';

interface LegacyRouteScopeOptions {
  root: string;
  family: 'data' | 'shared-memory';
  discover: (prefix: string) => Promise<string[]>;
  authorizedDatasetGraphs: readonly string[];
  fallbackPolicy?: 'compatibility' | 'preserve-scope';
  engine?: SparqlEngineFamily | null;
  /** Receives the graph list the query is routed over. */
  onRoute?: (graphs: readonly string[]) => void;
}

/**
 * Explicit GRAPH queries use the read plan's authorized dataset. For mixed
 * default patterns that plan discovers content first; keep its filtered list
 * instead of replacing it with an unfiltered prefix scan here.
 */
export async function resolveLegacyRouteScope(scope: PreparedGraphScope, {
  root, family, discover, authorizedDatasetGraphs, fallbackPolicy = 'compatibility', engine = null, onRoute,
}: LegacyRouteScopeOptions): Promise<PreparedGraphScope> {
  if (scope.hasGraphClause) {
    onRoute?.(authorizedDatasetGraphs);
    return requireGraphScopeRewrite(rewriteGraphSet(scope, authorizedDatasetGraphs, 'union-only', engine));
  }
  const data = family === 'data';
  const graphs = await discover(data ? `${root}/_verifiable_memory/` : `${root}/`);
  const routed = data && graphs.length ? [root, ...graphs] : graphs;
  // With no graph found, the route reads its root graph alone.
  onRoute?.(routed.length ? routed : [root]);
  return requireGraphScopeRewrite(rewriteGraphRoute(scope, routed, root,
    data ? 'deduplicated-values-union' : 'union-only', fallbackPolicy, engine));
}

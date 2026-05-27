// Single source of truth for the "which sub-graphs count as
// user-facing" filter, consumed by three call sites: ProjectView's
// Overview Subgraphs stat, SubGraphBar's chip row, and
// SubGraphOverviewGrid's card wall. Centralising here means S3
// has one place to extend if the reserved set ever grows.
//
// Contract: `meta` is the only reserved slug. It's the auto-registered
// profile/metadata subgraph that surfaces in the daemon's
// `listSubGraphs` (`packages/agent/src/dkg-agent.ts`); it holds the
// project profile, not user-facing entities, so consumers filter it.
// The daemon itself doesn't return `_`-prefixed internal graphs in
// `/sub-graph/list` — that filtering happens server-side, so we don't
// need to enumerate them here.

export const RESERVED_SUB_GRAPH_SLUGS: ReadonlySet<string> = new Set(['meta']);

/**
 * Returns true if a sub-graph descriptor should be surfaced to
 * users (chip row, card grid, Overview count). False for reserved
 * bookkeeping slugs.
 *
 * Accepts any object that carries a `name` (the slug). Both the
 * daemon's `SubGraphInfo` (`api.ts`) and ad-hoc test fixtures
 * fit.
 */
export function isUserFacingSubGraph(sg: { name: string }): boolean {
  return !RESERVED_SUB_GRAPH_SLUGS.has(sg.name);
}

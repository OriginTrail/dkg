// Codex review issue M — centralised reserved-slug rule. The
// "which sub-graphs count as user-facing" filter is consumed by
// three call sites (ProjectView's Overview Subgraphs stat,
// SubGraphBar's chip row, SubGraphOverviewGrid's card wall) and
// previously diverged between them (Overview filtered
// `meta` + `assertion`; the others only filtered `meta`),
// undercounting the Overview stat vs the clickable surfaces.
// Centralising here means S3 has one place to extend if the
// reserved-slug set grows.
//
// Current contract: only `meta` is reserved. `meta` holds the
// project profile, not user-facing entities. Other slugs that
// appear in `/sub-graph/list` (including `assertion`, which is a
// real slug a sub-graph CAN have) are user-facing and stay
// counted/visible.

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

/**
 * Parse a sub-graph slug out of a `dkg:assertionGraph` URI. Mirror of
 * `contextGraphAssertionUri` in `packages/core/src/constants.ts`:
 *
 *   root-bucket : `did:dkg:context-graph:<cgId>/assertion/<agent>/<name>`
 *   sub-graph   : `did:dkg:context-graph:<cgId>/<subGraphName>/assertion/<agent>/<name>`
 *
 * Returns the slug when present, `undefined` for root-bucket
 * assertions or any URI that doesn't match the expected shape.
 *
 * PR #839 sweep 1 — kept ALIVE as a migration fallback for pre-#770
 * scoped lifecycle events still in users' local `_meta` graphs. The
 * publisher writers (`packages/publisher/src/metadata.ts`) never
 * rewrite historical events, so any user who created scoped
 * lifecycle events before PR #770 shipped has rows that carry
 * `dkg:assertionGraph` but NO `dkg:subGraphName`. The lifecycle hook
 * prefers the literal predicate when present and falls back to URI
 * parsing here for those legacy rows. Without this fallback,
 * pre-#770 scoped events would render as root-bucket activity and
 * sub-graph filtering on the activity feed would break for the
 * migration window.
 *
 * Track removal in a future migration cycle — once GH #819's render-
 * correct derivation lands AND users have re-synced their local
 * stores, the URI-parse path becomes dead and this helper can be
 * deleted.
 *
 * Lives in `lib/` so both the transport layer (`api.ts`) and the
 * lifecycle hook can import it without creating a module cycle —
 * pure string parser, no React or transport dependency.
 */
export function subGraphFromAssertionGraphUri(
  assertionGraphUri: string,
  contextGraphId: string,
): string | undefined {
  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  if (!assertionGraphUri.startsWith(prefix)) return undefined;
  const tail = assertionGraphUri.slice(prefix.length);
  const segments = tail.split('/');
  // Root-bucket: tail starts with `assertion/…` (no sub-graph segment).
  if (segments[0] === 'assertion') return undefined;
  // Sub-graph: `<subGraphName>/assertion/…`. Require the assertion
  // segment to actually be there so we don't misparse stray URIs.
  if (segments.length >= 2 && segments[1] === 'assertion') return segments[0];
  return undefined;
}

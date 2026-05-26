/**
 * Parse a sub-graph slug out of a `dkg:assertionGraph` URI. Mirror of
 * `contextGraphAssertionUri` in `packages/core/src/constants.ts`:
 *
 *   root-bucket : `did:dkg:context-graph:<cgId>/assertion/<agent>/<name>`
 *   sub-graph   : `did:dkg:context-graph:<cgId>/<subGraphName>/assertion/<agent>/<name>`
 *
 * Returns the slug when present, `undefined` for root-bucket
 * assertions or any URI that doesn't match the expected shape (the
 * latter shouldn't happen in practice — `dkg:assertionGraph` is set
 * by the writer — but the parse stays defensive so a malformed URI
 * just suppresses the sub-graph filter rather than throwing).
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

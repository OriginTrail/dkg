// Only the places where a node takes a received copy in as its own may rewrite
// it to the form the triple store returns. A check of a hash against bytes as
// given (a peer's advertised digest, a stored snapshot) must hash them
// untouched, so every user of the rewrite is pinned here and adding one is a
// reviewed change.
export const INCOMING_COPY_ALLOWED_USERS = Object.freeze({
  canonicalizeRdfObjectTerm: Object.freeze([
    'packages/publisher/src/incoming-public-copy.ts',
    'packages/rdf-utils/src/index.ts',
  ]),
  acceptIncomingPublicQuads: Object.freeze([
    'packages/agent/src/gossip-publish-handler.ts',
    'packages/publisher/src/graph-scoped-ack-persistence.ts',
    'packages/publisher/src/incoming-public-copy.ts',
    'packages/publisher/src/index.ts',
    'packages/publisher/src/workspace-handler.ts',
  ]),
});

export function isPackageSourceFile(file) {
  return /^packages\/[^/]+\/src\/.+\.[cm]?[jt]sx?$/.test(file);
}

/** One message per source file that uses a pinned symbol without being pinned, or no longer uses it. */
export function findIncomingCopyBoundaryViolations(files, allowed = INCOMING_COPY_ALLOWED_USERS) {
  const violations = [];
  for (const [symbol, pinned] of Object.entries(allowed)) {
    const users = files
      .filter(({ path, text }) => isPackageSourceFile(path) && text.includes(symbol))
      .map(({ path }) => path);
    for (const user of users) {
      if (!pinned.includes(user)) {
        violations.push(`${user}: uses ${symbol}, which only ${pinned.join(', ')} may use`);
      }
    }
    for (const expected of pinned) {
      if (!users.includes(expected)) {
        violations.push(
          `${expected}: no longer uses ${symbol}; remove it from the allowlist in `
            + 'scripts/lib/incoming-copy-boundary.mjs',
        );
      }
    }
  }
  return violations;
}

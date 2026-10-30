// Fast local checks for the boundaries exposed by the 10.0.26 retrospective.
// Required CI workspace lanes remain authoritative and are never narrowed here.
export function boundaryTests(paths) {
  const selected = new Set();
  const add = (...files) => files.forEach(file => selected.add(`test/${file}.test.ts`));
  for (const file of paths) {
    if (/^packages\/(agent|core)\/(src|test)\//.test(file)) {
      add('rfc64-catalog-head-replay-peers', 'peer-profile-follow-up-agent', 'rfc64-unregistered-seed-fetch-agent');
    }
    if (/^packages\/(agent|storage)\/.*(?:inventory|migration|schema|sqlite|oxigraph)/.test(file)) add('rfc64-inventory-v1-lifecycle');
    if (/^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|\.npmrc)$/.test(file)
      || /^packages\/[^/]+\/package\.json$/.test(file)) {
      add('rfc64-catalog-head-replay-peers', 'peer-profile-follow-up-agent', 'rfc64-unregistered-seed-fetch-agent', 'rfc64-inventory-v1-lifecycle');
    }
  }
  return [...selected].sort();
}

export default Object.freeze({
  caseId: 'GH-2741', file: 'packages/agent/test/regression-peer-store-repair.test.ts',
  definitionFile: 'scripts/lib/regressions/cases/GH-2741.mjs',
  title: 'fetches the challenged asset from a provider the peer store lists as sync-capable',
  suite: 'Random Sampling proof-time exact repair on the real libp2p peer store',
  assertion: 'GH-2741: capable peer repair fetch completes',
  badObservation: (value) => Array.isArray(value.fetchedFrom) && value.fetchedFrom.length === 0
    && typeof value.outcome?.error === 'string'
    && value.outcome.error.startsWith('Random Sampling exact repair did not recover did:dkg:base:8453/'),
});

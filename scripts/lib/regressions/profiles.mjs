// Repository-owned, bounded profiles. Case JSON supplies no commands or regexes.
export const PROFILES = Object.freeze({
  'agent-on-demand-cursor-v1': {
    caseId: 'GH-2782', file: 'packages/agent/test/regression-on-demand-cursor.test.ts',
    title: 'advances an on-demand subscription through its pending ordinals without a durable write',
    suite: 'VM reconcile cursor follows the subscription lifetime',
    assertion: 'GH-2782: unsaved subscription converges without durable membership',
    badObservation: (value) => typeof value.error === 'string'
      && /durable subscription intent or host state is missing/.test(value.error)
      && value.current === false && value.subscriptionWatermark === 0
      && value.saves === 0 && value.rows === 0 && value.sameSubscription === true,
  },
  'agent-peer-store-repair-v1': {
    caseId: 'GH-2741', file: 'packages/agent/test/regression-peer-store-repair.test.ts',
    title: 'fetches the challenged asset from a provider the peer store lists as sync-capable',
    suite: 'Random Sampling proof-time exact repair on the real libp2p peer store',
    assertion: 'GH-2741: capable peer repair fetch completes',
    badObservation: (value) => Array.isArray(value.fetchedFrom) && value.fetchedFrom.length === 0
      && typeof value.outcome?.error === 'string'
      && value.outcome.error.startsWith('Random Sampling exact repair did not recover did:dkg:base:8453/'),
  },
});
export const REQUIRED_ROUTE = Object.freeze({ lane: 'tornado-agent', config: 'vitest.unit.config.ts', cadence: 'required' });
export function profileFor(record) {
  const profile = PROFILES[record?.execution?.profile];
  if (!profile || record.id !== profile.caseId) throw new Error('unknown case/profile');
  return { ...profile, fullName: `${profile.suite} ${profile.title}`, discoveryName: `${profile.suite} > ${profile.title}` };
}
export function replayConfig(profile) {
  return `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { allowOnly: false, include: [${JSON.stringify(profile.file.replace('packages/agent/', ''))}], pool: 'forks', maxWorkers: 1, testTimeout: 15000, hookTimeout: 15000, execArgv: ['--experimental-sqlite', '--no-warnings=ExperimentalWarning'] } });\n`;
}

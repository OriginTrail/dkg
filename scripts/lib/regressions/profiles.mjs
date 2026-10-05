// Repository-owned, bounded profiles. Case JSON supplies no commands or regexes.
import onDemandCursor from './cases/GH-2782.mjs';
import peerStoreRepair from './cases/GH-2741.mjs';

export const PROFILES = Object.freeze({
  'agent-on-demand-cursor-v1': onDemandCursor,
  'agent-peer-store-repair-v1': peerStoreRepair,
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

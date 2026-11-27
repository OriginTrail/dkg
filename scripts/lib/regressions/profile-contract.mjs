// What every repository-owned profile shares: the required route each case
// must run in, the minimal historical replay config, and the names derived
// from a case's suite and title. The case-specific definitions live in
// cases/ and the register (profiles.mjs) only maps IDs to them, so a receipt
// is fingerprinted by this contract and its own case, not by the register.

export const REQUIRED_ROUTE = Object.freeze({ lane: 'tornado-agent', config: 'vitest.unit.config.ts', cadence: 'required' });

export const withDerivedNames = (definition) => ({
  ...definition,
  fullName: `${definition.suite} ${definition.title}`,
  discoveryName: `${definition.suite} > ${definition.title}`,
});

export function replayConfig(profile) {
  return `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { allowOnly: false, include: [${JSON.stringify(profile.file.replace('packages/agent/', ''))}], pool: 'forks', maxWorkers: 1, testTimeout: 15000, hookTimeout: 15000, execArgv: ['--experimental-sqlite', '--no-warnings=ExperimentalWarning'] } });\n`;
}

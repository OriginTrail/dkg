// Shared fixtures for the CI planner, controller and aggregate-gate tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CI_LANES, PRIMARY_LANE_JOBS, planCi } from '../ci-delta.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const NON_SOLIDITY_LANES = CI_LANES.filter((lane) => lane !== 'contracts');
// The jobs selected lanes run: each lane's own job, and the Windows lifecycle
// job, which runs with the agent lane.
export const LANE_JOBS = [...Object.values(PRIMARY_LANE_JOBS), 'inventory-windows'];

export function change(filePath, status = 'M') {
  return { status, paths: [filePath] };
}

export function pullRequestPlan(changeEntries, overrides = {}) {
  return planCi({
    eventName: 'pull_request',
    changeEntries,
    ...overrides,
  });
}

export function selectedLanes(plan) {
  return CI_LANES.filter((lane) => plan.lanes[lane]);
}

// The `needs` the primary aggregate gate inspects: `changes` succeeded and
// every other job was skipped, except the jobs named in `results`.
export function gateNeeds(results = {}) {
  const needs = Object.fromEntries([
    'build',
    'evm-node-test-artifacts',
    'evm-devnet-test-artifacts',
    ...LANE_JOBS,
    'abi-freshness',
    'solidity',
    'solidity-coverage',
    'tornado-static-analysis',
  ].map((job) => [job, { result: 'skipped' }]));
  needs.changes = { result: 'success' };
  for (const [job, result] of Object.entries(results)) needs[job] = { result };
  return needs;
}

export function succeeded(...jobs) {
  return Object.fromEntries(jobs.flat().map((job) => [job, 'success']));
}

// Source files (repo-relative) under `directory`, skipping installs and builds.
export function sourceFiles(directory) {
  return fs.readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'dist-ui', 'coverage'].includes(entry.name)) return [];
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [relative] : [];
  });
}

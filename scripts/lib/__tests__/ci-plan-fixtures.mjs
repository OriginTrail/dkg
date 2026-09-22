// Shared fixtures for the CI planner, controller and aggregate-gate tests.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CI_LANES, PRIMARY_LANE_JOBS, planCi } from '../ci-delta.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const NON_SOLIDITY_LANES = CI_LANES.filter((lane) => lane !== 'contracts');
export const LANE_JOBS = Object.values(PRIMARY_LANE_JOBS);

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

// Shared fixtures for the CI planner, controller and aggregate-gate tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CI_LANES, PRIMARY_LANE_JOBS, planCi } from '../ci-delta.mjs';
import { repositoryFiles, workflowExecution } from './ci-execution-graph.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// The trusted CI controller commit that the workflows' four trusted checkouts
// pin; a rotation changes it here and in those four `ref:` lines, nowhere
// else. It must already be on protected testnet-canary or main history: the
// test 'the pinned controller is already on protected branch history' checks
// that against the branches the build job fetches, and the scheduled
// inspect-ci-policy report flags it after merge.
export const TRUSTED_CI_CONTROLLER_SHA = 'dfb3460719c13d592e2bb4d7d3c29fe55567fbe3';
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

// Source files (repo-relative) under `directory`, skipping installs, builds
// and anything else the repository does not hold (repositoryFiles).
export function sourceFiles(directory) {
  return fs.readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'dist-ui', 'coverage'].includes(entry.name)) return [];
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    const held = !repositoryFiles() || repositoryFiles().has(relative);
    return held && /\.[cm]?[jt]sx?$/.test(entry.name) ? [relative] : [];
  });
}

// What each job of a workflow runs, as the text of its commands: its steps'
// `run` scripts, the root package.json scripts, workspace scripts and
// repository shell scripts they reach, and the steps of the local composite
// actions and reusable workflows it uses (a reusable workflow's jobs run for
// the job that calls it), as the CI execution graph reads them
// (ci-execution-graph.mjs). One { job, condition, commands } entry per job; a
// local action or workflow that cannot be read throws.
export function workflowJobCommands(workflowSource, { readRepoFile } = {}) {
  return workflowExecution(workflowSource, readRepoFile ? { readRepoFile } : undefined)
    .map(({ job, condition, commands }) => ({ job, condition, commands }));
}

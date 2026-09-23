// Shared fixtures for the CI planner, controller and aggregate-gate tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CI_LANES, PRIMARY_LANE_JOBS, WORKSPACE_RULES, planCi } from '../ci-delta.mjs';

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

// Source files (repo-relative) under `directory`, skipping installs and builds.
export function sourceFiles(directory) {
  return fs.readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'dist-ui', 'coverage'].includes(entry.name)) return [];
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [relative] : [];
  });
}

function readWorkspaces() {
  const manifests = new Map(Object.keys(WORKSPACE_RULES).map((workspace) => [
    workspace,
    JSON.parse(fs.readFileSync(path.join(REPO_ROOT, workspace, 'package.json'), 'utf8')),
  ]));
  return { manifests, workspaceByName: new Map([...manifests].map(([workspace, { name }]) => [name, workspace])) };
}

// `roots` plus every workspace they depend on (dependencies and
// devDependencies). Roots that are not workspaces are ignored.
export function workspaceClosure(roots) {
  const { manifests, workspaceByName } = readWorkspaces();
  const queue = [...roots];
  const closure = new Set();
  while (queue.length) {
    const workspace = queue.shift();
    if (closure.has(workspace) || !manifests.has(workspace)) continue;
    closure.add(workspace);
    const { dependencies = {}, devDependencies = {} } = manifests.get(workspace);
    for (const name of Object.keys({ ...dependencies, ...devDependencies })) {
      if (workspaceByName.has(name)) queue.push(workspaceByName.get(name));
    }
  }
  return closure;
}

// The workspaces that `files` import by package name, plus everything those
// workspaces depend on: what code outside the package lanes compiles against.
export function importedWorkspaceClosure(files) {
  const { workspaceByName } = readWorkspaces();
  return workspaceClosure(files.flatMap((file) => [
    ...fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')
      .matchAll(/(?:from|import\()\s*['"](@origintrail-official\/[a-z0-9-]+)/g),
  ].map(([, name]) => workspaceByName.get(name)).filter(Boolean)));
}

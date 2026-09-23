// Shared fixtures for the CI planner, controller and aggregate-gate tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
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

function readRepoText(file) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  } catch {
    return undefined;
  }
}

// What each job of a workflow runs, as the text of its commands: its steps'
// `run` scripts, the root package.json scripts they call (pnpm, npm or yarn,
// recursively), the repository shell scripts they name, and the steps of the
// local composite actions and reusable workflows it uses (a reusable
// workflow's jobs run for the job that calls it). One { job, condition,
// commands } entry per job; a local action or workflow that cannot be read
// throws.
export function workflowJobCommands(workflowSource, { readRepoFile = readRepoText } = {}) {
  const { scripts = {} } = JSON.parse(readRepoFile('package.json') ?? '{}');
  return Object.entries(parse(workflowSource).jobs ?? {}).map(([job, definition]) => {
    const followed = new Set();
    const unseen = (key) => !followed.has(key) && Boolean(followed.add(key));
    const commands = [];
    const followRun = (text) => {
      commands.push(text);
      for (const [, name] of text.matchAll(/\b(?:pnpm|npm|yarn)\s+(?:run\s+)?([\w:.-]+)/g)) {
        if (Object.hasOwn(scripts, name) && unseen(`script ${name}`)) followRun(scripts[name]);
      }
      for (const [script] of text.matchAll(/[\w./-]+\.sh\b/g)) {
        const file = path.posix.normalize(script);
        const source = readRepoFile(file);
        if (source !== undefined && unseen(file)) followRun(source);
      }
    };
    const followJob = ({ steps = [], uses } = {}) => {
      for (const step of steps) {
        if (step.run) followRun(step.run);
        followUses(step.uses);
      }
      followUses(uses);
    };
    const followUses = (uses) => {
      const target = uses?.match(/^\.\/(.+?)\/?$/)?.[1];
      if (!target || !unseen(target)) return;
      const definition = /\.ya?ml$/.test(target)
        ? readRepoFile(target)
        : ['action.yml', 'action.yaml'].map((name) => readRepoFile(`${target}/${name}`)).find((text) => text !== undefined);
      if (definition === undefined) throw new Error(`${uses} names no local workflow or action`);
      const { jobs, runs } = parse(definition);
      if (jobs) for (const nested of Object.values(jobs)) followJob(nested);
      else followJob({ steps: runs?.steps });
    };
    followJob(definition);
    return { job, condition: definition.if ?? '', commands };
  });
}

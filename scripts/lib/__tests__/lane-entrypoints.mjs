// What CI executes, as the seeds of the load-closure guard in
// ci-delta-routing.test.mjs (traced by traceLaneLoads in load-graph.mjs):
// each lane's workspace code and tests, and every repository file the
// workflow jobs run or name, read from the CI execution graph
// (ci-execution-graph.mjs), with what a change to that file must select. A
// workspace's package script counts only where a CI command reaches it,
// never because its workspace owns a lane.
import fs from 'node:fs';
import path from 'node:path';
import { CI_LANES, EVM_SCOPES, WORKSPACE_OWNING_LANES, WORKSPACE_RULES, isInstallLifecycleScript, needsSharedBuild } from '../ci-delta.mjs';
import { PRIMARY_LANE_JOBS } from '../ci-results.mjs';
import { EVM_TEST_SCOPES } from '../../ci/evm-test-scopes.mjs';
import { REPO_ROOT, sourceFiles } from './ci-plan-fixtures.mjs';
import { workflowExecution } from './ci-execution-graph.mjs';

const laneByJob = Object.fromEntries(Object.entries(PRIMARY_LANE_JOBS).map(([lane, job]) => [job, lane]));

// The lane a ci.yml job runs for: its mapped lane or, like a job that only
// calls a reusable workflow, the lane output its condition reads.
export function jobLane(job, condition) {
  return [laneByJob[job], condition.match(/needs\.changes\.outputs\.(\w+) == 'true'/)?.[1]]
    .find((lane) => CI_LANES.includes(lane));
}

// What a change to a file CI executes must select. The trace carries each
// as a string, so identical requirements merge; these build them, and
// parseRequirement reads one back:
// - lane(<lane>): that lane runs the file;
// - evmScope(<scope>): that EVM integration scope's suites run it;
// - build: the shared build job's own checks run it;
// - install: every job's install runs it (an install lifecycle hook): full
//   CI, and the routing test checks the reads it cannot resolve;
// - full: a job outside the lanes runs it: full CI;
// - buildOutput(<workspace>): that workspace's build or pack in the shared
//   build job runs it, and every lane restores the output.
export const requirement = Object.freeze({
  lane: (lane) => {
    if (!CI_LANES.includes(lane)) throw new Error(`unknown CI lane: ${lane}`);
    return lane;
  },
  evmScope: (scope) => {
    if (!EVM_SCOPES.includes(scope)) throw new Error(`unknown EVM scope: ${scope}`);
    return `evm:${scope}`;
  },
  build: 'build',
  install: 'install',
  full: 'full',
  buildOutput: (workspace) => {
    if (!workspace) throw new Error('a build-output requirement names the workspace that builds');
    return `build-output:${workspace}`;
  },
});

// A requirement string as { kind, lane | scope | workspace }; a string no
// kind matches (a misspelled lane, an unknown scope) throws.
export function parseRequirement(text) {
  if (CI_LANES.includes(text)) return { kind: 'lane', lane: text };
  if (text === requirement.build || text === requirement.install || text === requirement.full) return { kind: text };
  const [kind, value] = text.split(/:(.*)/s);
  if (kind === 'evm' && EVM_SCOPES.includes(value)) return { kind, scope: value };
  if (kind === 'build-output' && value) return { kind, workspace: value };
  throw new Error(`unknown routing requirement: ${text}`);
}

// The daemon runtime the browser suite boots (scripts/devnet.sh) outside its
// UI surface and harness: on a pull request each runs its own lanes and the
// CLI daemon tests, and the browser suite follows after merge. The routing
// test pins this list against devnet.sh and the rules.
export const BROWSER_SUITE_DEFERRED = Object.freeze([
  'packages/adapter-hermes',
  'packages/adapter-openclaw',
  'packages/adapter-prime-agent',
  'packages/agent',
  'packages/chain',
  'packages/epcis',
  'packages/http-utils',
  'packages/local-llm',
  'packages/mcp-dkg',
  'packages/okf',
  'packages/publisher',
  'packages/query',
  'packages/random-sampling',
  'packages/storage',
]);

const workspaceOf = (file) => Object.keys(WORKSPACE_RULES).find((workspace) => file.startsWith(`${workspace}/`));

// Whether `plan`, the plan for a change to `file`, selects what the
// requirement string `text` asks; a full plan selects everything, and an
// unknown requirement throws. What a workspace's build output reaches: a
// repository file needs full CI; a file in a package workspace, every lane
// and scope the producing workspace's rule selects, except the browser suite
// for the runtime it follows after merge (BROWSER_SUITE_DEFERRED); a
// producer without a rule is met only by full CI.
export function requirementCoveredByPlan(text, plan, file) {
  const required = parseRequirement(text);
  if (plan.mode === 'full') return true;
  switch (required.kind) {
    case 'lane':
      return Boolean(plan.lanes[required.lane]);
    case 'evm':
      return plan.evmScopes.includes(required.scope);
    case 'build':
      return needsSharedBuild(plan);
    case 'build-output': {
      const workspace = workspaceOf(file);
      const rule = WORKSPACE_RULES[required.workspace];
      return Boolean(workspace && rule)
        && rule.lanes.every((lane) => plan.lanes[lane] || (lane === 'kosava_node_ui_e2e' && BROWSER_SUITE_DEFERRED.includes(workspace)))
        && rule.evmScopes.every((scope) => plan.evmScopes.includes(scope));
    }
    default:
      return false;
  }
}

// What a change to a file a job runs must select, by job: a ci.yml lane
// job's lane; `build` for the shared build job's own checks; nothing for
// the changes job, which runs on every pull request; `full` for every other
// job (the Solidity, artifact and gate jobs, push-only jobs, and the EVM
// workflow's jobs, whose runner every scope uses).
export function jobRequirement(workflow, job, condition) {
  if (workflow === 'ci.yml') {
    if (!condition) return undefined;
    const lane = jobLane(job, condition);
    if (lane) return requirement.lane(lane);
    if (/\bneeds\.changes\.outputs\.run_node == 'true'/.test(condition)) return requirement.build;
  }
  return requirement.full;
}

// The requirement for one edge of a job with `requirement`, from the package
// scripts that led to it: `install` under an install lifecycle hook, which
// every job's install runs (full CI, and the routing test checks the reads it
// cannot resolve); `build-output:<workspace>` under a workspace's
// script the shared build job runs (its build, or the pack
// release:verify-pack runs), since every lane restores that workspace's
// build output.
export function edgeRequirement(jobRequired, chain) {
  if (chain.some(({ script }) => isInstallLifecycleScript(script))) return requirement.install;
  const producer = jobRequired === requirement.build ? chain.find(({ workspace }) => workspace !== '.') : undefined;
  return producer ? requirement.buildOutput(producer.workspace) : jobRequired;
}

const WORKFLOWS = ['ci.yml', 'evm-integration.yml'];
const inPackageWorkspace = (file) => Object.keys(WORKSPACE_RULES).some((workspace) => file.startsWith(`${workspace}/`));

// The load-closure guard's seeds: a Map from each file CI executes to a Map
// from requirement (a lane, `evm:<scope>`, `build`, `build-output:<workspace>`,
// `install` or `full`) to where it comes from.
// - A workspace's code and tests run in its owning lanes; node-ui's browser
//   specs in the e2e lane and integration suites in the EVM scope that lists
//   them. A workspace's own scripts/ and fixture workspaces (test-fixtures/)
//   run only where something runs them.
// - Every repository file a workflow job runs or names, directly or through
//   the package scripts and shell scripts it reaches, with the edge's
//   requirement, so what it loads is traced too: a package-local helper a
//   workspace's build runs carries that build's output. A file inside a
//   package workspace that a job's own commands name, outside any package
//   script, is that workspace's code in a job the ownership test checks, and
//   routes by its rule.
// `workflows` maps a workflow file name to its source; `execution` options
// go to workflowExecution.
export function laneSeeds(options) {
  return laneExecution(options).seeds;
}

// laneSeeds' seeds, and `unresolved`: each script path a job's steps, or the
// package scripts and shell scripts they reach, assemble at run time, as
// `${workflow} ${job}: ${text}`, for a job that must select something. No
// trace can resolve those either, so the routing test fails on one it does
// not list, as it does on a traced file's.
export function laneExecution({
  workflows = WORKFLOWS.map((workflow) => [workflow, fs.readFileSync(path.join(REPO_ROOT, '.github/workflows', workflow), 'utf8')]),
  execution,
  workspaceCode = true,
} = {}) {
  const seeds = new Map();
  const unresolved = new Set();
  const seed = (file, requirements, via) => {
    const entry = seeds.get(file) ?? seeds.set(file, new Map()).get(file);
    for (const requirement of requirements) if (!entry.has(requirement)) entry.set(requirement, via);
  };
  const evmScopeFiles = new Map(Object.entries(EVM_TEST_SCOPES).flatMap(([scope, { packageDirectory, files }]) =>
    files.map((file) => [path.posix.normalize(path.posix.join(packageDirectory, file)), requirement.evmScope(scope)])));
  for (const [workspace, owningLanes] of workspaceCode ? Object.entries(WORKSPACE_OWNING_LANES) : []) {
    if (WORKSPACE_RULES[workspace].forceFull) continue;
    for (const file of sourceFiles(workspace)) {
      const inside = file.slice(workspace.length + 1);
      if (/^(?:scripts|test-fixtures|test\/archive)\//.test(inside)) continue;
      // Demo apps' run.mjs entry points run by hand; the demo lane runs tests.
      if (workspace === 'demo' && /^[^/]+\/run\.[cm]?[jt]s$/.test(inside)) continue;
      if (inside.startsWith('integration/')) {
        if (evmScopeFiles.has(file)) seed(file, [evmScopeFiles.get(file)], 'EVM_TEST_SCOPES');
      } else if (workspace === 'packages/node-ui' && inside.startsWith('e2e/')) {
        seed(file, [requirement.lane('kosava_node_ui_e2e')], 'the browser suite');
      } else {
        seed(file, [...owningLanes.map(requirement.lane), ...(evmScopeFiles.has(file) ? [evmScopeFiles.get(file)] : [])], `${workspace} lanes`);
      }
    }
  }
  for (const [workflow, source] of workflows) {
    for (const { job, condition, edges } of workflowExecution(source, execution)) {
      const requirement = jobRequirement(workflow, job, condition);
      if (!requirement) continue;
      for (const edge of edges) {
        if (edge.kind === 'assembled') unresolved.add(`${workflow} ${job}: ${edge.text}`);
        if (edge.kind !== 'file' || (inPackageWorkspace(edge.file) && edge.chain.length === 0)) continue;
        seed(edge.file, [edgeRequirement(requirement, edge.chain)], `${workflow} ${edge.via}`);
      }
    }
  }
  return { seeds, unresolved: [...unresolved] };
}

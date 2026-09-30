// What CI executes, as the seeds of the load-closure guard in
// ci-delta-routing.test.mjs (traced by traceLaneLoads in load-graph.mjs):
// each lane's workspace code and tests, and every repository file the
// workflow jobs run or name, read from the CI execution graph
// (ci-execution-graph.mjs), with what a change to that file must select. A
// workspace's package script counts only where a CI command reaches it,
// never because its workspace owns a lane.
import fs from 'node:fs';
import path from 'node:path';
import { CI_LANES, WORKSPACE_OWNING_LANES, WORKSPACE_RULES, isInstallLifecycleScript } from '../ci-delta.mjs';
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

// What a change to a file a job runs must select, by job: a ci.yml lane
// job's lane; `build` for the shared build job's own checks; nothing for
// the changes job, which runs on every pull request; `full` for every other
// job (the Solidity, artifact and gate jobs, push-only jobs, and the EVM
// workflow's jobs, whose runner every scope uses).
export function jobRequirement(workflow, job, condition) {
  if (workflow === 'ci.yml') {
    if (!condition) return undefined;
    const lane = jobLane(job, condition);
    if (lane) return lane;
    if (/\bneeds\.changes\.outputs\.run_node == 'true'/.test(condition)) return 'build';
  }
  return 'full';
}

// The requirement for one edge of a job with `requirement`, from the package
// scripts that led to it: `full` under an install lifecycle hook, which
// every job's install runs, and under a workspace script the shared build
// job runs, since every lane restores that build output.
export function edgeRequirement(requirement, chain) {
  if (chain.some(({ script }) => isInstallLifecycleScript(script))) return 'full';
  if (requirement === 'build' && chain.some(({ workspace }) => workspace !== '.')) return 'full';
  return requirement;
}

const WORKFLOWS = ['ci.yml', 'evm-integration.yml'];
const inPackageWorkspace = (file) => Object.keys(WORKSPACE_RULES).some((workspace) => file.startsWith(`${workspace}/`));

// The load-closure guard's seeds: a Map from each file CI executes to a Map
// from requirement (a lane, `evm:<scope>`, `build` or `full`) to where it
// comes from.
// - A workspace's code and tests run in its owning lanes; node-ui's browser
//   specs in the e2e lane and integration suites in the EVM scope that lists
//   them. A workspace's own scripts/ and fixture workspaces (test-fixtures/)
//   run only where something runs them.
// - Every repository file outside the package workspaces that a workflow
//   job runs or names, directly or through the package scripts and shell
//   scripts it reaches, with the edge's requirement. A file inside a package
//   workspace is that workspace's code, which its rule routes (the ownership
//   test checks the jobs that run each workspace), except what an install
//   hook runs: every job installs, whatever its lane.
// `workflows` maps a workflow file name to its source; `execution` options
// go to workflowExecution.
export function laneSeeds({
  workflows = WORKFLOWS.map((workflow) => [workflow, fs.readFileSync(path.join(REPO_ROOT, '.github/workflows', workflow), 'utf8')]),
  execution,
  workspaceCode = true,
} = {}) {
  const seeds = new Map();
  const seed = (file, requirements, via) => {
    const entry = seeds.get(file) ?? seeds.set(file, new Map()).get(file);
    for (const requirement of requirements) if (!entry.has(requirement)) entry.set(requirement, via);
  };
  const evmScopeFiles = new Map(Object.entries(EVM_TEST_SCOPES).flatMap(([scope, { packageDirectory, files }]) =>
    files.map((file) => [path.posix.normalize(path.posix.join(packageDirectory, file)), `evm:${scope}`])));
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
        seed(file, ['kosava_node_ui_e2e'], 'the browser suite');
      } else {
        seed(file, [...owningLanes, ...(evmScopeFiles.has(file) ? [evmScopeFiles.get(file)] : [])], `${workspace} lanes`);
      }
    }
  }
  for (const [workflow, source] of workflows) {
    for (const { job, condition, edges } of workflowExecution(source, execution)) {
      const requirement = jobRequirement(workflow, job, condition);
      if (!requirement) continue;
      for (const edge of edges) {
        if (edge.kind !== 'file') continue;
        const installed = edge.chain.some(({ script }) => isInstallLifecycleScript(script));
        if (inPackageWorkspace(edge.file) && !installed) continue;
        seed(edge.file, [edgeRequirement(requirement, edge.chain)], `${workflow} ${edge.via}`);
      }
    }
  }
  return seeds;
}

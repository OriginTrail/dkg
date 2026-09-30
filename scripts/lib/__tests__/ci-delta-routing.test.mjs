import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  CI_LANES,
  WORKSPACE_OWNING_EVM_SCOPES,
  WORKSPACE_OWNING_LANES,
  WORKSPACE_RULES,
  needsSharedBuild,
  planCi,
} from '../ci-delta.mjs';
import { COVERAGE_JOBS } from '../ci-lanes.mjs';
import { PRIMARY_LANE_JOBS, validatePrimaryResults } from '../ci-results.mjs';
import { EVM_TEST_SCOPES } from '../../ci/evm-test-scopes.mjs';
import {
  REPO_ROOT,
  change,
  gateNeeds,
  pullRequestPlan,
  selectedLanes,
  sourceFiles,
  succeeded,
} from './ci-plan-fixtures.mjs';
import { BUILD_ONLY_SCRIPTS, INSTALL_HOOK_INPUTS, SUPPORT_PATH_ROUTES, scriptsPattern } from '../ci-routing.mjs';
import { COMMAND_EFFECTS, workflowExecution } from './ci-execution-graph.mjs';
import { edgeRequirement, jobLane, jobRequirement, laneSeeds } from './lane-entrypoints.mjs';
import { dependenciesOf, loadReferences, packageImports, repoScriptMentions, traceLaneLoads, workspaceClosure } from './load-graph.mjs';

// The workspaces that `files` import by package name, plus everything those
// workspaces depend on: what code outside the package lanes compiles against.
// Type-only imports count, since they compile.
function importedWorkspaceClosure(files) {
  const workspaceByName = new Map(Object.keys(WORKSPACE_RULES).map((workspace) => [
    JSON.parse(fs.readFileSync(path.join(REPO_ROOT, workspace, 'package.json'), 'utf8')).name,
    workspace,
  ]));
  return workspaceClosure(files.flatMap((file) => packageImports(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'))
    .map((name) => workspaceByName.get(name))
    .filter(Boolean)));
}

// Path routing: what individual changed paths select on pull requests -
// git statuses, workspace manifests, repository support areas and the
// per-file triggers (browser surface, Windows lifecycle, identity wallet,
// Blazegraph arm64) - and that the lane a path selects runs or loads it.

test('deletions, renames and copies route every path they touch like edits', () => {
  const deleted = pullRequestPlan([change('packages/network-sim/src/removed.ts', 'D')]);
  assert.equal(deleted.mode, 'delta');
  assert.deepEqual(selectedLanes(deleted), ['kosava_supporting']);

  const from = 'packages/network-sim/src/moved.ts';
  const to = 'packages/query/src/moved.ts';
  const asEdits = pullRequestPlan([change(from), change(to)]);
  for (const status of ['R087', 'C075']) {
    const plan = pullRequestPlan([{ status, paths: [from, to] }]);
    assert.equal(plan.mode, 'delta', status);
    assert.deepEqual(selectedLanes(plan), selectedLanes(asEdits), status);
    assert.deepEqual(plan.evmScopes, asEdits.evmScopes, status);
  }

  // The paths themselves still decide: control-plane files and manifests that
  // appear, disappear or move keep the full profile.
  for (const changeEntry of [
    { status: 'R100', paths: ['.github/workflows/ci.yml', '.github/workflows/ci-old.yml'] },
    { status: 'D', paths: ['scripts/ci/plan-ci.mjs'] },
    { status: 'D', paths: ['packages/network-sim/package.json'] },
    { status: 'A', paths: ['packages/network-sim/package.json'] },
    { status: 'R100', paths: ['packages/network-sim/package.json', 'packages/network-sim/old.json'] },
  ]) {
    assert.equal(pullRequestPlan([changeEntry]).mode, 'full', JSON.stringify(changeEntry));
  }
});

test('multi-workspace PRs select the union of their rules instead of full CI', () => {
  const files = [
    'packages/agent/src/a.ts',
    'packages/cli/src/a.ts',
    'packages/query/src/a.ts',
    'packages/node-ui/src/a.ts',
    'packages/network-sim/src/a.ts',
  ];
  const plan = pullRequestPlan(files.map((filePath) => change(filePath)));
  assert.equal(plan.mode, 'delta');
  const union = new Set(files.flatMap((filePath) => selectedLanes(pullRequestPlan([change(filePath)]))));
  assert.deepEqual(selectedLanes(plan), CI_LANES.filter((lane) => union.has(lane)));
  assert.equal(plan.lanes.tornado_core, false, 'none of these workspaces feeds the core lane');
  assert.doesNotMatch(plan.reasons.join('\n'), /Cross-cutting/);
});

test('package-scoped manifest edits route to their workspace; install inputs stay full', () => {
  const manifest = {
    name: '@origintrail-official/dkg-publisher',
    version: '10.0.0',
    type: 'module',
    exports: { '.': './dist/index.js' },
    scripts: { build: 'tsc', test: 'vitest run' },
    dependencies: { ethers: '^6.13.0' },
  };
  const manifestPlan = (head, entries = [change('packages/publisher/package.json')], base = manifest) => pullRequestPlan(entries, {
    readManifest: (side) => JSON.stringify(side === 'base' ? base : head),
  });
  const without = (object, field) => Object.fromEntries(Object.entries(object).filter(([key]) => key !== field));
  const sourcePlan = pullRequestPlan([change('packages/publisher/src/index.ts')]);

  for (const head of [
    { ...manifest, exports: { ...manifest.exports, './sync': './dist/sync.js' } },
    { ...manifest, scripts: { ...manifest.scripts, 'benchmark:x': 'node bench.mjs' } },
    // Packing hooks run only when packing, which the shared build verifies.
    { ...manifest, scripts: { ...manifest.scripts, prepack: 'pnpm run build' } },
    { ...manifest, version: '10.0.1', files: ['dist'] },
    Object.fromEntries(Object.entries(manifest).reverse()),
  ]) {
    const plan = manifestPlan(head);
    assert.equal(plan.mode, 'delta', JSON.stringify(head));
    assert.deepEqual(selectedLanes(plan), selectedLanes(sourcePlan), JSON.stringify(head));
    assert.deepEqual(plan.evmScopes, sourcePlan.evmScopes);
    assert.match(plan.reasons.join('\n'), /Package-scoped manifest change/);
  }

  for (const [head, reason] of [
    [{ ...manifest, dependencies: { ethers: '^6.14.0' } }, /changed dependencies$/],
    [{ ...manifest, devDependencies: { tsx: '^4.0.0' } }, /changed devDependencies$/],
    [{ ...manifest, type: 'commonjs' }, /changed type$/],
    [{ ...manifest, bin: { dkg: './dist/cli.js' } }, /changed bin$/],
    [{ ...manifest, directories: { bin: './bin' } }, /changed directories$/],
    [{ ...manifest, name: '@origintrail-official/dkg-agent-next' }, /changed name$/],
    // A field only the base has changed too.
    [without(manifest, 'dependencies'), /changed dependencies$/],
    [without(manifest, 'type'), /changed type$/],
    [{ ...manifest, pnpm: { overrides: {} } }, /changed pnpm$/],
    [{ ...manifest, engines: { node: '>=22' } }, /changed engines$/],
    [{ ...manifest, somethingNew: true }, /changed somethingNew$/],
    // Every install-time hook the policy documents, plus any pnpm: hook.
    ...[
      'preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare',
      'prepublish', 'dependencies', 'pnpm:devPreinstall', 'pnpm:futureHook',
    ].map((hook) => [
      { ...manifest, scripts: { ...manifest.scripts, [hook]: 'node setup.js' } },
      new RegExp(`install lifecycle scripts ${hook}$`),
    ]),
    [{ ...manifest, scripts: 'node setup.js' }, /scripts is not a JSON object$/],
  ]) {
    const plan = manifestPlan(head);
    assert.equal(plan.mode, 'full', String(reason));
    assert.match(plan.reasons[0], reason);
  }
  // Identical text on both sides means the compared commits are not the diff.
  const identical = manifestPlan(manifest);
  assert.equal(identical.mode, 'full', 'identical base and head');
  assert.match(identical.reasons[0], /identical in both compared commits/);
  const withHook = { ...manifest, scripts: { ...manifest.scripts, postinstall: 'node setup.js' } };
  const removedHook = manifestPlan(manifest, undefined, withHook);
  assert.equal(removedHook.mode, 'full', 'removing an install hook');
  assert.match(removedHook.reasons[0], /install lifecycle scripts postinstall$/);

  const publisherManifest = [change('packages/publisher/package.json')];
  for (const [readManifest, reason] of [
    [undefined, /contents are unavailable to the planner$/],
    [() => { throw new Error('missing blob\nfatal: details'); }, /could not be read and parsed: missing blob$/],
    [() => '{ not json', /could not be read and parsed: .*JSON/],
    [(side) => (side === 'base' ? '[]' : '[1]'), /is not a JSON object$/],
  ]) {
    const plan = pullRequestPlan(publisherManifest, { readManifest });
    assert.equal(plan.mode, 'full', String(readManifest));
    assert.match(plan.reasons[0], /^Workspace manifest could not be compared: packages\/publisher\/package\.json /);
    assert.match(plan.reasons[0], reason);
  }
  assert.equal(manifestPlan(manifest, [change('package.json')]).mode, 'full', 'root manifest');
  assert.equal(manifestPlan(manifest, [change('devnet/v10-stress/package.json')]).mode, 'full', 'devnet workspace');
});

test('every pnpm workspace manifest is compared field by field or keeps full CI', () => {
  // Manifests are install inputs. Package roots are compared field by field
  // (see the test above); every other workspace pnpm installs - devnet
  // suites, CLI test fixtures - must keep the full profile.
  const { packages: globs } = parse(fs.readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8'));
  const directories = globs.flatMap((glob) => (glob.endsWith('/*')
    ? fs.readdirSync(path.join(REPO_ROOT, glob.slice(0, -2)), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${glob.slice(0, -2)}/${entry.name}`)
    : [glob]));
  let checked = 0;
  for (const directory of directories) {
    const manifest = `${directory}/package.json`;
    if (!fs.existsSync(path.join(REPO_ROOT, manifest)) || Object.hasOwn(WORKSPACE_RULES, directory)) continue;
    assert.equal(pullRequestPlan([change(manifest)]).mode, 'full', manifest);
    checked++;
  }
  assert.ok(checked >= 3, 'devnet suites and CLI fixtures are checked');
  assert.match(
    pullRequestPlan([change('packages/cli/test-fixtures/sample-kafka-plugin/package.json')]).reasons[0],
    /^Nested workspace manifest changed/,
  );
});

test('repository support paths route to the lanes that execute them', () => {
  for (const [filePath, expected] of [
    ['devnet/rfc64-gate1-public-open/run.ts', ['tornado_blazegraph', 'tornado_agent']],
    ['devnet/rfc64-persistence-lifecycle/run.ts', ['tornado_blazegraph', 'tornado_agent']],
    ['devnet/_bootstrap/rfc64-evidence.test.ts', ['tornado_blazegraph', 'tornado_agent']],
    ['devnet/rfc64-runtime-provenance.mts', ['tornado_blazegraph', 'tornado_agent', 'bura_cli']],
    ['devnet/rfc64-cp2-private-swm-vm-recovery/batch-plan.ts', ['tornado_blazegraph', 'tornado_agent', 'bura_cli']],
    ['devnet/suites.json', ['tornado_blazegraph', 'tornado_agent']],
    ['test-systems/storage-conformance.test.ts', ['tornado_blazegraph']],
    ['devnet/v10-stress/automated.test.ts', ['tornado_blazegraph', 'tornado_agent']],
    ['devnet/rfc64-gate2-multi-asset-completeness/runtime-load-hook.ts', ['tornado_blazegraph', 'tornado_agent', 'bura_cli']],
    ['devnet/rfc64-gate2-multi-asset-completeness/adapter-process.ts', ['tornado_blazegraph', 'tornado_agent', 'bura_cli']],
    ['bench/publish-async-get.bench.ts', ['bura_cli']],
    ['tools/observability/lib/w1.mjs', []],
    // Repository scripts outside CI tooling, by who runs them: the build job
    // runs the audit scripts and their tests; devnet suites and operator
    // tools run by hand; the CLI smoke test runs the publish helpers. Any
    // other script plans full CI (ci-delta.test.mjs).
    ['scripts/audit-dial-protocol.mjs', []],
    ['scripts/check-npm-metadata.mjs', []],
    ['scripts/devnet-test-invite-flow.sh', []],
    ['scripts/import-ontology.mjs', []],
    ['scripts/repro/wm-persistence-regression.mjs', []],
    ['scripts/devnet-publish-helpers.sh', ['bura_cli']],
    // The chain lane runs the ABI sync script (sync-chain-abis.unit.test.ts).
    ['scripts/sync-chain-abis.mjs', ['tornado_core']],
    ['scripts/devnet.sh', ['tornado_blazegraph', 'tornado_agent', 'bura_cli', 'kosava_node_ui_e2e']],
    ['scripts/lib/__tests__/devnet-curated-join-helpers.test.mjs', []],
    ['test-policy/disabled-tests.json', []],
    ['.github/oxlint-baseline.json', []],
    ['.github/CODEOWNERS', []],
    ['.github/PULL_REQUEST_TEMPLATE.md', []],
    ['.github/dependabot.yml', []],
    ['.github/workflows/knip.yml', []],
  ]) {
    const plan = pullRequestPlan([change(filePath)]);
    assert.equal(plan.mode, 'delta', filePath);
    assert.equal(needsSharedBuild(plan), true, `${filePath} still needs the shared build checks`);
    assert.deepEqual(selectedLanes(plan), expected, filePath);
    assert.deepEqual(plan.evmScopes, [], filePath);
  }
});

// The daemon runtime the browser suite boots (scripts/devnet.sh) outside its
// UI surface and harness: on a pull request each runs its own lanes and the
// CLI daemon tests, and the browser suite follows after merge.
const BROWSER_SUITE_DEFERRED = [
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
];

test('the browser suite follows the UI surface and the packages its harness compiles against', () => {
  // UI surface: node-ui, its graph-viz dependency and the daemon HTTP API in
  // cli. Harness: the workspaces packages/node-ui/e2e imports, with their
  // dependencies.
  const uiSurface = ['packages/cli', 'packages/graph-viz', 'packages/node-ui'];
  const harness = importedWorkspaceClosure(sourceFiles('packages/node-ui/e2e'));
  assert.ok(harness.has('packages/core'), 'the e2e helpers import dkg-core');
  const triggers = new Set([...uiSurface, ...harness]);
  for (const [workspace, rule] of Object.entries(WORKSPACE_RULES)) {
    if (rule.forceFull) continue;
    assert.equal(rule.lanes.includes('kosava_node_ui_e2e'), triggers.has(workspace), workspace);
  }

  // The deliberate exception: the rest of the runtime scripts/devnet.sh boots
  // (the workspaces it starts and their dependencies). On the PR each runs its
  // own lanes and bura_cli's daemon tests; the browser suite follows after
  // merge. A new runtime dependency fails here until it is a trigger or listed.
  const devnet = fs.readFileSync(path.join(REPO_ROOT, 'scripts/devnet.sh'), 'utf8');
  const booted = workspaceClosure([...devnet.matchAll(/\$REPO_ROOT\/(packages\/[a-z0-9-]+)\//g)].map(([, workspace]) => workspace));
  assert.ok(booted.has('packages/agent'), 'the devnet daemons run the agent');
  const deferred = [...booted].filter((workspace) => !triggers.has(workspace) && !WORKSPACE_RULES[workspace].forceFull).sort();
  assert.deepEqual(deferred, BROWSER_SUITE_DEFERRED);
  for (const workspace of deferred) {
    const plan = pullRequestPlan([change(`${workspace}/src/index.ts`)]);
    assert.equal(plan.lanes.kosava_node_ui_e2e, false, workspace);
    assert.equal(plan.lanes.bura_cli, true, `${workspace} keeps the CLI daemon tests on the PR`);
  }
  for (const filePath of ['packages/node-ui/src/ui/pages/Dashboard.tsx', 'packages/cli/src/daemon/routes/context.ts', 'packages/core/src/constants.ts']) {
    assert.equal(pullRequestPlan([change(filePath)]).lanes.kosava_node_ui_e2e, true, filePath);
  }
  // Protected pushes, merge-queue candidates, nightly runs and `ci:full` keep it.
  for (const plan of [planCi({ eventName: 'push' }), pullRequestPlan([change('packages/agent/src/agent.ts')], { labels: ['ci:full'] })]) {
    assert.equal(plan.lanes.kosava_node_ui_e2e, true);
  }
});

test('the Windows lifecycle job follows the agent lane, which covers the closure its harnesses load', () => {
  // The Windows job runs the SQLite persistence suites and the RFC-64 Gate 0
  // and evidence harnesses, which start a real agent and run on no Linux
  // lane. ci.yml starts it on the agent lane's output and the gate requires it
  // with that lane, so every plan that runs the agent lane runs it too.
  const { jobs } = parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
  const windowsLane = jobLane('inventory-windows', jobs['inventory-windows'].if);
  assert.equal(windowsLane, 'tornado_agent');
  const windowsSelected = (filePath) => pullRequestPlan([change(filePath)]).lanes[windowsLane];

  // Derive the closure from what the harnesses actually import, so a new
  // import or dependency cannot silently drop the job.
  const closure = importedWorkspaceClosure([
    ...sourceFiles('devnet/rfc64-persistence-lifecycle'),
    ...sourceFiles('devnet/_bootstrap').filter((file) => path.posix.basename(file).startsWith('rfc64-evidence')),
  ]);
  assert.ok(closure.has('packages/agent'), 'the Gate 0 harness starts a real agent');
  for (const workspace of closure) {
    assert.ok(windowsSelected(`${workspace}/src/index.ts`), workspace);
  }

  // The Windows workflow's own push filter names the same packages.
  const windowsWorkflow = parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/rfc64-inventory-windows.yml'), 'utf8'));
  for (const filter of windowsWorkflow.on.push.paths) {
    const workspace = filter.match(/^(packages\/[^/]+)\/\*\*$/)?.[1];
    if (workspace) assert.ok(windowsSelected(`${workspace}/src/index.ts`), filter);
  }

  // Modules the harness loads, new or renamed persistence modules, the
  // harnesses themselves and every suite the job runs all keep the job;
  // unrelated workspaces do not.
  for (const filePath of [
    'packages/agent/src/finalization-recovery-worker.ts',
    'packages/agent/src/rfc64/journal-store-v1.ts',
    'packages/agent/src/finalization-recovery-sqlite-store-v2.ts',
    'packages/storage/src/oxigraph-store.ts',
    'packages/core/src/index.ts',
    'devnet/rfc64-persistence-lifecycle/verify.ts',
    'devnet/_bootstrap/rfc64-evidence.ts',
  ]) {
    assert.equal(windowsSelected(filePath), true, filePath);
  }
  const selectors = windowsWorkflow.jobs['inventory-lifecycle'].strategy.matrix.include
    .flatMap((group) => group.tests.trim().split(/\s+/));
  const agentTests = fs.readdirSync(path.join(REPO_ROOT, 'packages/agent/test'));
  for (const selector of selectors) {
    const matches = agentTests.filter((file) => `test/${file}`.startsWith(selector));
    assert.ok(matches.length > 0, `${selector} matches no agent test`);
    for (const file of matches) {
      assert.equal(windowsSelected(`packages/agent/test/${file}`), true, file);
    }
  }
  for (const filePath of ['packages/node-ui/src/ui/pages/Dashboard.tsx', 'packages/network-sim/src/index.ts']) {
    assert.equal(windowsSelected(filePath), false, filePath);
  }

  // The gate requires the job whenever the plan selects the agent lane.
  const persistence = pullRequestPlan([change('packages/agent/src/sqlite/owned-sqlite-v1.ts')]);
  const needs = gateNeeds(succeeded(
    'build',
    'evm-node-test-artifacts',
    'inventory-windows',
    selectedLanes(persistence).map((lane) => PRIMARY_LANE_JOBS[lane]),
  ));
  assert.deepEqual(validatePrimaryResults({ eventName: 'pull_request', plan: persistence, needs }), []);
  needs['inventory-windows'].result = 'skipped';
  assert.match(
    validatePrimaryResults({ eventName: 'pull_request', plan: persistence, needs }).join('\n'),
    /inventory-windows was selected but ended with skipped/,
  );

  // The Gate 0 harness selects the agent lane, whose code imports its
  // evidence helpers, and Blazegraph (the Gate 1 rollout tests load its
  // process lifecycle), plus the shared build checks; full plans always
  // include the lane.
  const harness = pullRequestPlan([change('devnet/rfc64-persistence-lifecycle/verify.ts')]);
  assert.deepEqual(selectedLanes(harness), ['tornado_blazegraph', 'tornado_agent']);
  assert.equal(needsSharedBuild(harness), true);
  assert.equal(planCi({ eventName: 'push' }).lanes[windowsLane], true);
});

test('each changed path gets one routing decision with a fixed precedence', () => {
  // 1. Global CI inputs, and the fail-closed entries that open the support
  // table, keep full CI with a reason naming what they are.
  for (const [filePath, reason] of [
    ['scripts/ci/plan-ci.mjs', 'Global CI input changed'],
    ['.github/workflows/rfc64-inventory-windows.yml', 'CI control-plane workflow changed'],
    ['.github/workflows/nested/policy.yml', 'Unrecognised path under .github/workflows'],
    ['.github/actions/upload-vitest-junit/action.yml', 'Composite action used by CI jobs changed'],
    ['devnet/v10-stress/package.json', 'Devnet workspace manifest changed'],
  ]) {
    const plan = pullRequestPlan([change(filePath)]);
    assert.equal(plan.mode, 'full', filePath);
    assert.equal(plan.reasons[0], `${reason}: ${filePath}`);
  }
  // 2. A workspace wins over a support area with the same path shape.
  const agentDevnet = pullRequestPlan([change('packages/agent/devnet/rfc64-private-catalog/run.mjs')]);
  assert.deepEqual(selectedLanes(agentDevnet), selectedLanes(pullRequestPlan([change('packages/agent/src/agent.ts')])));
  assert.equal(agentDevnet.buildChecks, false);
  // 3. Support areas declare the shared build checks explicitly.
  for (const filePath of ['.github/CODEOWNERS', 'tools/observability/lib/w1.mjs']) {
    const plan = pullRequestPlan([change(filePath)]);
    assert.equal(plan.mode, 'delta', filePath);
    assert.equal(plan.buildChecks, true, filePath);
    assert.deepEqual(selectedLanes(plan), [], filePath);
  }
  // 4. A path claimed only by a trigger is routed by it alone.
  const imageContract = pullRequestPlan([change('blazegraph-image.json')]);
  assert.deepEqual(selectedLanes(imageContract), ['bura_cli', 'bura_blazegraph_arm64']);
  assert.equal(imageContract.buildChecks, false);
  // 5. Everything else fails closed.
  assert.match(pullRequestPlan([change('new-root-tool.ts')]).reasons[0], /^Unclassified path changed/);
});

// Module loads computed and script paths assembled at run time that the
// load-closure guard cannot follow, each with the reason it needs no route of
// its own.
const UNFOLLOWED_LOADS = new Map([
  ['packages/agent/src/generic-sql-source.ts: moduleName', 'the optional mssql driver and node:sqlite, neither a repository file'],
  ['packages/agent/src/sqlite/module-loader-v1.ts: name', 'node:sqlite, the default loader, not a repository file'],
  ['packages/agent/test/generic-sql-source.test.ts: moduleName', 'node:sqlite, not a repository file'],
  ['packages/chain/src/evm-adapter-abi.ts: `@origintrail-official/dkg-evm-module/abi/${contractName}.json`',
    'an evm-module ABI, and every evm-module change runs full CI'],
  ['packages/cli/blazegraph-image-metadata.cjs: candidate',
    'one of the resolve(__dirname, ...) copies of blazegraph-namespace-contract.cjs, which the guard reads as paths'],
  ['packages/cli/src/daemon/plugin-loader.ts: pathToFileURL(spec).href', 'a plugin named in the daemon configuration'],
  ['packages/cli/src/daemon/plugin-loader.ts: pathToFileURL(resolved).href', 'a plugin named in the daemon configuration'],
  ['packages/cli/src/daemon/plugin-loader.ts: spec', 'a plugin named in the daemon configuration'],
  ['packages/cli/src/source-worker-runner.ts: pathToFileURL(config.handlerModule).href',
    'a handler module named in the source-worker configuration'],
  ['packages/cli/test/blazegraph-image-metadata.test.ts: parserPath', "the CLI's own blazegraph-image-metadata.cjs"],
  ['packages/mcp-dkg/src/adapters.ts: pkg', 'a third-party adapter package named at run time; ADAPTER_MAP names no workspace'],
  ['packages/adapter-openclaw/test/openclaw-entry.test.ts: href', 'a module the test writes to a temporary directory'],
]);

// What the load-closure guard reports for a trace: each load whose file does
// not select the requirement that reaches it, and each module load computed
// or script path assembled at run time that UNFOLLOWED_LOADS does not
// explain. The requirements (lane-entrypoints.mjs):
// - a lane or `evm:<scope>` that loads the file;
// - `build`: the shared build job's own checks run it;
// - `full`: every job runs it (an install hook), or a job outside the lanes;
// - `build-output:<workspace>`: that workspace's build or pack runs it, and
//   every lane restores the output. A repository file needs full CI; a file
//   in a package workspace must select every lane and scope the producing
//   workspace's rule selects, except the browser suite for the runtime it
//   follows after merge (BROWSER_SUITE_DEFERRED).
// `plan(file)` plans a change to one file.
function loadClosureGaps({ loaded, unfollowed }, { plan = (file) => pullRequestPlan([change(file)]) } = {}) {
  const workspaceOf = (file) => Object.keys(WORKSPACE_RULES).find((workspace) => file.startsWith(`${workspace}/`));
  const coversBuildOutput = (target, targetPlan, producer) => {
    const workspace = workspaceOf(target);
    if (!workspace) return false;
    const { lanes, evmScopes } = WORKSPACE_RULES[producer];
    return lanes.every((lane) => targetPlan.lanes[lane] || (lane === 'kosava_node_ui_e2e' && BROWSER_SUITE_DEFERRED.includes(workspace)))
      && evmScopes.every((scope) => targetPlan.evmScopes.includes(scope));
  };
  const missing = [];
  for (const [target, requirements] of loaded) {
    const targetPlan = plan(target);
    if (targetPlan.mode === 'full') continue;
    for (const [requirement, via] of requirements) {
      const selected = requirement === 'full' ? false
        : requirement === 'build' ? needsSharedBuild(targetPlan)
        : requirement.startsWith('build-output:') ? coversBuildOutput(target, targetPlan, requirement.slice('build-output:'.length))
        : requirement.startsWith('evm:') ? targetPlan.evmScopes.includes(requirement.slice(4))
        : targetPlan.lanes[requirement];
      if (!selected) missing.push(`${requirement} loads ${target} via ${via}`);
    }
  }
  const computed = [...new Set([...unfollowed].flatMap(([file, specifiers]) => specifiers.map((specifier) => `${file}: ${specifier}`)))];
  return { missing, unexplained: computed.filter((entry) => !UNFOLLOWED_LOADS.has(entry)), computed };
}

test('every file a lane runs, or loads by relative path, selects that lane', () => {
  // Seeds: what CI executes (laneSeeds in lane-entrypoints.mjs) - each
  // lane's workspace code and tests, the support files its job commands
  // name, and the repository scripts the workspace scripts CI runs name.
  // What those files load comes from traceLaneLoads and dependenciesOf in
  // load-graph.mjs, which list the forms they follow. Each file reached must
  // select the lane or scope that loads it, or plan full CI.
  const trace = traceLaneLoads(laneSeeds());
  const loadedBy = trace.loaded;

  for (const [target, requirement, why] of [
    ['packages/query/README.md', 'bura_query', 'the query security tests read the README'],
    ['packages/cli/src/extraction/markdown-extractor.ts', 'tornado_agent', 'agent tests import CLI source'],
    ['packages/cli/src/daemon.ts', 'kosava_node_ui', 'node-ui tests scan the CLI daemon sources'],
    ['packages/agent/src/dkg-agent-join.ts', 'tornado_core', 'the chain RPC-site census reads agent sources'],
    ['devnet/rfc64-runtime-provenance.mts', 'bura_cli', 'the CLI-started Gate 2 adapter imports the shared runtime modules'],
    ['devnet/rfc64-persistence-lifecycle/process-lifecycle.ts', 'tornado_blazegraph', 'the Blazegraph job runs the Gate 1 rollout tests'],
    ['test-systems/storage-conformance.test.ts', 'tornado_blazegraph', 'pnpm test:conformance runs in the Blazegraph job'],
    ['devnet/rfc64-persistence-lifecycle/verify.ts', 'tornado_agent', 'the reusable Windows workflow, run on the agent lane, runs the Gate 0 harness'],
    ['scripts/devnet.sh', 'bura_cli', 'the CLI Blazegraph smoke fixture sources the devnet bootstrap'],
    ['scripts/copy-cli-runtime-assets.mjs', 'build-output:packages/cli', 'the CLI build copies its runtime assets into the build output every lane restores'],
    ['packages/cli/scripts/verify-node-sqlite-runtime.mjs', 'full', "every job's install runs the root and CLI preinstall hooks"],
    ['packages/cli/markitdown-build-info.json', 'full', "every job's install runs the CLI postinstall, which reads it"],
  ]) {
    assert.ok(loadedBy.get(target)?.has(requirement), why);
  }
  // The ABI sync route rests on a chain test that runs the script, not on the
  // vendored-ABI test's hint that names it.
  const syncTest = 'packages/chain/test/sync-chain-abis.unit.test.ts';
  assert.ok(loadReferences(syncTest, fs.readFileSync(path.join(REPO_ROOT, syncTest), 'utf8')).paths.includes('scripts/sync-chain-abis.mjs'));
  // Every file INSTALL_HOOK_INPUTS routes to full CI is still one an install
  // hook reaches; the gap check below finds any it misses.
  assert.deepEqual(INSTALL_HOOK_INPUTS.filter((file) => !loadedBy.get(file)?.has('full')), [], 'stale INSTALL_HOOK_INPUTS entries');
  const { missing, unexplained, computed } = loadClosureGaps(trace);
  assert.deepEqual(missing, [], 'a change to these files must select the lane or EVM scope that loads them');
  // A load the trace cannot follow fails closed until it is listed with the
  // reason it needs no route, and a listed load that is gone is dropped.
  assert.deepEqual(unexplained, [], 'list each computed load in UNFOLLOWED_LOADS with why it needs no route');
  assert.deepEqual([...UNFOLLOWED_LOADS.keys()].filter((entry) => !computed.includes(entry)), [], 'stale UNFOLLOWED_LOADS entries');
});

// The load-closure gaps for what a planted ci.yml runs (laneSeeds from the
// execution graph, without the workspace code), through the same trace and
// check as the repository's own workflows.
function plantedWorkflowGaps(workflowSource, options = {}) {
  const seeds = laneSeeds({ workflows: [['ci.yml', workflowSource]], workspaceCode: false, ...options });
  return { seeds, ...loadClosureGaps(traceLaneLoads(seeds), options) };
}

test('every repository script a CI job runs selects that job', () => {
  // The repository's workflows are checked by the guard above, which seeds
  // what each job runs from the execution graph. Its failure path: a lane job
  // running a script routed to the build checks alone is reported; a script
  // routed to that lane is not, however its path is spelled; the changes job
  // runs on every pull request.
  const planted = (job, run) => `jobs:\n  ${job}:\n    if: needs.changes.outputs.bura_cli == 'true'\n    steps:\n      - run: ${run}\n`;
  // The trace follows the script's own imports too.
  assert.deepEqual(plantedWorkflowGaps(planted('bura-cli', 'node scripts/audit-dial-protocol.mjs')).missing, [
    'bura_cli loads scripts/audit-dial-protocol.mjs via ci.yml bura-cli',
    'bura_cli loads scripts/audit-create-random.mjs via scripts/audit-dial-protocol.mjs',
  ]);
  assert.deepEqual(plantedWorkflowGaps(planted('bura-cli', 'bash "$GITHUB_WORKSPACE/scripts/devnet-publish-helpers.sh"')).missing, []);
  assert.equal(jobRequirement('ci.yml', 'changes', ''), undefined);
  assert.equal(jobRequirement('ci.yml', 'build', "needs.changes.outputs.run_node == 'true'"), 'build');
  assert.equal(jobRequirement('evm-integration.yml', 'evm-integration', "needs.plan.outputs.evm_matrix != '[]'"), 'full');
});

test('one execution graph feeds the seeds and the gap check, direct and indirect runs alike', () => {
  // The build job runs one repository script directly and packs the CLI
  // through release-packages.mjs (COMMAND_EFFECTS), whose prepack runs the
  // asset copier. Both reach the seeds through the graph, and a plan that
  // drops either from its requirement is reported.
  const cli = { name: '@origintrail-official/dkg', scripts: { prepack: 'node ../../scripts/copy-cli-runtime-assets.mjs' } };
  const execution = {
    workspaces: { manifests: new Map([['packages/cli', cli]]), workspaceByName: new Map([[cli.name, 'packages/cli']]) },
    rootManifest: { scripts: { 'release:verify-pack': 'node scripts/release-packages.mjs verify-pack' } },
  };
  const workflow = [
    'jobs:',
    '  build:',
    "    if: needs.changes.outputs.run_node == 'true'",
    '    steps:',
    '      - run: node scripts/audit-dial-protocol.mjs',
    '      - run: pnpm release:verify-pack',
  ].join('\n');
  const [build] = workflowExecution(workflow, execution);
  assert.deepEqual(build.edges.filter(({ kind }) => kind === 'script').map(({ workspace, script }) => `${workspace} ${script}`), [
    '. release:verify-pack',
    'packages/cli prepack',
  ]);
  const { seeds, missing } = plantedWorkflowGaps(workflow, { execution });
  assert.equal(seeds.get('scripts/audit-dial-protocol.mjs')?.has('build'), true);
  assert.equal(seeds.get('scripts/copy-cli-runtime-assets.mjs')?.has('build-output:packages/cli'), true);
  assert.deepEqual(missing, []);
  // A docs-only plan runs neither the build nor anything else.
  const nothing = () => pullRequestPlan([change('docs/ci-delta-policy.md')]);
  const undocumented = plantedWorkflowGaps(workflow, { execution, plan: nothing }).missing;
  for (const gap of [
    'build loads scripts/audit-dial-protocol.mjs via ci.yml build',
    'build-output:packages/cli loads scripts/copy-cli-runtime-assets.mjs via ci.yml build > release:verify-pack > packages/cli prepack',
  ]) {
    assert.ok(undocumented.includes(gap), gap);
  }
  // Each program COMMAND_EFFECTS reads still runs what it declares.
  for (const { evidence } of COMMAND_EFFECTS) {
    assert.ok(fs.readFileSync(path.join(REPO_ROOT, evidence.file), 'utf8').includes(evidence.text), evidence.file);
  }
});

test('the load-closure guard reports a planted unrouted load and an unlisted computed load', () => {
  // The guard's detection, not only its current pass: a query-lane test that
  // imports agent source (agent changes do not select the query lane) and
  // computes another import at run time must be reported on both counts.
  const planted = 'packages/query/test/planted.test.ts';
  const sources = new Map([[planted, [
    "import { DKGAgent } from '../../agent/src/dkg-agent.js';",
    'const late = await import(`../../cli/src/${name}.js`);',
  ].join('\n')]]);
  const trace = traceLaneLoads(new Map([[planted, new Map([['bura_query', 'seed']])]]), { read: (file) => sources.get(file) });
  const { missing, unexplained } = loadClosureGaps(trace);
  assert.deepEqual(missing, [`bura_query loads packages/agent/src/dkg-agent.ts via ${planted}`]);
  assert.deepEqual(unexplained, [`${planted}: \`../../cli/src/\${name}.js\``]);
});

// The package scripts a workflow runs, as '<requirement> <workspace> <script>'.
function scriptRuns(workflows, execution) {
  return [...new Set(workflows.flatMap(([workflow, source]) => workflowExecution(source, execution)
    .flatMap(({ job, condition, edges }) => edges
      .filter(({ kind }) => kind === 'script')
      .map(({ workspace, script, chain }) => `${edgeRequirement(jobRequirement(workflow, job, condition), chain)} ${workspace} ${script}`))))].sort();
}

test('workspace scripts count where CI runs them, not because their workspace owns a lane', () => {
  // A manual script in a lane-owning workspace is no lane input; a job
  // command that runs it adds that job's lane. The shared build runs every
  // workspace's build (turbo build) for the output every lane restores, so
  // what a build runs carries that workspace's build output; an install hook
  // runs in every job. A workspace script's paths resolve from its own
  // directory.
  const cli = {
    name: '@origintrail-official/dkg',
    scripts: {
      preinstall: 'node ./scripts/verify-node-sqlite-runtime.mjs',
      build: 'pnpm run build:prepared',
      'build:prepared': 'tsc && node scripts/build-prerequisites.mjs && node ../../scripts/copy-cli-runtime-assets.mjs',
      'release:dry-run': 'node ../../scripts/release-helper.mjs',
    },
  };
  const execution = { workspaces: { manifests: new Map([['packages/cli', cli]]), workspaceByName: new Map([[cli.name, 'packages/cli']]) }, rootManifest: {} };
  const workflow = (laneCommand) => [['ci.yml', [
    'jobs:',
    '  build:',
    "    if: needs.changes.outputs.run_node == 'true'",
    '    steps:',
    '      - run: pnpm install --frozen-lockfile && turbo build',
    '  bura-cli:',
    "    if: needs.changes.outputs.bura_cli == 'true'",
    '    steps:',
    `      - run: ${laneCommand}`,
  ].join('\n')]];
  const shared = ['build-output:packages/cli packages/cli build', 'build-output:packages/cli packages/cli build:prepared', 'full packages/cli preinstall'];
  assert.deepEqual(scriptRuns(workflow('pnpm install --frozen-lockfile'), execution), shared);
  assert.deepEqual(scriptRuns(workflow("pnpm --filter '@origintrail-official/dkg' run release:dry-run"), execution), [...shared, 'bura_cli packages/cli release:dry-run'].sort());
  // A filter the graph cannot resolve fails instead of hiding what runs.
  assert.throws(() => scriptRuns(workflow('pnpm --filter "[origin/main]" run build'), execution), /unsupported pnpm filter selector/);
  const [build] = workflowExecution(workflow('echo ok')[0][1], execution);
  assert.deepEqual([...new Set(build.edges.filter(({ kind }) => kind === 'file').map(({ file }) => file))], [
    'packages/cli/scripts/verify-node-sqlite-runtime.mjs',
    'packages/cli/scripts/build-prerequisites.mjs',
    'scripts/copy-cli-runtime-assets.mjs',
  ]);

  // The repository's own: the CLI build and pack run the asset copier, and
  // lane jobs run the node-ui UI build and the demo and Hermes suites.
  const real = new Set(scriptRuns(['ci.yml', 'evm-integration.yml'].map((workflow) => [
    workflow,
    fs.readFileSync(path.join(REPO_ROOT, '.github/workflows', workflow), 'utf8'),
  ])));
  for (const run of [
    'build-output:packages/cli packages/cli build:prepared',
    'build-output:packages/cli packages/cli prepack',
    'full packages/cli postinstall',
    'full . preinstall',
    'kosava_node_ui packages/node-ui build:ui',
    'kosava_supporting demo test',
    'kosava_supporting packages/adapter-hermes test:py',
  ]) {
    assert.ok(real.has(run), run);
  }
});

test('pnpm filter selectors resolve on the injected workspace graph alone', () => {
  // a depends on b, c on a; d stands apart. None of these names exists in the
  // repository, so its manifests cannot take part.
  const manifest = (name, dependencies = {}) => ({ name, dependencies, scripts: { build: 'tsc' } });
  const manifests = new Map([
    ['packages/a', manifest('fixture-a', { 'fixture-b': 'workspace:*' })],
    ['packages/b', manifest('fixture-b')],
    ['packages/c', manifest('fixture-c', { 'fixture-a': 'workspace:*' })],
    ['packages/d', manifest('fixture-d')],
  ]);
  const workspaces = { manifests, workspaceByName: new Map([...manifests].map(([directory, { name }]) => [name, directory])) };
  const built = (selector) => workflowExecution(`jobs:\n  bura-cli:\n    steps:\n      - run: pnpm --filter '${selector}' run build\n`, {
    workspaces,
    rootManifest: {},
  })[0].edges.filter(({ kind }) => kind === 'script').map(({ workspace }) => workspace).sort();
  assert.deepEqual(built('fixture-a...'), ['packages/a', 'packages/b']);
  assert.deepEqual(built('...fixture-b'), ['packages/a', 'packages/b', 'packages/c']);
  assert.deepEqual(built('!fixture-d'), ['packages/a', 'packages/b', 'packages/c']);
  assert.deepEqual(built('fixture-*'), ['packages/a', 'packages/b', 'packages/c', 'packages/d']);
});

test('the load-closure guard holds install hooks to full CI and builds to their output', () => {
  // What every job's install runs needs full CI, the CLI preinstall's own
  // script included, though it lives in the CLI workspace: a plan routing it
  // by the CLI rule, as before, is reported.
  const preinstall = 'packages/cli/scripts/verify-node-sqlite-runtime.mjs';
  const seeds = laneSeeds({ workspaceCode: false });
  assert.match(seeds.get(preinstall)?.get('full') ?? '', /> preinstall$/);
  assert.equal(pullRequestPlan([change(preinstall)]).mode, 'full');
  const installed = { loaded: new Map([[preinstall, new Map([['full', 'ci.yml build > preinstall']])]]), unfollowed: new Map() };
  assert.deepEqual(loadClosureGaps(installed).missing, []);
  const byWorkspace = (file) => pullRequestPlan([change(file === preinstall ? 'packages/cli/src/cli.ts' : file)]);
  assert.deepEqual(loadClosureGaps(installed, { plan: byWorkspace }).missing, [`full loads ${preinstall} via ci.yml build > preinstall`]);

  // What the CLI build runs carries the CLI's build output: the asset copier,
  // a repository file, needs full CI, so routing it to the CLI lane alone is
  // reported. A workspace file it loads must select the CLI rule's lanes,
  // except the browser suite for the runtime that suite follows after merge.
  const copier = 'scripts/copy-cli-runtime-assets.mjs';
  const output = 'build-output:packages/cli';
  const built = {
    loaded: new Map([
      [copier, new Map([[output, 'packages/cli build:prepared']])],
      ['packages/cli/blazegraph-image-metadata.cjs', new Map([[output, copier]])],
      ['packages/storage/blazegraph-namespace-contract.cjs', new Map([[output, 'packages/cli/blazegraph-image-metadata.cjs']])],
    ]),
    unfollowed: new Map(),
  };
  assert.equal(pullRequestPlan([change('packages/storage/blazegraph-namespace-contract.cjs')]).lanes.kosava_node_ui_e2e, false);
  assert.deepEqual(loadClosureGaps(built).missing, []);
  const narrowed = (file) => pullRequestPlan([change(file === copier ? 'scripts/devnet-publish-helpers.sh' : file)]);
  assert.deepEqual(selectedLanes(narrowed(copier)), ['bura_cli']);
  assert.deepEqual(loadClosureGaps(built, { plan: narrowed }).missing, [`${output} loads ${copier} via packages/cli build:prepared`]);
  // Outside the deferred runtime, a workspace must select every CLI lane.
  const graphViz = 'packages/graph-viz/src/index.ts';
  const withoutBrowser = (file) => {
    const plan = pullRequestPlan([change(file)]);
    return file === graphViz ? { ...plan, lanes: { ...plan.lanes, kosava_node_ui_e2e: false } } : plan;
  };
  const viz = { loaded: new Map([[graphViz, new Map([[output, copier]])]]), unfollowed: new Map() };
  assert.deepEqual(loadClosureGaps(viz).missing, []);
  assert.deepEqual(loadClosureGaps(viz, { plan: withoutBrowser }).missing, [`${output} loads ${graphViz} via ${copier}`]);
});

test('a script path a lane assembles at run time fails the guard until it is listed', () => {
  // The wildcard families route a new devnet-* script to the build checks
  // alone, so a lane reaching one through a path it builds at run time would
  // skip itself; the guard reports every such construction it reaches.
  assert.deepEqual(selectedLanes(pullRequestPlan([change('scripts/devnet-new-helper.sh')])), []);
  const planted = 'packages/cli/test/planted.test.ts';
  const fixture = 'packages/cli/test/fixtures/devnet-blazegraph-smoke.sh';
  const sources = new Map([
    [planted, [
      "import { join } from 'node:path';",
      `spawnSync('bash', ['${fixture}']);`,
      "spawnSync('bash', [join(process.cwd(), 'scripts', helper)]);",
    ].join('\n')],
    [fixture, 'helper=new-helper\nsource "$SCRIPT_DIR/devnet-${helper}.sh"\n'],
  ]);
  const trace = traceLaneLoads(new Map([[planted, new Map([['bura_cli', 'seed']])]]), { read: (file) => sources.get(file) });
  assert.deepEqual(loadClosureGaps(trace).unexplained.sort(), [
    `${fixture}: $SCRIPT_DIR/devnet-\${helper}.sh`,
    `${planted}: join(process.cwd(), 'scripts', helper)`,
  ]);
});

test('each repository-script route and build-only entry is the first match for a script that exists', () => {
  // A family entry whose scripts are gone must go, rather than wait to match
  // a new script by accident.
  const files = (directory) => fs.readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.name === 'node_modules') return [];
    return entry.isDirectory() ? files(relative) : [relative];
  });
  const scripts = files('scripts');
  const firstRoute = (file) => SUPPORT_PATH_ROUTES.find(({ pattern }) => pattern.test(file));
  const routes = SUPPORT_PATH_ROUTES.filter(({ pattern }) => pattern.source.startsWith('^scripts'));
  assert.ok(routes.length >= 8);
  for (const route of routes) {
    assert.ok(scripts.some((file) => firstRoute(file) === route), `${route.pattern} is the first match for no script`);
  }
  for (const family of BUILD_ONLY_SCRIPTS) {
    const route = routes.find(({ reason }) => reason === family.reason);
    for (const name of family.files ?? []) {
      assert.equal(firstRoute(`scripts/${name}`), route, `scripts/${name} must exist and route by its family`);
      assert.ok(scripts.includes(`scripts/${name}`), `scripts/${name} is declared but missing`);
    }
    for (const entry of [
      ...(family.prefixes ?? []).map((prefix) => ({ prefixes: [prefix] })),
      ...(family.directories ?? []).map((directory) => ({ directories: [directory] })),
    ]) {
      const pattern = scriptsPattern(entry);
      assert.ok(scripts.some((file) => pattern.test(file) && firstRoute(file) === route), `${pattern} is the first route for no script`);
    }
  }
});

test('owning lanes and scopes cover every job that runs the workspace', () => {
  // The guard above seeds each workspace's files with its owning lanes, so
  // those are checked here against what CI executes, not against the routing
  // tables: the Vitest topology the lane jobs' matrices are compiled from,
  // the workspaces a lane job's steps filter to (such as the Blazegraph job's
  // storage, EPCIS and agent suites) and the workspace each EVM scope's suites
  // live in.
  const missing = [];
  for (const [job, packages] of Object.entries(COVERAGE_JOBS)) {
    const lane = jobLane(job, '');
    for (const name of Object.keys(packages)) {
      if (!WORKSPACE_OWNING_LANES[`packages/${name}`]?.includes(lane)) missing.push(`${lane} runs the packages/${name} Vitest suite`);
    }
  }
  for (const [scope, { packageDirectory }] of Object.entries(EVM_TEST_SCOPES)) {
    if (!WORKSPACE_OWNING_EVM_SCOPES[packageDirectory]?.includes(scope)) missing.push(`evm:${scope} runs ${packageDirectory} suites`);
  }
  // A job that runs a workspace by filter may be selected through an implied
  // lane (the agent lane brings the Blazegraph job), so check the plan.
  const workspaceByName = new Map(Object.keys(WORKSPACE_RULES).map((workspace) => [
    JSON.parse(fs.readFileSync(path.join(REPO_ROOT, workspace, 'package.json'), 'utf8')).name,
    workspace,
  ]));
  const { jobs } = parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
  let filtered = 0;
  for (const [lane, job] of Object.entries(PRIMARY_LANE_JOBS)) {
    const runs = (jobs[job].steps ?? []).map(({ run = '' }) => run).join('\n');
    for (const [, name] of runs.matchAll(/--filter\s+(@origintrail-official\/[\w-]+)/g)) {
      const workspace = workspaceByName.get(name);
      if (!workspace || WORKSPACE_RULES[workspace].forceFull) continue;
      filtered += 1;
      if (!pullRequestPlan([change(`${workspace}/src/index.ts`)]).lanes[lane]) missing.push(`${lane} runs ${workspace} in ${job}`);
    }
  }
  assert.ok(filtered >= 5, 'the lane jobs that filter to a workspace are checked');
  assert.deepEqual(missing, []);
});

test('demo suites stay wired into the supporting job', () => {
  // Demo changes route to the supporting lane, whose job runs both demo apps' suites.
  assert.deepEqual(WORKSPACE_OWNING_LANES.demo, ['kosava_supporting']);
  const { jobs } = parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
  const supportingRuns = jobs[PRIMARY_LANE_JOBS.kosava_supporting].steps.map(({ run = '' }) => run).join('\n');
  assert.ok(supportingRuns.includes('--filter @origintrail-official/dkg-demo'), 'demo tests must stay in CI');
  const demoManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'demo/package.json'), 'utf8'));
  assert.match(demoManifest.scripts.test, /kafka-streams\/test\/\*\.mjs/);
  assert.match(demoManifest.scripts.test, /epcis-bike\/test\/\*\.mjs/);
});

test('the load scanner sees these forms, and nothing it cannot resolve statically', () => {
  // The load-closure guard sees only what loadReferences recognises, so its
  // reach is pinned here: each form below resolves to the named file, and the
  // comment mentions (even one shaped like an import) and the run-time path
  // deliberately resolve to nothing.
  const references = loadReferences('packages/node-ui/test/example.test.ts', [
    "import { api } from '../src/ui/api.js';",
    "import type { RequestContext } from '../../cli/src/daemon/routes/context.js';",
    "const cli = await import('../../cli/src/cli.js');",
    "import { resolveOxigraphBinary } from '../../cli/dist/daemon/oxigraph-binary.js';",
    "const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');",
    "const CLI_SRC = resolve(__dirname, '..', '..', 'cli', 'src');",
    "const barrel = resolve(CLI_SRC, 'daemon.ts');",
    'for (const entry of readdirSync(CLI_SRC)) void entry;',
    "const census = ['packages/agent/src/dkg-agent-join.ts'];",
    '// `packages/cli/src/keystore.ts` is only mentioned here.',
    "// import { retired } from '../src/ui/retired.js';",
    "import { contextGraphDataUri } from '@origintrail-official/dkg-core';",
    'const late = readFileSync(`${root}/${name}`);',
    'const plugin = await import(`../../cli/src/${name}.js`);',
  ].join('\n'));
  assert.deepEqual(references.modules.sort(), [
    'packages/cli/src/cli.ts',
    'packages/cli/src/daemon/oxigraph-binary.ts',
    'packages/node-ui/src/ui/api.ts',
  ]);
  assert.deepEqual(references.paths.sort(), [
    'packages/agent/src/dkg-agent-join.ts',
    'packages/cli/src',
    'packages/cli/src/daemon.ts',
    'packages/node-ui/README.md',
  ]);
  assert.deepEqual(references.packages, ['@origintrail-official/dkg-core']);
  // A repository script named inside a string (a test's embedded shell) counts
  // as read; one named only in a comment does not.
  const shell = loadReferences('packages/cli/test/example.test.ts', [
    '// Runs scripts/devnet-comprehensive.sh by hand.',
    'const script = `tr -d "\\r" < scripts/devnet-publish-helpers.sh > "$DIR/helpers.sh"`;',
  ].join('\n'));
  assert.deepEqual(shell.paths, ['scripts/devnet-publish-helpers.sh']);
  // One matcher finds repository scripts of any extension or none, behind a
  // variable too; callers keep the ones that exist.
  assert.deepEqual(
    repoScriptMentions('python scripts/generate-fixture.py; "$repo_root/scripts/devnet.sh"; ./scripts/tool --x; scripts/nested/run.mts, myscripts/other.sh'),
    ['scripts/generate-fixture.py', 'scripts/devnet.sh', 'scripts/tool', 'scripts/nested/run.mts'],
  );
  const fixture = traceLaneLoads(new Map([['packages/cli/test/example.test.ts', new Map([['bura_cli', 'seed']])]]), {
    read: (file) => ({
      'packages/cli/test/example.test.ts': "spawnSync('bash', ['packages/cli/test/fixtures/devnet-blazegraph-smoke.sh']);",
      'packages/cli/test/fixtures/devnet-blazegraph-smoke.sh': [
        '# scripts/devnet-comprehensive.sh is only mentioned here',
        'source "$repo_root/scripts/devnet.sh"',
      ].join('\n'),
    })[file],
  }).loaded;
  assert.equal(fixture.get('scripts/devnet.sh')?.get('bura_cli'), 'packages/cli/test/fixtures/devnet-blazegraph-smoke.sh');
  assert.equal(fixture.has('scripts/devnet-comprehensive.sh'), false);
  // dependenciesOf reads each format with its own handler. A format without
  // one names nothing: a path in a TOML file, a Python file or an
  // extensionless note is no dependency, while an extensionless file with a
  // shell shebang is read as shell.
  assert.deepEqual(dependenciesOf('packages/cli/test/fixtures/devnet.toml', 'run = "scripts/devnet.sh"'), {
    format: undefined, modules: [], paths: [], packages: [], computed: [], assembled: [],
  });
  assert.deepEqual(dependenciesOf('packages/cli/test/fixtures/runner.py', 'subprocess.run(["scripts/devnet.sh"])').paths, []);
  assert.deepEqual(dependenciesOf('packages/cli/test/fixtures/NOTES', 'Start scripts/devnet.sh first.').paths, []);
  const shebang = dependenciesOf('packages/cli/test/fixtures/start-devnet', '#!/usr/bin/env bash\nsource "$repo_root/scripts/devnet.sh"\n');
  assert.deepEqual([shebang.format, shebang.paths], ['shell', ['scripts/devnet.sh']]);
  // A module load computed at run time cannot be followed, so it is reported.
  assert.deepEqual(references.computed, ['`../../cli/src/${name}.js`']);
  // So is a script path assembled at run time; literal segments joined onto
  // a scripts directory name a script, and a template that completes a path
  // before its value mentions one.
  const scripted = loadReferences('packages/cli/test/example.test.ts', [
    "import { join, resolve as resolvePath } from 'node:path';",
    "const bootstrap = join(root, 'scripts', 'devnet.sh');",
    'const helpers = `bash scripts/devnet-publish-helpers.sh ${flags}`;',
    'const byName = `scripts/${name}.sh`;',
    "const joined = join(process.cwd(), 'scripts', helper);",
    "const aliased = resolvePath(root, '../../scripts', helper);",
    "const added = 'scripts/devnet-' + suffix;",
  ].join('\n'));
  assert.deepEqual(scripted.paths, ['scripts/devnet.sh', 'scripts/devnet-publish-helpers.sh']);
  assert.deepEqual(scripted.assembled, [
    '`scripts/${name}.sh`',
    "join(process.cwd(), 'scripts', helper)",
    "resolvePath(root, '../../scripts', helper)",
    "'scripts/devnet-' + suffix",
  ]);
  // Repo-path literals count only in test files, and a directory only when walked.
  const source = loadReferences('packages/node-ui/src/ui/example.ts', "const note = 'packages/agent/src/dkg-agent-join.ts';\nconst dir = resolve(__dirname, '..');");
  assert.deepEqual(source.paths, []);

  // CommonJS, aliased path helpers, import.meta.dirname and URL-derived bases;
  // a fixture workspace's built output stands for its sources.
  const other = loadReferences('packages/kafka-plugin/test/example.test.ts', [
    "import { join, resolve as resolvePath } from 'node:path';",
    "const { helper } = require('../src/index.js');",
    "const entry = require.resolve('../../cli/src/cli.js');",
    "const CLI_ENTRY = resolvePath(__dirname, '..', '..', 'cli', 'dist', 'cli.js');",
    "const FIXTURE = join(resolvePath(__dirname, '..', '..', 'cli', 'test-fixtures', 'sample-kafka-plugin'), 'dist', 'index.js');",
    "const PLUGIN = resolvePath(__dirname, '..', '..', 'cli', 'test-fixtures', 'sample-kafka-plugin', 'dist', 'index.js');",
    "const RULES = resolve(import.meta.dirname, '..', '..', 'rdf-utils', 'package.json');",
    "const ROOT = fileURLToPath(new URL('../../../', import.meta.url));",
    "const BLAZEGRAPH = join(ROOT, 'blazegraph-image.json');",
    "const MANIFEST = join(\n  import.meta.dirname,\n  '..',\n  'package.json',\n);",
  ].join('\n'));
  assert.deepEqual(other.modules, ['packages/kafka-plugin/src/index.ts']);
  assert.deepEqual(other.paths.sort(), [
    'blazegraph-image.json',
    'packages/cli/src/cli.ts',
    'packages/cli/test-fixtures/sample-kafka-plugin/src/index.ts',
    'packages/kafka-plugin/package.json',
    'packages/rdf-utils/package.json',
  ]);
  // A bare side-effect import loads its module, relative or by package name.
  const sideEffects = loadReferences('packages/storage/test/example.test.ts', [
    "import '../src/adapters/oxigraph.js';",
    "import '@origintrail-official/dkg-core';",
  ].join('\n'));
  assert.deepEqual(sideEffects.modules, ['packages/storage/src/adapters/oxigraph.ts']);
  assert.deepEqual(sideEffects.packages, ['@origintrail-official/dkg-core']);
  // Test-runner configs list the files a lane runs, like tests do.
  const config = loadReferences('devnet/_bootstrap/vitest.example.config.ts', "export default { test: { include: ['devnet/_bootstrap/smoke.test.ts'] } };");
  assert.deepEqual(config.paths, ['devnet/_bootstrap/smoke.test.ts']);
});

test('traceLaneLoads carries lanes through module loads, not through reads', () => {
  const sources = new Map([
    ['packages/node-ui/test/example.test.ts', [
      "import { api } from '../src/ui/api.js';",
      "const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');",
      "import { quads } from '@origintrail-official/dkg-rdf-utils';",
    ].join('\n')],
    ['packages/node-ui/src/ui/api.ts', "import { http } from './http.js';"],
    ['packages/node-ui/src/ui/http.ts', ''],
    // A path read is required but never followed.
    ['packages/node-ui/README.md', "import { never } from './src/ui/pca-api.js';"],
  ]);
  const seeds = new Map([['packages/node-ui/test/example.test.ts', new Map([['kosava_node_ui', 'seed']])]]);
  const { loaded: loads } = traceLaneLoads(seeds, { read: (file) => sources.get(file) });
  assert.equal(loads.get('packages/node-ui/src/ui/api.ts')?.get('kosava_node_ui'), 'packages/node-ui/test/example.test.ts');
  assert.equal(loads.get('packages/node-ui/src/ui/http.ts')?.get('kosava_node_ui'), 'packages/node-ui/src/ui/api.ts');
  assert.equal(loads.get('packages/node-ui/README.md')?.get('kosava_node_ui'), 'packages/node-ui/test/example.test.ts');
  assert.equal(loads.has('packages/node-ui/src/ui/pca-api.ts'), false);
  // A package-name import requires the workspace and its dependencies.
  assert.match(loads.get('packages/rdf-utils/src/index.ts')?.get('kosava_node_ui') ?? '', /imports @origintrail-official\/dkg-rdf-utils/);
});

test('a document a test reads is a CI input; other documentation stays docs-only', () => {
  // PATH_TRIGGERS is the one home of that fact: its claim alone lifts a path
  // out of the docs-only profile (RELEASE_PROCESS.md matches the root *.md
  // documentation rule) and selects the lane whose tests read it.
  // Only that lane: not the rule of the package the document belongs to.
  for (const [filePath, lane] of [['RELEASE_PROCESS.md', 'bura_cli'], ['packages/query/README.md', 'bura_query']]) {
    const plan = pullRequestPlan([change(filePath)]);
    assert.equal(plan.mode, 'delta', filePath);
    assert.deepEqual(selectedLanes(plan), [lane], filePath);
    assert.deepEqual(plan.evmScopes, [], filePath);
  }
  // A claimed file that is not documentation keeps its package rule too.
  const skill = pullRequestPlan([change('packages/cli/skills/dkg-node/SKILL.md')]);
  assert.equal(skill.lanes.bura_cli, true);
  assert.equal(skill.lanes.kosava_supporting, true);
  for (const filePath of ['CHANGELOG.md', 'packages/agent/README.md', 'packages/query/CHANGELOG.md', 'docs/ci-delta-policy.md']) {
    assert.equal(pullRequestPlan([change(filePath)]).mode, 'docs-only', filePath);
  }
});

test('the Blazegraph lane follows the agent lane, whose live suites its job runs', () => {
  // The Blazegraph job runs the agent's live Blazegraph suites, so every plan
  // that runs the agent lane selects the Blazegraph lane too: its output
  // starts the job, and the gate requires it.
  const job = parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')).jobs['tornado-blazegraph'];
  assert.equal(job.if, "needs.changes.outputs.tornado_blazegraph == 'true'");
  assert.ok(job.steps.some(({ run = '' }) => run.includes('dkg-agent exec vitest run --config vitest.blazegraph.config.ts')));
  for (const filePath of [
    'packages/agent/test-live/rfc64-legacy-swm-boundary-v1.blazegraph.test.ts',
    'packages/agent/src/dkg-agent.ts',
    'packages/core/src/index.ts',
    'devnet/v10-stress/automated.test.ts',
  ]) {
    const plan = pullRequestPlan([change(filePath)]);
    assert.equal(plan.lanes.tornado_agent, true, filePath);
    assert.equal(plan.lanes.tornado_blazegraph, true, filePath);
  }
  assert.equal(pullRequestPlan([change('packages/network-sim/src/index.ts')]).lanes.tornado_blazegraph, false);
});

test('identity-wallet browser actions select the real-EVM chain scope', () => {
  // Every shape IDENTITY_WALLET_EVM_PATTERNS matches, including the extension
  // alternation (the .tsx spelling is a shape probe, not an existing file).
  for (const filePath of [
    'packages/node-ui/src/ui/web3/identityWalletActions.ts',
    'packages/node-ui/src/ui/web3/identityWalletActions.tsx',
    'packages/node-ui/src/ui/web3/browserWalletTransaction.ts',
    'packages/node-ui/src/ui/pages/identity-wallets/useIdentityWalletManagement.ts',
    'packages/node-ui/src/ui/web3/session.ts',
    'packages/node-ui/src/ui/stores/wallet.ts',
    'packages/node-ui/integration/identity-wallet-actions-v10.test.ts',
    'packages/cli/src/daemon/routes/identity-wallets.ts',
  ]) {
    const plan = pullRequestPlan([change(filePath)]);
    assert.deepEqual(plan.evmScopes, ['chain'], filePath);
    assert.match(plan.reasons.join('\n'), /identity-wallet browser actions/, filePath);
  }

  for (const filePath of [
    'packages/node-ui/src/ui/pages/Dashboard.tsx',
    'packages/cli/src/daemon/routes/context.ts',
  ]) {
    assert.deepEqual(pullRequestPlan([change(filePath)]).evmScopes, [], filePath);
  }

  // The planner cannot import the manifest (it runs from the
  // trusted-controller sparse checkout), so link the two copies from here:
  // every node-ui file the chain scope actually RUNS must also be a planner
  // trigger, and renaming or moving the journey fails here instead of
  // silently shrinking the lane.
  const nodeUiChainFiles = EVM_TEST_SCOPES.chain.files
    .filter((file) => file.startsWith('../node-ui/'))
    .map((file) => file.replace('../node-ui/', 'packages/node-ui/'));
  assert.ok(nodeUiChainFiles.length > 0);
  for (const filePath of nodeUiChainFiles) {
    assert.deepEqual(pullRequestPlan([change(filePath)]).evmScopes, ['chain'], filePath);
  }
});

test('Blazegraph provisioning changes include the native arm64 contract lane', () => {
  const rootContract = pullRequestPlan([change('blazegraph-image.json')]);
  assert.deepEqual(selectedLanes(rootContract), ['bura_cli', 'bura_blazegraph_arm64']);

  const cliProvisioner = pullRequestPlan([
    change('packages/cli/src/daemon/blazegraph-new-provisioner.ts'),
  ]);
  assert.deepEqual(selectedLanes(cliProvisioner), [
    'tornado_blazegraph',
    'bura_cli',
    'bura_blazegraph_arm64',
    'kosava_node_ui',
    'kosava_node_ui_e2e',
    'kosava_hardhat_plugins',
  ]);
});

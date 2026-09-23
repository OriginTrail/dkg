import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { CI_LANES, WORKSPACE_OWNING_LANES, WORKSPACE_RULES, needsSharedBuild, planCi } from '../ci-delta.mjs';
import { PRIMARY_LANE_JOBS, validatePrimaryResults } from '../ci-results.mjs';
import { EVM_TEST_SCOPES } from '../../ci/evm-test-scopes.mjs';
import {
  REPO_ROOT,
  change,
  gateNeeds,
  loadReferences,
  pullRequestPlan,
  selectedLanes,
  sourceFiles,
  succeeded,
  traceLaneLoads,
  workspaceClosure,
} from './ci-plan-fixtures.mjs';

// The workspaces that `files` import by package name, plus everything those
// workspaces depend on: what code outside the package lanes compiles against.
function importedWorkspaceClosure(files) {
  const workspaceByName = new Map(Object.keys(WORKSPACE_RULES).map((workspace) => [
    JSON.parse(fs.readFileSync(path.join(REPO_ROOT, workspace, 'package.json'), 'utf8')).name,
    workspace,
  ]));
  return workspaceClosure(files.flatMap((file) => [
    ...fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')
      .matchAll(/(?:from|import\()\s*['"](@origintrail-official\/[a-z0-9-]+)/g),
  ].map(([, name]) => workspaceByName.get(name)).filter(Boolean)));
}

// Path routing: what individual changed paths select on pull requests -
// git statuses, workspace manifests, repository support areas and the
// per-file triggers (browser surface, Windows lifecycle, identity wallet,
// Blazegraph arm64).

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
  const withHook = { ...manifest, scripts: { ...manifest.scripts, postinstall: 'node setup.js' } };
  const removedHook = manifestPlan(manifest, undefined, withHook);
  assert.equal(removedHook.mode, 'full', 'removing an install hook');
  assert.match(removedHook.reasons[0], /install lifecycle scripts postinstall$/);

  const publisherManifest = [change('packages/publisher/package.json')];
  for (const [readManifest, reason] of [
    [undefined, /contents are unavailable to the planner$/],
    [() => { throw new Error('missing blob\nfatal: details'); }, /could not be read and parsed: missing blob$/],
    [() => '{ not json', /could not be read and parsed: .*JSON/],
    [() => '[]', /is not a JSON object$/],
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
    ['devnet/rfc64-gate1-public-open/run.ts', ['tornado_blazegraph', 'tornado_agent', 'tornado_agent_windows']],
    ['devnet/rfc64-persistence-lifecycle/run.ts', ['tornado_blazegraph', 'tornado_agent', 'tornado_agent_windows']],
    ['devnet/_bootstrap/rfc64-evidence.test.ts', ['tornado_blazegraph', 'tornado_agent', 'tornado_agent_windows']],
    ['devnet/rfc64-runtime-provenance.mts', ['tornado_blazegraph', 'tornado_agent', 'tornado_agent_windows', 'bura_cli']],
    ['devnet/rfc64-cp2-private-swm-vm-recovery/batch-plan.ts', ['tornado_blazegraph', 'tornado_agent', 'tornado_agent_windows', 'bura_cli']],
    ['devnet/suites.json', ['tornado_blazegraph', 'tornado_agent', 'tornado_agent_windows']],
    ['test-systems/storage-conformance.test.ts', ['tornado_blazegraph']],
    ['devnet/v10-stress/automated.test.ts', ['tornado_blazegraph', 'tornado_agent', 'tornado_agent_windows']],
    ['devnet/rfc64-gate2-multi-asset-completeness/runtime-load-hook.ts', ['tornado_blazegraph', 'tornado_agent', 'tornado_agent_windows', 'bura_cli']],
    ['devnet/rfc64-gate2-multi-asset-completeness/adapter-process.ts', ['tornado_blazegraph', 'tornado_agent', 'tornado_agent_windows', 'bura_cli']],
    ['bench/publish-async-get.bench.ts', ['bura_cli']],
    ['tools/observability/lib/w1.mjs', []],
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
  assert.deepEqual(deferred, [
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

test('the Windows lifecycle lane follows the agent dependency closure its harnesses load', () => {
  // The Windows job runs the SQLite persistence suites and the RFC-64 Gate 0
  // and evidence harnesses, which start a real agent and run on no Linux lane,
  // so every plan that runs the agent lane runs it too: every workspace, every
  // support area and every trigger path.
  const windowsSelected = (filePath) => pullRequestPlan([change(filePath)]).lanes.tornado_agent_windows;
  const probes = [
    ...Object.keys(WORKSPACE_RULES)
      .filter((workspace) => !WORKSPACE_RULES[workspace].forceFull)
      .map((workspace) => `${workspace}/src/index.ts`),
    'devnet/rfc64-gate1-public-open/run.ts',
    'devnet/rfc64-persistence-lifecycle/verify.ts',
    'devnet/_bootstrap/rfc64-evidence.ts',
    'devnet/rfc64-runtime-provenance.mts',
    'devnet/v10-stress/automated.test.ts',
    'test-systems/storage-conformance.test.ts',
    'bench/publish-async-get.bench.ts',
    'tools/observability/lib/w1.mjs',
    '.github/CODEOWNERS',
    'blazegraph-image.json',
    'packages/node-ui/src/ui/web3/identityWalletActions.ts',
  ];
  for (const filePath of probes) {
    const plan = pullRequestPlan([change(filePath)]);
    assert.equal(plan.lanes.tornado_agent_windows, plan.lanes.tornado_agent, filePath);
  }

  // Derive the closure from what the harnesses actually import, so a new
  // import or dependency cannot silently drop the lane.
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

  // Modules the harness loads, new or renamed persistence modules, and every
  // suite the job runs all keep the lane; unrelated workspaces do not.
  for (const filePath of [
    'packages/agent/src/finalization-recovery-worker.ts',
    'packages/agent/src/rfc64/journal-store-v1.ts',
    'packages/agent/src/finalization-recovery-sqlite-store-v2.ts',
    'packages/storage/src/oxigraph-store.ts',
    'packages/core/src/index.ts',
  ]) {
    assert.equal(pullRequestPlan([change(filePath)]).lanes.tornado_agent_windows, true, filePath);
  }
  const selectors = windowsWorkflow.jobs['inventory-lifecycle'].strategy.matrix.include
    .flatMap((group) => group.tests.trim().split(/\s+/));
  const agentTests = fs.readdirSync(path.join(REPO_ROOT, 'packages/agent/test'));
  for (const selector of selectors) {
    const matches = agentTests.filter((file) => `test/${file}`.startsWith(selector));
    assert.ok(matches.length > 0, `${selector} matches no agent test`);
    for (const file of matches) {
      assert.equal(pullRequestPlan([change(`packages/agent/test/${file}`)]).lanes.tornado_agent_windows, true, file);
    }
  }
  for (const filePath of ['packages/node-ui/src/ui/pages/Dashboard.tsx', 'packages/network-sim/src/index.ts']) {
    assert.equal(pullRequestPlan([change(filePath)]).lanes.tornado_agent_windows, false, filePath);
  }

  const persistence = pullRequestPlan([change('packages/agent/src/sqlite/owned-sqlite-v1.ts')]);
  const needs = gateNeeds(succeeded(
    'build',
    'evm-node-test-artifacts',
    selectedLanes(persistence).map((lane) => PRIMARY_LANE_JOBS[lane]),
  ));
  assert.deepEqual(validatePrimaryResults({ eventName: 'pull_request', plan: persistence, needs }), []);
  needs['inventory-windows'].result = 'skipped';
  assert.match(
    validatePrimaryResults({ eventName: 'pull_request', plan: persistence, needs }).join('\n'),
    /inventory-windows was selected but ended with skipped/,
  );

  // The Gate 0 harness selects the Windows job that runs it, the agent lane
  // whose code imports its evidence helpers and Blazegraph (the Gate 1
  // rollout tests load its process lifecycle), plus the shared build checks;
  // full plans always include the lane.
  const harness = pullRequestPlan([change('devnet/rfc64-persistence-lifecycle/verify.ts')]);
  assert.deepEqual(selectedLanes(harness), ['tornado_blazegraph', 'tornado_agent', 'tornado_agent_windows']);
  assert.equal(needsSharedBuild(harness), true);
  assert.equal(planCi({ eventName: 'push' }).lanes.tornado_agent_windows, true);
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

test('every file a lane runs, or loads by relative path, selects that lane', () => {
  // Seeds: what each lane executes. A workspace's code and tests run in its
  // owning lanes, node-ui's browser specs in the e2e lane and its integration
  // suites in the EVM scope that lists them. Package scripts run in no lane,
  // and fixture workspaces (test-fixtures/) run only where a test builds them.
  // A lane job also runs the support files its steps name: directly, through
  // a root package.json script or through a reusable workflow it calls.
  // What those files load comes from traceLaneLoads and loadReferences in
  // ci-plan-fixtures.mjs, which list the forms they follow. Each file reached
  // must select the lane or scope that loads it, or plan full CI.
  const seeds = new Map();
  const seed = (file, requirements, via) => {
    const entry = seeds.get(file) ?? seeds.set(file, new Map()).get(file);
    for (const requirement of requirements) if (!entry.has(requirement)) entry.set(requirement, via);
  };
  const evmScopeFiles = new Map(Object.entries(EVM_TEST_SCOPES).flatMap(([scope, { packageDirectory, files }]) =>
    files.map((file) => [path.posix.normalize(path.posix.join(packageDirectory, file)), `evm:${scope}`])));
  for (const [workspace, owningLanes] of Object.entries(WORKSPACE_OWNING_LANES)) {
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
  const rootScripts = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts;
  // A command plus the bodies of the root package.json scripts it runs.
  const withScripts = (command, seen = new Set()) => {
    const nested = [];
    for (const [, name] of command.matchAll(/\bpnpm (?:run )?([\w:-]+)/g)) {
      if (!Object.hasOwn(rootScripts, name) || seen.has(name)) continue;
      seen.add(name);
      nested.push(withScripts(rootScripts[name], seen));
    }
    return [command, ...nested].join('\n');
  };
  const workflowJobs = (file) => Object.entries(parse(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')).jobs);
  const laneByJob = Object.fromEntries(Object.entries(PRIMARY_LANE_JOBS).map(([lane, job]) => [job, lane]));
  const seedJobs = (jobs, laneFor) => {
    for (const [job, { steps = [], uses = '' }] of jobs) {
      const lane = laneFor(job);
      if (!lane) continue;
      if (uses.startsWith('./')) seedJobs(workflowJobs(uses.slice(2)), () => lane);
      for (const { run = '' } of steps) {
        for (const [file] of withScripts(run).matchAll(/\b(?:bench|devnet|test-systems|tools)\/[^\s'"]+\.[cm]?[jt]sx?\b/g)) {
          seed(file, [lane], `${job} job`);
        }
      }
    }
  };
  seedJobs(workflowJobs('.github/workflows/ci.yml'), (job) => laneByJob[job]);

  const loadedBy = traceLaneLoads(seeds);

  for (const [target, requirement, why] of [
    ['packages/query/README.md', 'bura_query', 'the query security tests read the README'],
    ['packages/cli/src/extraction/markdown-extractor.ts', 'tornado_agent', 'agent tests import CLI source'],
    ['packages/cli/src/daemon.ts', 'kosava_node_ui', 'node-ui tests scan the CLI daemon sources'],
    ['packages/agent/src/dkg-agent-join.ts', 'tornado_core', 'the chain RPC-site census reads agent sources'],
    ['devnet/rfc64-runtime-provenance.mts', 'bura_cli', 'the CLI-started Gate 2 adapter imports the shared runtime modules'],
    ['devnet/rfc64-persistence-lifecycle/process-lifecycle.ts', 'tornado_blazegraph', 'the Blazegraph job runs the Gate 1 rollout tests'],
    ['test-systems/storage-conformance.test.ts', 'tornado_blazegraph', 'pnpm test:conformance runs in the Blazegraph job'],
    ['devnet/rfc64-persistence-lifecycle/verify.ts', 'tornado_agent_windows', 'the reusable Windows workflow runs the Gate 0 harness'],
  ]) {
    assert.ok(loadedBy.get(target)?.has(requirement), why);
  }
  const missing = [];
  for (const [target, requirements] of loadedBy) {
    const plan = pullRequestPlan([change(target)]);
    if (plan.mode === 'full') continue;
    for (const [requirement, via] of requirements) {
      const selected = requirement.startsWith('evm:')
        ? plan.evmScopes.includes(requirement.slice(4))
        : plan.lanes[requirement];
      if (!selected) missing.push(`${requirement} loads ${target} via ${via}`);
    }
  }
  assert.deepEqual(missing, [], 'a change to these files must select the lane or EVM scope that loads them');
});

test('the load scanner sees these forms, and nothing it cannot resolve statically', () => {
  // The load-closure guard sees only what loadReferences recognises, so its
  // reach is pinned here: each form below resolves to the named file, and the
  // comment mention and the run-time path deliberately resolve to nothing.
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
    "import { contextGraphDataUri } from '@origintrail-official/dkg-core';",
    'const late = readFileSync(`${root}/${name}`);',
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
  ].join('\n'));
  assert.deepEqual(other.modules, ['packages/kafka-plugin/src/index.ts']);
  assert.deepEqual(other.paths.sort(), [
    'blazegraph-image.json',
    'packages/cli/src/cli.ts',
    'packages/cli/test-fixtures/sample-kafka-plugin/src/index.ts',
    'packages/rdf-utils/package.json',
  ]);
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
  const loads = traceLaneLoads(seeds, { read: (file) => sources.get(file) });
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

test('the Blazegraph lane follows the agent lane, as ci.yml starts its job', () => {
  // The Blazegraph job runs the agent's live Blazegraph suites and starts for
  // either lane; every plan that runs the agent lane says so, so the gate
  // requires the job.
  const job = parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')).jobs['tornado-blazegraph'];
  assert.match(job.if, /needs\.changes\.outputs\.tornado_agent == 'true'/);
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

  // ci-delta.mjs cannot import the manifest (it runs from the four-file
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

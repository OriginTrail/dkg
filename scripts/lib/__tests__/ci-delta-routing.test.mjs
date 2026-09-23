import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { CI_LANES, WORKSPACE_OWNING_LANES, WORKSPACE_RULES, planCi } from '../ci-delta.mjs';
import { PRIMARY_LANE_JOBS, validatePrimaryResults } from '../ci-results.mjs';
import { EVM_TEST_SCOPES } from '../../ci/evm-test-scopes.mjs';
import {
  REPO_ROOT,
  change,
  gateNeeds,
  pullRequestPlan,
  selectedLanes,
  succeeded,
} from './ci-plan-fixtures.mjs';

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
  const manifestPlan = (head, entries = [change('packages/publisher/package.json')]) => pullRequestPlan(entries, {
    readManifest: (side) => JSON.stringify(side === 'base' ? manifest : head),
  });
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
    [{ ...manifest, pnpm: { overrides: {} } }, /changed pnpm$/],
    [{ ...manifest, engines: { node: '>=22' } }, /changed engines$/],
    [{ ...manifest, somethingNew: true }, /changed somethingNew$/],
    [{ ...manifest, scripts: { ...manifest.scripts, postinstall: 'node setup.js' } }, /install lifecycle scripts postinstall$/],
    [{ ...manifest, scripts: { ...manifest.scripts, prepare: 'node setup.js' } }, /install lifecycle scripts prepare$/],
    [{ ...manifest, scripts: { ...manifest.scripts, dependencies: 'node setup.js' } }, /install lifecycle scripts dependencies$/],
    [{ ...manifest, scripts: { ...manifest.scripts, 'pnpm:devPreinstall': 'node setup.js' } }, /install lifecycle scripts pnpm:devPreinstall$/],
    [{ ...manifest, scripts: 'node setup.js' }, /scripts is not a JSON object$/],
  ]) {
    const plan = manifestPlan(head);
    assert.equal(plan.mode, 'full', String(reason));
    assert.match(plan.reasons[0], reason);
  }

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

test('repository support paths route to the lanes that execute them', () => {
  for (const [filePath, expected] of [
    ['devnet/rfc64-gate1-public-open/run.ts', ['tornado_blazegraph', 'tornado_agent', 'tornado_agent_windows']],
    ['devnet/rfc64-persistence-lifecycle/run.ts', ['tornado_agent', 'tornado_agent_windows']],
    ['devnet/_bootstrap/rfc64-evidence.test.ts', ['tornado_agent', 'tornado_agent_windows']],
    ['devnet/rfc64-runtime-provenance.mts', ['tornado_agent', 'tornado_agent_windows']],
    ['devnet/suites.json', ['tornado_agent', 'tornado_agent_windows']],
    ['test-systems/storage-conformance.test.ts', ['tornado_blazegraph']],
    ['devnet/v10-stress/automated.test.ts', ['tornado_agent', 'tornado_agent_windows']],
    ['devnet/rfc64-gate2-multi-asset-completeness/runtime-load-hook.ts', ['tornado_agent', 'tornado_agent_windows']],
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
    assert.equal(plan.runNode, true, `${filePath} still needs the shared build checks`);
    assert.deepEqual(selectedLanes(plan), expected, filePath);
    assert.deepEqual(plan.evmScopes, [], filePath);
  }
});

test('the browser suite follows only the UI surface it drives on pull requests', () => {
  const uiSurface = ['packages/cli', 'packages/graph-viz', 'packages/node-ui'];
  for (const [workspace, rule] of Object.entries(WORKSPACE_RULES)) {
    if (rule.forceFull) continue;
    assert.equal(rule.lanes.includes('kosava_node_ui_e2e'), uiSurface.includes(workspace), workspace);
  }
  for (const filePath of ['packages/agent/src/agent.ts', 'packages/publisher/src/index.ts', 'packages/core/src/index.ts']) {
    const plan = pullRequestPlan([change(filePath)]);
    assert.equal(plan.lanes.kosava_node_ui_e2e, false, filePath);
  }
  for (const filePath of ['packages/node-ui/src/ui/pages/Dashboard.tsx', 'packages/cli/src/daemon/routes/context.ts', 'packages/graph-viz/src/index.ts']) {
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
  const manifests = new Map(Object.keys(WORKSPACE_RULES).map((workspace) => [
    workspace,
    JSON.parse(fs.readFileSync(path.join(REPO_ROOT, workspace, 'package.json'), 'utf8')),
  ]));
  const workspaceByName = new Map([...manifests].map(([workspace, manifest]) => [manifest.name, workspace]));
  const harnessSources = [
    ...fs.readdirSync(path.join(REPO_ROOT, 'devnet/rfc64-persistence-lifecycle'), { recursive: true })
      .map((file) => path.join('devnet/rfc64-persistence-lifecycle', file)),
    ...fs.readdirSync(path.join(REPO_ROOT, 'devnet/_bootstrap'))
      .filter((file) => file.startsWith('rfc64-evidence'))
      .map((file) => path.join('devnet/_bootstrap', file)),
  ].filter((file) => /\.[cm]?tsx?$/.test(file) && !file.split(path.sep).includes('node_modules'))
    .filter((file) => fs.statSync(path.join(REPO_ROOT, file)).isFile());
  const queue = harnessSources.flatMap((file) => [
    ...fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').matchAll(/from '(@origintrail-official\/[a-z-]+)/g),
  ].map(([, name]) => workspaceByName.get(name)).filter(Boolean));
  assert.ok(queue.includes('packages/agent'), 'the Gate 0 harness starts a real agent');
  const closure = new Set();
  while (queue.length) {
    const workspace = queue.shift();
    if (closure.has(workspace)) continue;
    closure.add(workspace);
    const { dependencies = {}, devDependencies = {} } = manifests.get(workspace);
    for (const name of Object.keys({ ...dependencies, ...devDependencies })) {
      if (workspaceByName.has(name)) queue.push(workspaceByName.get(name));
    }
  }
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

  // The Gate 0 harness selects the Windows job that runs it and the agent
  // lane whose code imports its evidence helpers, plus the shared build
  // checks; full plans always include the lane.
  const harness = pullRequestPlan([change('devnet/rfc64-persistence-lifecycle/verify.ts')]);
  assert.deepEqual(selectedLanes(harness), ['tornado_agent', 'tornado_agent_windows']);
  assert.equal(harness.runNode, true);
  assert.equal(planCi({ eventName: 'push' }).lanes.tornado_agent_windows, true);
});

test('each changed path gets one routing decision with a fixed precedence', () => {
  // 1. Global CI inputs win over the support area or trigger they sit in.
  for (const filePath of [
    '.github/actions/upload-vitest-junit/action.yml',
    '.github/workflows/nested/policy.yml',
    '.github/workflows/rfc64-inventory-windows.yml',
    'scripts/ci/plan-ci.mjs',
    'devnet/v10-stress/package.json',
  ]) {
    assert.equal(pullRequestPlan([change(filePath)]).mode, 'full', filePath);
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

test('support routes include every package lane that imports from them', () => {
  // A package file importing something outside the workspaces (bench/,
  // devnet/, test-systems/, tools/) makes that package's lane a CI consumer
  // of it, so a change there must select the lane; full CI covers the rest.
  const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]((?:\.\.\/)+[^'"]+)['"]/g;
  const skipped = new Set(['node_modules', 'dist', 'dist-ui', 'coverage']);
  const sourceFiles = (directory) => fs.readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true })
    .flatMap((entry) => {
      if (skipped.has(entry.name)) return [];
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(relative);
      return /\.[cm]?[jt]sx?$/.test(entry.name) ? [relative] : [];
    });
  let checked = 0;
  for (const [workspace, owningLanes] of Object.entries(WORKSPACE_OWNING_LANES)) {
    if (!workspace.startsWith('packages/')) continue;
    for (const file of sourceFiles(workspace)) {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      for (const [, specifier] of source.matchAll(importPattern)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        if (target.startsWith('packages/') || target.startsWith('../')) continue;
        const plan = pullRequestPlan([change(target)]);
        checked++;
        if (plan.mode === 'full') continue;
        for (const lane of owningLanes) {
          assert.ok(plan.lanes[lane], `${file} imports ${target}, so changing it must select ${lane}`);
        }
      }
    }
  }
  assert.ok(checked > 0, 'packages import repository support files (bench/, devnet/)');
});

test('identity-wallet browser actions select the real-EVM chain scope', () => {
  // Every shape IDENTITY_WALLET_EVM_PATTERNS matches, including the extension
  // alternation (the .tsx spelling is a shape probe, not an existing file).
  for (const filePath of [
    'packages/node-ui/src/ui/web3/identityWalletActions.ts',
    'packages/node-ui/src/ui/web3/identityWalletActions.tsx',
    'packages/node-ui/src/ui/web3/browserWalletTransaction.ts',
    'packages/node-ui/src/ui/pages/identity-wallets/useIdentityWalletManagement.ts',
    'packages/node-ui/integration/identity-wallet-actions-v10.test.ts',
  ]) {
    const plan = pullRequestPlan([change(filePath)]);
    assert.deepEqual(plan.evmScopes, ['chain'], filePath);
    assert.match(plan.reasons.join('\n'), /identity-wallet browser actions/, filePath);
  }

  for (const filePath of [
    'packages/node-ui/src/ui/pages/Dashboard.tsx',
    'packages/node-ui/src/ui/web3/session.ts',
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
    'bura_cli',
    'bura_blazegraph_arm64',
    'kosava_node_ui_e2e',
    'kosava_hardhat_plugins',
  ]);
});

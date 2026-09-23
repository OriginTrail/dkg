import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { CI_LANES, WORKSPACE_OWNING_LANES, WORKSPACE_RULES } from '../ci-delta.mjs';
import { EVM_TEST_SCOPES } from '../../ci/evm-test-scopes.mjs';
import { REPO_ROOT, change, pullRequestPlan, selectedLanes, sourceFiles } from './ci-plan-fixtures.mjs';

// Path routing: what individual changed paths select on pull requests -
// git statuses, workspace manifests, repository support areas and the
// per-file triggers (identity wallet, Blazegraph arm64).

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
    name: '@origintrail-official/dkg-agent',
    version: '10.0.0',
    type: 'module',
    exports: { '.': './dist/index.js' },
    scripts: { build: 'tsc', test: 'vitest run' },
    dependencies: { ethers: '^6.13.0' },
  };
  const manifestPlan = (head, entries = [change('packages/agent/package.json')]) => pullRequestPlan(entries, {
    readManifest: (side) => JSON.stringify(side === 'base' ? manifest : head),
  });
  const sourcePlan = pullRequestPlan([change('packages/agent/src/agent.ts')]);

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

  const agentManifest = [change('packages/agent/package.json')];
  for (const readManifest of [
    undefined,
    () => { throw new Error('missing blob'); },
    () => '{ not json',
    () => '[]',
  ]) {
    assert.equal(pullRequestPlan(agentManifest, { readManifest }).mode, 'full', String(readManifest));
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
  // suites in the EVM scope that lists them; package scripts run in no lane.
  // A lane also loads everything those files reference by relative path
  // (static and dynamic imports and `new URL(...)` paths, including documents
  // a test reads), in other packages and support areas alike. Only module
  // loads carry on to what the loaded file imports; any other `new URL(...)`
  // path (a document read, a process to spawn) is loaded but not followed, and
  // type-only imports are erased before anything runs. Declared package.json
  // dependencies are covered by the reverse-dependency test; this covers the
  // couplings they miss. Each file reached must select the lane or scope, or
  // plan full CI.
  const modulePattern = /(?:\bfrom\s*|\bimport\s*\(\s*(?:new\s+URL\(\s*)?)['"]((?:\.\.?\/)+[^'"]+)['"]/g;
  const pathPattern = /\bnew\s+URL\(\s*['"]((?:\.\.?\/)+[^'"]+)['"]/g;
  const isFile = (candidate) => fs.statSync(path.join(REPO_ROOT, candidate), { throwIfNoEntry: false })?.isFile();
  const resolve = (file, specifier) => {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    // TypeScript sources are imported by their emitted extension, or none.
    return [
      target,
      target.replace(/\.js$/, '.ts'),
      target.replace(/\.js$/, '.tsx'),
      target.replace(/\.mjs$/, '.mts'),
      `${target}.ts`,
      `${target}/index.ts`,
    ].find(isFile) ?? target;
  };
  const references = (file) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')
      .replace(/\b(?:import|export)\s+type\s[^;]*?\bfrom\s*['"][^'"]+['"]/g, '');
    const modules = [...source.matchAll(modulePattern)].map(([, specifier]) => resolve(file, specifier));
    const paths = [...source.matchAll(pathPattern)].map(([, specifier]) => resolve(file, specifier));
    const inRepo = (target) => !target.startsWith('../');
    return { modules: modules.filter(inRepo), paths: paths.filter((target) => inRepo(target) && !modules.includes(target)) };
  };

  const loadedBy = new Map(); // path -> Map(lane or evm:scope -> how it is reached)
  const load = (target, requirements, via) => {
    const entry = loadedBy.get(target) ?? loadedBy.set(target, new Map()).get(target);
    const added = requirements.filter((requirement) => !entry.has(requirement));
    for (const requirement of added) entry.set(requirement, via);
    return added.length > 0;
  };
  const evmScopeFiles = new Map(Object.entries(EVM_TEST_SCOPES).flatMap(([scope, { packageDirectory, files }]) =>
    files.map((file) => [path.posix.normalize(path.posix.join(packageDirectory, file)), `evm:${scope}`])));
  for (const [workspace, owningLanes] of Object.entries(WORKSPACE_OWNING_LANES)) {
    if (WORKSPACE_RULES[workspace].forceFull) continue;
    for (const file of sourceFiles(workspace)) {
      const inside = file.slice(workspace.length + 1);
      if (/^(?:scripts|test\/archive)\//.test(inside)) continue;
      if (inside.startsWith('integration/')) {
        if (evmScopeFiles.has(file)) load(file, [evmScopeFiles.get(file)], 'EVM_TEST_SCOPES');
      } else if (workspace === 'packages/node-ui' && inside.startsWith('e2e/')) {
        load(file, ['kosava_node_ui_e2e'], 'the browser suite');
      } else {
        load(file, [...owningLanes, ...(evmScopeFiles.has(file) ? [evmScopeFiles.get(file)] : [])], `${workspace} lanes`);
      }
    }
  }

  const queue = [...loadedBy.keys()];
  while (queue.length) {
    const file = queue.shift();
    if (!isFile(file) || !/\.[cm]?[jt]sx?$/.test(file)) continue;
    const requirements = [...loadedBy.get(file).keys()];
    const { modules, paths } = references(file);
    for (const target of modules) {
      if (load(target, requirements, file)) queue.push(target);
    }
    for (const target of paths) load(target, requirements, file);
  }

  assert.ok(loadedBy.get('packages/query/README.md')?.has('bura_query'), 'the query security tests read the README');
  assert.ok(loadedBy.get('packages/cli/src/extraction/markdown-extractor.ts')?.has('tornado_agent'), 'agent tests import CLI source');
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

test('a document a test reads is a CI input; other documentation stays docs-only', () => {
  // PATH_TRIGGERS is the one home of that fact: its claim alone lifts a path
  // out of the docs-only profile (RELEASE_PROCESS.md matches the root *.md
  // documentation rule) and selects the lane whose tests read it.
  for (const [filePath, lane] of [['RELEASE_PROCESS.md', 'bura_cli'], ['packages/query/README.md', 'bura_query']]) {
    const plan = pullRequestPlan([change(filePath)]);
    assert.equal(plan.mode, 'delta', filePath);
    assert.equal(plan.lanes[lane], true, filePath);
  }
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
  // Every shape isIdentityWalletEvmPath matches, including the extension
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
    'bura_cli',
    'bura_blazegraph_arm64',
    'kosava_node_ui_e2e',
    'kosava_hardhat_plugins',
  ]);
});

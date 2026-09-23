import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { CI_LANES, PRIMARY_LANE_JOBS, WORKSPACE_OWNING_LANES, WORKSPACE_RULES } from '../ci-delta.mjs';
import { EVM_TEST_SCOPES } from '../../ci/evm-test-scopes.mjs';
import { REPO_ROOT, change, pullRequestPlan, selectedLanes, sourceFiles } from './ci-plan-fixtures.mjs';
import { loadReferences, traceLaneLoads } from './load-graph.mjs';

// Path routing: what individual changed paths select on pull requests -
// git statuses, workspace manifests, repository support areas and the
// per-file triggers (identity wallet, Blazegraph arm64) - and that the lane
// a path selects runs or loads it.

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
  const manifestPlan = (head, entries = [change('packages/agent/package.json')], base = manifest) => pullRequestPlan(entries, {
    readManifest: (side) => JSON.stringify(side === 'base' ? base : head),
  });
  const without = (object, field) => Object.fromEntries(Object.entries(object).filter(([key]) => key !== field));
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
  // suites in the EVM scope that lists them. Package scripts run in no lane,
  // and fixture workspaces (test-fixtures/) run only where a test builds them.
  // A lane job also runs the support files its steps name: directly, through
  // a root package.json script or through a reusable workflow it calls.
  // What those files load comes from traceLaneLoads and loadReferences in
  // load-graph.mjs, which list the forms they follow. Each file reached
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
  // A job runs for its mapped lane or, like a job that only calls a reusable
  // workflow, for the lane output its condition reads.
  const laneOf = (job, condition = '') => [
    laneByJob[job],
    condition.match(/needs\.changes\.outputs\.(\w+) == 'true'/)?.[1],
  ].find((lane) => CI_LANES.includes(lane));
  const seedJobs = (jobs, laneFor) => {
    for (const [job, { steps = [], uses = '', if: condition }] of jobs) {
      const lane = laneFor(job, condition);
      if (!lane) continue;
      if (uses.startsWith('./')) seedJobs(workflowJobs(uses.slice(2)), () => lane);
      for (const { run = '' } of steps) {
        for (const [file] of withScripts(run).matchAll(/\b(?:bench|devnet|test-systems|tools)\/[^\s'"]+\.[cm]?[jt]sx?\b/g)) {
          seed(file, [lane], `${job} job`);
        }
      }
    }
  };
  seedJobs(workflowJobs('.github/workflows/ci.yml'), laneOf);

  const loadedBy = traceLaneLoads(seeds);

  for (const [target, requirement, why] of [
    ['packages/query/README.md', 'bura_query', 'the query security tests read the README'],
    ['packages/cli/src/extraction/markdown-extractor.ts', 'tornado_agent', 'agent tests import CLI source'],
    ['packages/cli/src/daemon.ts', 'kosava_node_ui', 'node-ui tests scan the CLI daemon sources'],
    ['packages/agent/src/dkg-agent-join.ts', 'tornado_core', 'the chain RPC-site census reads agent sources'],
    ['devnet/rfc64-runtime-provenance.mts', 'bura_cli', 'the CLI-started Gate 2 adapter imports the shared runtime modules'],
    ['devnet/rfc64-persistence-lifecycle/process-lifecycle.ts', 'tornado_blazegraph', 'the Blazegraph job runs the Gate 1 rollout tests'],
    ['test-systems/storage-conformance.test.ts', 'tornado_blazegraph', 'pnpm test:conformance runs in the Blazegraph job'],
    ['devnet/_bootstrap/vitest.evidence.config.ts', 'tornado_agent', 'the Windows job, gated on the agent lane, runs the evidence suite'],
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

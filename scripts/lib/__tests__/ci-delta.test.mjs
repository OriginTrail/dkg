import { ciJobRow, COVERAGE_JOBS } from '../ci-lanes.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import {
  CI_LANES,
  EVM_SCOPES,
  NODE_EVM_LANES,
  NODE_TEST_ARTIFACT_LANES,
  needsNodeTestArtifacts,
  WORKSPACE_OWNING_EVM_SCOPES,
  WORKSPACE_OWNING_LANES,
  WORKSPACE_RULES,
  githubOutputsForPlan,
  parseNameStatusZ,
  planCi,
} from '../ci-delta.mjs';
import {
  PRIMARY_LANE_JOBS,
  validateEvmResults,
  validatePrimaryResults,
} from '../ci-results.mjs';
import { CONTROLLER_POLICY_FILES, validateTrustedControllerPins } from '../../ci/trusted-controller-pins.mjs';
import { EVM_TEST_SCOPES } from '../../ci/evm-test-scopes.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// This SHA is already reachable from the protected default branch. Candidate
// changes may update workflow wiring, but the planner and aggregate gates must
// continue to execute only reviewed policy from this immutable controller.
const TRUSTED_CI_CONTROLLER_SHA = '780f14aa60c39bdca788967121085c3c0d82d85c';
const NON_SOLIDITY_LANES = CI_LANES.filter((lane) => lane !== 'contracts');

function change(filePath, status = 'M') {
  return { status, paths: [filePath] };
}

function workflowJobBlock(workflow, jobName) {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow must define ${jobName}`);
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

function pullRequestPlan(changeEntries, overrides = {}) {
  return planCi({
    eventName: 'pull_request',
    changeEntries,
    ...overrides,
  });
}

function selectedLanes(plan) {
  return CI_LANES.filter((lane) => plan.lanes[lane]);
}

test('parses NUL-delimited git name-status output without shell-splitting file names', () => {
  const input = Buffer.from('M\0packages/agent/src/a file.ts\0R100\0old.md\0new.md\0');
  assert.deepEqual(parseNameStatusZ(input), [
    { status: 'M', paths: ['packages/agent/src/a file.ts'] },
    { status: 'R100', paths: ['old.md', 'new.md'] },
  ]);
});

test('non-PR events run every lane while full-PR overrides preserve the Solidity gate', () => {
  for (const eventName of ['push', 'merge_group', 'workflow_dispatch']) {
    const plan = planCi({ eventName });
    assert.equal(plan.fullCi, true, eventName);
    assert.deepEqual(selectedLanes(plan), CI_LANES, eventName);
    assert.deepEqual(plan.evmScopes, EVM_SCOPES, eventName);
  }

  const labeled = pullRequestPlan([change('CHANGELOG.md')], { labels: ['ci:full'] });
  assert.equal(labeled.fullCi, true);
  assert.deepEqual(selectedLanes(labeled), NON_SOLIDITY_LANES);
  assert.deepEqual(labeled.evmScopes, EVM_SCOPES);
  assert.equal(labeled.lanes.contracts, false);
  assert.equal(labeled.abiFreshnessRelevant, false);
  assert.deepEqual(NODE_EVM_LANES, NON_SOLIDITY_LANES);
});

test('unknown PR diffs fail closed with Solidity selected and enforced', () => {
  const plan = pullRequestPlan([]);
  assert.equal(plan.mode, 'full');
  assert.equal(plan.fullCi, true);
  assert.equal(plan.lanes.contracts, true);
  assert.equal(plan.abiFreshnessRelevant, true);
  assert.deepEqual(selectedLanes(plan), CI_LANES);
  assert.match(plan.reasons.join('\n'), /failing closed/);

  for (const [name, overridePlan] of [
    ['ci:full', pullRequestPlan([], { labels: ['ci:full'] })],
    ['delta disabled', planCi({
      eventName: 'pull_request_delta_disabled',
      changeEntries: [],
    })],
  ]) {
    assert.equal(overridePlan.mode, 'full', name);
    assert.equal(overridePlan.lanes.contracts, true, name);
    assert.equal(overridePlan.abiFreshnessRelevant, true, name);
    assert.deepEqual(selectedLanes(overridePlan), CI_LANES, name);
    assert.match(overridePlan.reasons.join('\n'), /failing closed/, name);
  }

  const needs = {
    changes: { result: 'success' },
    build: { result: 'success' },
    'abi-freshness': { result: 'success' },
    solidity: { result: 'skipped' },
    'solidity-coverage': { result: 'skipped' },
    'tornado-static-analysis': { result: 'success' },
    'evm-node-test-artifacts': { result: 'success' },
    'evm-devnet-test-artifacts': { result: 'success' },
    ...Object.fromEntries(
      Object.values(PRIMARY_LANE_JOBS).map((job) => [job, { result: 'success' }]),
    ),
  };
  assert.match(
    validatePrimaryResults({ eventName: 'pull_request', plan, needs }).join('\n'),
    /solidity was selected but ended with skipped/,
  );
  needs.solidity.result = 'success';
  assert.deepEqual(validatePrimaryResults({ eventName: 'pull_request', plan, needs }), []);
});

test('retired audit sampling no longer promotes pull requests to full CI', (t) => {
  // Head SHAs starting 00000000 used to fall in a 5% full-CI sample. Protected
  // pushes, merge-queue candidates and the nightly run are the full-CI safety
  // net; plan-ci.mjs still parses --sample-key so workflow wiring from either
  // side of a controller rotation keeps working under strict parsing.
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-ci-sample-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const changesPath = path.join(temporaryDirectory, 'changes.z');
  fs.writeFileSync(changesPath, Buffer.from('M\0packages/network-sim/src/index.ts\0'));
  const planner = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts/ci/plan-ci.mjs'),
    '--event',
    'pull_request',
    '--changes-z',
    changesPath,
    '--sample-key',
    '00000000ffffffffffffffffffffffffffffffff',
  ], { encoding: 'utf8' });
  assert.equal(planner.status, 0, planner.stderr);
  const plan = JSON.parse(planner.stdout);
  assert.equal(plan.mode, 'delta');
  assert.deepEqual(selectedLanes(plan), ['kosava_supporting']);
  assert.equal('auditSampled' in plan, false);
});

test('full PR plans preserve legacy Solidity paths and cover Hardhat support code', () => {
  const solidityRelevantPaths = [
    'packages/evm-module/contracts/KnowledgeAssets.sol',
    'packages/evm-module/test/KnowledgeAssets.test.ts',
    'packages/evm-module/deploy/001_deploy.ts',
    'packages/evm-module/scripts/export-abi.ts',
    'packages/evm-module/hardhat.config.ts',
    'packages/evm-module/hardhat.node.config.ts',
    'packages/evm-module/package.json',
    'packages/evm-module/slither.config.json',
    'packages/evm-module/.solhint.json',
    'packages/evm-module/.solhintignore',
    'packages/evm-module/aderyn.toml',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.github/workflows/ci.yml',
    'packages/evm-module/utils/helpers.ts',
    'packages/evm-module/utils/network.ts',
    'packages/evm-module/tasks/send_neuro.ts',
    'packages/evm-module/tsconfig.json',
    'packages/evm-module/deployments/parameters.json',
  ];

  const hardhatSupport = pullRequestPlan([
    change('packages/evm-module/utils/helpers.ts'),
  ]);
  assert.equal(hardhatSupport.mode, 'full');
  assert.equal(hardhatSupport.lanes.contracts, true);
  assert.equal(hardhatSupport.abiFreshnessRelevant, true);

  for (const filePath of solidityRelevantPaths) {
    const plan = pullRequestPlan([change(filePath)], { labels: ['ci:full'] });
    assert.equal(plan.mode, 'full', filePath);
    assert.equal(plan.lanes.contracts, true, filePath);
    assert.equal(plan.abiFreshnessRelevant, true, filePath);
  }

  const abiOnly = pullRequestPlan([
    change('packages/evm-module/abi/KnowledgeAssets.json'),
  ]);
  assert.equal(abiOnly.mode, 'full');
  assert.equal(abiOnly.lanes.contracts, false);
  assert.equal(abiOnly.abiFreshnessRelevant, true);
  assert.deepEqual(selectedLanes(abiOnly), NON_SOLIDITY_LANES);

  const nonSolidityPaths = [
    'packages/evm-module/README.md',
    'packages/evm-module/docs/greenfield-ka-ual.md',
    'packages/agent/package.json',
    '.github/workflows/evm-integration.yml',
    'scripts/ci/plan-ci.mjs',
  ];
  for (const filePath of nonSolidityPaths) {
    const plan = pullRequestPlan([change(filePath)], { labels: ['ci:full'] });
    assert.equal(plan.mode, 'full', filePath);
    assert.equal(plan.lanes.contracts, false, filePath);
    assert.equal(plan.abiFreshnessRelevant, false, filePath);
    assert.deepEqual(selectedLanes(plan), NON_SOLIDITY_LANES, filePath);
  }
});

test('the delta rollback switch still path-gates Solidity on pull requests', () => {
  const nonContract = planCi({
    eventName: 'pull_request_delta_disabled',
    changeEntries: [change('packages/agent/src/index.ts')],
  });
  assert.equal(nonContract.mode, 'full');
  assert.deepEqual(selectedLanes(nonContract), NON_SOLIDITY_LANES);
  assert.deepEqual(nonContract.evmScopes, EVM_SCOPES);

  const contract = planCi({
    eventName: 'pull_request_delta_disabled',
    changeEntries: [change('packages/evm-module/contracts/KnowledgeAssets.sol')],
  });
  assert.deepEqual(selectedLanes(contract), CI_LANES);
});

test('documentation-only PRs select no test lane or shared build', () => {
  const plan = pullRequestPlan([
    change('CHANGELOG.md'),
    change('docs/ci/overview.md'),
    change('packages/agent/README.md'),
  ]);
  assert.equal(plan.mode, 'docs-only');
  assert.equal(plan.runNode, false);
  assert.deepEqual(selectedLanes(plan), []);
  assert.deepEqual(plan.evmScopes, []);
});

test('markdown test fixtures are code inputs, not documentation-only changes', () => {
  const plan = pullRequestPlan([change('packages/okf/test/fixtures/example.md')]);
  assert.equal(plan.mode, 'delta');
  assert.ok(plan.lanes.kosava_supporting);
});

test('code and config files under documentation trees fail closed', () => {
  for (const filePath of ['docs/tool.mjs', 'docs/archive/input.json']) {
    assert.equal(pullRequestPlan([change(filePath)]).fullCi, true, filePath);
  }
  const demoScript = pullRequestPlan([change('demo/docs/check.sh')]);
  assert.equal(demoScript.mode, 'delta');
  assert.ok(demoScript.lanes.kosava_supporting);
  assert.equal(pullRequestPlan([change('docs/diagram.png')]).mode, 'docs-only');
});

test('leaf and shared package snapshots include conservative downstream consumers', () => {
  const agent = pullRequestPlan([change('packages/agent/src/agent.ts')]);
  assert.deepEqual(selectedLanes(agent), [
    'tornado_agent',
    'bura_cli',
    'kosava_node_ui_e2e',
    'kosava_supporting',
    'kosava_hardhat_plugins',
  ]);
  assert.deepEqual(agent.evmScopes, ['agent']);

  const networkSim = pullRequestPlan([change('packages/network-sim/src/index.ts')]);
  assert.deepEqual(selectedLanes(networkSim), ['kosava_supporting']);
  assert.deepEqual(networkSim.evmScopes, []);

  const localLlm = pullRequestPlan([change('packages/local-llm/src/runtime.ts')]);
  assert.deepEqual(selectedLanes(localLlm), [
    'bura_cli',
    'kosava_supporting',
    'kosava_hardhat_plugins',
  ]);
  assert.deepEqual(localLlm.evmScopes, []);

  const core = pullRequestPlan([change('packages/core/src/index.ts')]);
  assert.deepEqual(selectedLanes(core), [
    'tornado_core',
    'tornado_blazegraph',
    'tornado_publisher',
    'tornado_agent',
    'bura_cli',
    'bura_query',
    'kosava_node_ui',
    'kosava_node_ui_e2e',
    'kosava_supporting',
    'kosava_hardhat_plugins',
  ]);
  assert.deepEqual(core.evmScopes, EVM_SCOPES);
});

test('highest-risk, global, unknown, manifest, large, and ambiguous changes fail closed', () => {
  const cases = [
    [change('packages/evm-module/contracts/KnowledgeAssets.sol')],
    [change('pnpm-lock.yaml')],
    // Without a manifest reader the planner cannot tell metadata from deps.
    [change('packages/agent/package.json')],
    [change('devnet/v10-stress/package.json')],
    [change('.github/actions/upload-vitest-junit/action.yml')],
    [change('new-root-tool.ts')],
    [change('packages/agent/src/linked.ts', 'T')],
    [change('packages/agent/src/conflicted.ts', 'U')],
    [change('packages/agent/src/unknown.ts', 'X')],
    [change('packages/agent/src/future.ts', 'Z')],
  ];

  for (const changeEntries of cases) {
    assert.equal(pullRequestPlan(changeEntries).fullCi, true, JSON.stringify(changeEntries));
  }

  const large = Array.from({ length: 101 }, (_, index) => change(`packages/agent/src/file-${index}.ts`));
  const largePlan = pullRequestPlan(large);
  assert.equal(largePlan.fullCi, true);
  assert.equal(largePlan.changedFileCount, 101);

  const huge = Array.from({ length: 1000 }, (_, index) => change(`packages/agent/src/file-${index}.ts`));
  const hugePlan = pullRequestPlan(huge);
  assert.equal(hugePlan.changedFileCount, 1000);
  assert.equal(hugePlan.changedFiles.length, 200, 'GitHub output must stay bounded');
});

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

test('repository support paths route to the lanes that execute them', () => {
  for (const [filePath, expected] of [
    ['devnet/rfc64-gate1-public-open/run.ts', ['tornado_blazegraph', 'tornado_agent']],
    ['devnet/rfc64-persistence-lifecycle/run.ts', ['tornado_agent']],
    ['devnet/_bootstrap/rfc64-evidence.test.ts', ['tornado_agent']],
    ['devnet/rfc64-runtime-provenance.mts', ['tornado_agent']],
    ['devnet/suites.json', ['tornado_agent']],
    ['test-systems/storage-conformance.test.ts', ['tornado_blazegraph']],
    ['devnet/v10-stress/automated.test.ts', []],
    ['bench/store-read-latency.bench.ts', []],
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

test('a build-only plan requires the shared build and nothing else', () => {
  const plan = pullRequestPlan([change('bench/store-read-latency.bench.ts')]);
  const needs = {
    changes: { result: 'success' },
    build: { result: 'success' },
    'evm-node-test-artifacts': { result: 'skipped' },
    'evm-devnet-test-artifacts': { result: 'skipped' },
    ...Object.fromEntries(Object.values(PRIMARY_LANE_JOBS).map((job) => [job, { result: 'skipped' }])),
    'abi-freshness': { result: 'skipped' },
    solidity: { result: 'skipped' },
    'solidity-coverage': { result: 'skipped' },
    'tornado-static-analysis': { result: 'skipped' },
  };
  assert.deepEqual(validatePrimaryResults({ eventName: 'pull_request', plan, needs }), []);
  assert.deepEqual(validatePrimaryResults({ eventName: 'pull_request', plan: JSON.parse(githubOutputsForPlan(plan).plan_json), needs }), []);

  needs.build.result = 'skipped';
  assert.match(
    validatePrimaryResults({ eventName: 'pull_request', plan, needs }).join('\n'),
    /build was selected but ended with skipped/,
  );

  const laneWithoutBuild = { ...pullRequestPlan([change('packages/network-sim/src/index.ts')]), runNode: false };
  assert.match(
    validatePrimaryResults({ eventName: 'pull_request', plan: laneWithoutBuild, needs }).join('\n'),
    /runNode=false is inconsistent with selected Node lanes/,
  );
});

test('plan-ci compares modified workspace manifests through git blobs', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-ci-manifest-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const repository = path.join(temporaryDirectory, 'candidate');
  const isolatedGit = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', [
    '-C', repository, '-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', ...args,
  ], { encoding: 'utf8', env: isolatedGit }).trim();
  const manifestPath = path.join(repository, 'packages/agent/package.json');
  const commitManifest = (manifest, message) => {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  execFileSync('git', ['init', '-q', repository], { env: isolatedGit });
  const manifest = { name: '@origintrail-official/dkg-agent', exports: { '.': './dist/index.js' } };
  const base = commitManifest(manifest, 'base');
  const exportsHead = commitManifest({ ...manifest, exports: { ...manifest.exports, './sync': './dist/sync.js' } }, 'exports');
  const dependencyHead = commitManifest({ ...manifest, dependencies: { ethers: '^6.13.0' } }, 'dependency');

  const changesPath = path.join(temporaryDirectory, 'changes.z');
  fs.writeFileSync(changesPath, Buffer.from('M\0packages/agent/package.json\0'));
  const { CI_CANDIDATE_REPO, CI_DIFF_BASE_SHA, CI_DIFF_HEAD_SHA, ...environment } = process.env;
  const mode = (overrides) => {
    const planner = spawnSync(process.execPath, [
      path.join(REPO_ROOT, 'scripts/ci/plan-ci.mjs'),
      '--event',
      'pull_request',
      '--changes-z',
      changesPath,
    ], { encoding: 'utf8', env: { ...environment, ...overrides } });
    assert.equal(planner.status, 0, planner.stderr);
    return JSON.parse(planner.stdout).mode;
  };
  const diff = (head) => ({ CI_CANDIDATE_REPO: repository, CI_DIFF_BASE_SHA: base, CI_DIFF_HEAD_SHA: head });

  assert.equal(mode(diff(exportsHead)), 'delta');
  assert.equal(mode(diff(dependencyHead)), 'full');
  assert.equal(mode({}), 'full', 'no reader without the workflow variables');
  assert.equal(mode({ ...diff(exportsHead), CI_DIFF_BASE_SHA: 'HEAD~2' }), 'full', 'only object IDs are accepted');
  assert.equal(mode({ ...diff(exportsHead), CI_DIFF_BASE_SHA: '0'.repeat(40) }), 'full', 'missing blobs fail closed');
});

test('control-plane changes force full Node/EVM CI without overriding the Solidity gate', () => {
  const controlPlanePaths = [
    '.github/workflows/ci.yml',
    '.github/workflows/evm-integration.yml',
    '.github/workflows/nested/policy.yml',
    'scripts/ci/plan-ci.mjs',
    'scripts/ci/assert-ci-results.mjs',
    'scripts/lib/ci-delta.mjs',
    'scripts/lib/ci-results.mjs',
    'scripts/unrelated-maintenance.mjs',
  ];

  for (const filePath of controlPlanePaths) {
    const plan = pullRequestPlan([change(filePath)]);
    assert.equal(plan.mode, 'full', filePath);
    assert.equal(plan.fullCi, true, filePath);
    assert.equal(plan.runNode, true, filePath);
    assert.deepEqual(
      selectedLanes(plan),
      filePath === '.github/workflows/ci.yml' ? CI_LANES : NON_SOLIDITY_LANES,
      filePath,
    );
    assert.deepEqual(plan.evmScopes, EVM_SCOPES, filePath);
  }
});

test('ordinary network-sim changes remain a narrow delta after the trust hardening', () => {
  const plan = pullRequestPlan([change('packages/network-sim/src/index.ts')]);
  assert.equal(plan.mode, 'delta');
  assert.equal(plan.fullCi, false);
  assert.deepEqual(selectedLanes(plan), ['kosava_supporting']);
  assert.deepEqual(plan.evmScopes, []);
});

test('identity-wallet browser actions select the real-EVM chain scope', () => {
  // Every shape isIdentityWalletEvmPath matches, including the extension
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

test('every tested workspace is represented by the routing manifest', () => {
  const manifests = [
    ...fs.readdirSync(path.join(REPO_ROOT, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}`),
    'demo',
  ];

  const testedWorkspaces = manifests.filter((workspace) => {
    const manifestPath = path.join(REPO_ROOT, workspace, 'package.json');
    if (!fs.existsSync(manifestPath)) return false;
    return Boolean(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).scripts?.test);
  });

  assert.deepEqual(
    testedWorkspaces.filter((workspace) => !WORKSPACE_RULES[workspace]),
    [],
    'every workspace with a test script must be classified',
  );

  for (const [workspace, rule] of Object.entries(WORKSPACE_RULES)) {
    for (const lane of rule.lanes) {
      assert.ok(CI_LANES.includes(lane), `${workspace} references unknown lane ${lane}`);
    }
    for (const scope of rule.evmScopes) {
      assert.ok(EVM_SCOPES.includes(scope), `${workspace} references unknown EVM scope ${scope}`);
    }
  }
});

test('routing rules cover every current reverse workspace dependency', () => {
  const manifests = new Map(Object.keys(WORKSPACE_RULES).map((workspace) => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, workspace, 'package.json'), 'utf8'),
    );
    return [workspace, manifest];
  }));
  const workspaceByPackageName = new Map(
    [...manifests].map(([workspace, manifest]) => [manifest.name, workspace]),
  );
  const reverseDependencies = new Map(
    [...manifests.keys()].map((workspace) => [workspace, new Set()]),
  );

  for (const [consumer, manifest] of manifests) {
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    for (const dependencyName of Object.keys(dependencies)) {
      const provider = workspaceByPackageName.get(dependencyName);
      if (provider) reverseDependencies.get(provider).add(consumer);
    }
  }

  for (const [changedWorkspace, rule] of Object.entries(WORKSPACE_RULES)) {
    assert.ok(WORKSPACE_OWNING_LANES[changedWorkspace], `${changedWorkspace} needs an owning lane`);
    if (rule.forceFull) continue;

    const downstream = new Set([changedWorkspace]);
    const queue = [changedWorkspace];
    while (queue.length) {
      const provider = queue.shift();
      for (const consumer of reverseDependencies.get(provider)) {
        if (downstream.has(consumer)) continue;
        downstream.add(consumer);
        queue.push(consumer);
      }
    }

    const requiredLanes = new Set(
      [...downstream].flatMap((workspace) => WORKSPACE_OWNING_LANES[workspace]),
    );
    const requiredEvmScopes = new Set(
      [...downstream].flatMap((workspace) => WORKSPACE_OWNING_EVM_SCOPES[workspace] ?? []),
    );
    const missing = [...requiredLanes].filter((lane) => !rule.lanes.includes(lane));
    assert.deepEqual(
      missing,
      [],
      `${changedWorkspace} misses downstream owner lanes for ${[...downstream].join(', ')}`,
    );
    assert.deepEqual(
      [...requiredEvmScopes].filter((scope) => !rule.evmScopes.includes(scope)),
      [],
      `${changedWorkspace} misses downstream EVM scopes for ${[...downstream].join(', ')}`,
    );
  }
});

test('workflows execute the planner and aggregate gates from one immutable trusted checkout', () => {
  const workflows = new Map([
    ['primary', fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')],
    ['evm', fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/evm-integration.yml'), 'utf8')],
  ]);

  for (const [name, workflow] of workflows) {
    assert.match(TRUSTED_CI_CONTROLLER_SHA, /^[0-9a-f]{40}$/);
    assert.match(workflow, /node trusted-ci\/scripts\/ci\/plan-ci\.mjs\b/);
    assert.match(workflow, /node trusted-ci\/scripts\/ci\/assert-ci-results\.mjs\b/);
    assert.doesNotMatch(
      workflow,
      /node (?:\.\/)?scripts\/ci\/(?:plan-ci|assert-ci-results)\.mjs\b/,
      `${name} must not execute CI policy from the merge candidate`,
    );
  }

  const controller = validateTrustedControllerPins([
    { sourceName: 'primary', source: workflows.get('primary') },
    { sourceName: 'evm', source: workflows.get('evm') },
  ]);
  assert.equal(controller.ref, TRUSTED_CI_CONTROLLER_SHA);
  assert.equal(controller.checkouts.length, 4);

  const primaryWorkflow = workflows.get('primary');
  assert.doesNotMatch(
    primaryWorkflow,
    /ref: aba17f2e66cf48a6cd6dc06c567e1e8bd77bfb8d/,
    'the trusted controller must not point into candidate-only history',
  );
  const abiFreshnessJob = workflowJobBlock(primaryWorkflow, 'abi-freshness');
  assert.match(
    abiFreshnessJob,
    /^    if: needs\.changes\.outputs\.abi_freshness == 'true'$/m,
    'ABI freshness must use the trusted planner output once the controller is protected',
  );
  assert.match(
    workflowJobBlock(primaryWorkflow, 'changes'),
    /^      abi_freshness: \$\{\{ steps\.plan\.outputs\.abi_freshness \}\}$/m,
    'the trusted planner output must be exposed to the ABI freshness job',
  );
  assert.doesNotMatch(
    workflowJobBlock(primaryWorkflow, 'changes'),
    /candidate\/scripts\/ci\/check-tracked-text-nul\.mjs/,
    'an untrusted candidate must never supply its own security gate',
  );
  assert.ok(
    primaryWorkflow.indexOf('run: node candidate/scripts/check-npm-metadata.mjs')
      > primaryWorkflow.indexOf('node trusted-ci/scripts/ci/plan-ci.mjs'),
    'candidate npm metadata validation must happen only after the trusted plan is fixed',
  );
});

test('trusted planner and gates reject the all-skipped candidate-control attack', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-ci-trust-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  // Model a candidate that edits both control scripts. Even if its copies
  // would emit an all-false plan and exit zero, the trusted planner must force
  // a full run and the trusted gates must reject the resulting skipped jobs.
  const changesPath = path.join(temporaryDirectory, 'changes.z');
  fs.writeFileSync(
    changesPath,
    Buffer.from('M\0scripts/ci/plan-ci.mjs\0M\0scripts/ci/assert-ci-results.mjs\0'),
  );

  const planner = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts/ci/plan-ci.mjs'),
    '--event',
    'pull_request',
    '--changes-z',
    changesPath,
    '--sample-key',
    'ffffffffffffffffffffffffffffffffffffffff',
  ], { encoding: 'utf8' });
  assert.equal(planner.status, 0, planner.stderr);
  const plan = JSON.parse(planner.stdout);
  assert.equal(plan.mode, 'full');
  assert.deepEqual(selectedLanes(plan), NON_SOLIDITY_LANES);
  assert.deepEqual(plan.evmScopes, EVM_SCOPES);

  const primaryNeeds = {
    changes: { result: 'success' },
    build: { result: 'skipped' },
    'evm-node-test-artifacts': { result: 'skipped' },
    'evm-devnet-test-artifacts': { result: 'skipped' },
    ...Object.fromEntries(
      Object.values(PRIMARY_LANE_JOBS).map((job) => [job, { result: 'skipped' }]),
    ),
    'abi-freshness': { result: 'skipped' },
    solidity: { result: 'skipped' },
    'solidity-coverage': { result: 'skipped' },
    'tornado-static-analysis': { result: 'skipped' },
  };
  const primaryGate = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts/ci/assert-ci-results.mjs'),
    '--workflow',
    'primary',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EVENT_NAME: 'pull_request',
      PLAN_JSON: JSON.stringify(plan),
      NEEDS_JSON: JSON.stringify(primaryNeeds),
    },
  });
  assert.equal(primaryGate.status, 1);
  assert.match(primaryGate.stderr, /selected but ended with skipped/);

  const evmGate = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts/ci/assert-ci-results.mjs'),
    '--workflow',
    'evm',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EVENT_NAME: 'pull_request',
      PLAN_JSON: JSON.stringify(plan),
      NEEDS_JSON: JSON.stringify({
        plan: { result: 'success' },
        'evm-integration': { result: 'skipped' },
      }),
    },
  });
  assert.equal(evmGate.status, 1);
  assert.match(evmGate.stderr, /selected but ended with skipped/);
});

test('the trusted controller runs from a checkout of exactly its policy files', (t) => {
  // Workflows sparse-check out ONLY CONTROLLER_POLICY_FILES at the pinned SHA.
  // A controller file that imports anything else (ci-delta.mjs once imported
  // ci-lanes.mjs) makes the pin impossible to rotate: every planner run would
  // fail with ERR_MODULE_NOT_FOUND. Run the real scripts from such a copy,
  // outside the repository so no node_modules can resolve.
  const controllerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-ci-controller-'));
  t.after(() => fs.rmSync(controllerRoot, { recursive: true, force: true }));
  for (const file of CONTROLLER_POLICY_FILES) {
    fs.mkdirSync(path.dirname(path.join(controllerRoot, file)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, file), path.join(controllerRoot, file));

    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const [, specifier] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)) {
      if (specifier.startsWith('node:')) continue;
      const resolved = path.posix.join(path.posix.dirname(file), specifier);
      assert.ok(
        CONTROLLER_POLICY_FILES.includes(resolved),
        `${file} imports ${specifier}, which the trusted sparse checkout does not contain`,
      );
    }
  }

  const changesPath = path.join(controllerRoot, 'changes.z');
  fs.writeFileSync(changesPath, Buffer.from('M\0packages/network-sim/src/index.ts\0'));
  const planner = spawnSync(process.execPath, [
    path.join(controllerRoot, 'scripts/ci/plan-ci.mjs'),
    '--event',
    'pull_request',
    '--changes-z',
    changesPath,
  ], { cwd: controllerRoot, encoding: 'utf8' });
  assert.equal(planner.status, 0, planner.stderr);
  const plan = JSON.parse(planner.stdout);
  assert.equal(plan.mode, 'delta');
  assert.deepEqual(selectedLanes(plan), ['kosava_supporting']);

  const gate = spawnSync(process.execPath, [
    path.join(controllerRoot, 'scripts/ci/assert-ci-results.mjs'),
    '--workflow',
    'primary',
  ], {
    cwd: controllerRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      EVENT_NAME: 'pull_request',
      PLAN_JSON: githubOutputsForPlan(plan).plan_json,
      NEEDS_JSON: JSON.stringify({
        changes: { result: 'success' },
        build: { result: 'success' },
        'evm-node-test-artifacts': { result: 'skipped' },
        'evm-devnet-test-artifacts': { result: 'skipped' },
        ...Object.fromEntries(Object.values(PRIMARY_LANE_JOBS).map((job) => [
          job,
          { result: job === 'kosava-supporting' ? 'success' : 'skipped' },
        ])),
        'abi-freshness': { result: 'skipped' },
        solidity: { result: 'skipped' },
        'solidity-coverage': { result: 'skipped' },
        'tornado-static-analysis': { result: 'skipped' },
      }),
    },
  });
  assert.equal(gate.status, 0, gate.stderr);
});

test('every planner output is wired to a real workflow job and omitted tests stay covered', () => {
  const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  for (const [lane, job] of Object.entries(PRIMARY_LANE_JOBS)) {
    assert.match(workflow, new RegExp(`^  ${job}:`, 'm'), `${lane} must map to job ${job}`);
    assert.ok(
      workflow.includes(`needs.changes.outputs.${lane} == 'true'`),
      `${job} must be gated by ${lane}`,
    );
  }
  assert.ok(workflow.includes("needs.changes.outputs.contracts == 'true'"));
  assert.match(
    workflowJobBlock(workflow, 'abi-freshness'),
    /^    if: needs\.changes\.outputs\.abi_freshness == 'true'$/m,
  );
  assert.ok(
    workflow.includes(
      "if: (github.event_name == 'pull_request' || github.event_name == 'merge_group') && needs.changes.outputs.contracts == 'true'",
    ),
    'the sharded Solidity suite must protect contract PRs and exact merge candidates',
  );
  assert.ok(
    workflow.includes('run: node candidate/scripts/check-npm-metadata.mjs'),
    'docs-only package README changes must retain the npm metadata gate',
  );
  const deltaPredicate = "vars.CI_DELTA_ENABLED == 'true' && (github.base_ref == 'main' || github.base_ref == 'testnet-canary')";
  assert.ok(
    workflow.includes(`DELTA_ENABLED: \${{ ${deltaPredicate} }}`),
    'both protected branches must remain subordinate to the rollback switch',
  );
  assert.ok(workflow.includes('git -C candidate diff --name-status -z \\\n'));
  assert.ok(workflow.includes('"${BASE_SHA}" "${MERGE_SHA}" > "${CHANGES_FILE}"'));
  assert.equal(workflow.includes('"${BASE_SHA}" "${HEAD_SHA}"'), false);
  // The diff base must be the merge candidate's first parent (the CURRENT
  // base tip). The event payload's pull_request.base.sha is a stale snapshot:
  // it drags unrelated already-merged base changes into the diff and misroutes
  // ordinary PRs to full CI (observed on PR #1690 after #1687 merged).
  assert.ok(workflow.includes('BASE_SHA="$(git -C candidate rev-parse "${MERGE_SHA}^1")"'));
  assert.equal(workflow.includes('github.event.pull_request.base.sha'), false);
  assert.match(workflow, /^  evm-node-test-artifacts:/m);
  assert.match(workflow, /^  evm-devnet-test-artifacts:/m);
  assert.equal(ciJobRow('tornado-core', 1).runner, 'weighted');
  assert.equal(ciJobRow('bura-cli', 0).runner, 'weighted');
  assert.equal(
    workflow.includes('@origintrail-official/dkg-chain exec vitest run --shard='),
    false,
  );
  assert.equal(
    workflow.includes('@origintrail-official/dkg exec vitest run --shard='),
    false,
  );
  assert.ok(workflow.includes('shard: [1, 2, 3, 4, 5, 6, 7]'));
  assert.ok(workflow.includes('playwright test --shard=${{ matrix.shard }}/7'));

  assert.equal(COVERAGE_JOBS['tornado-core']['http-utils'], 1);
  assert.equal(COVERAGE_JOBS['tornado-core']['rdf-utils'], 1);
  assert.equal(ciJobRow('kosava-supporting').concurrency, 3);
  for (const [packageName, invocation] of [
    ['@origintrail-official/dkg-demo', '--filter @origintrail-official/dkg-demo'],
  ]) {
    assert.ok(workflow.includes(invocation), `${packageName} tests must stay in CI`);
  }

  const evmWorkflow = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/evm-integration.yml'),
    'utf8',
  );
  assert.ok(evmWorkflow.includes('fromJSON(needs.plan.outputs.evm_matrix)'));
  assert.ok(
    evmWorkflow.includes(`DELTA_ENABLED: \${{ ${deltaPredicate} }}`),
    'the EVM planner must use the same grouped rollback predicate',
  );
  assert.ok(evmWorkflow.includes('git -C candidate diff --name-status -z \\\n'));
  assert.ok(evmWorkflow.includes('"${BASE_SHA}" "${MERGE_SHA}" > "${CHANGES_FILE}"'));
  assert.ok(evmWorkflow.includes('BASE_SHA="$(git -C candidate rev-parse "${MERGE_SHA}^1")"'));
  assert.equal(evmWorkflow.includes('github.event.pull_request.base.sha'), false);
  assert.match(evmWorkflow, /^  evm-gate:/m);

  const demoManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'demo/package.json'), 'utf8'));
  assert.match(demoManifest.scripts.test, /kafka-streams\/test\/\*\.mjs/);
  assert.match(demoManifest.scripts.test, /epcis-bike\/test\/\*\.mjs/);
});

test('GitHub outputs are booleans plus compact JSON matrices', () => {
  const outputs = githubOutputsForPlan(pullRequestPlan([change('packages/network-sim/src/index.ts')]));
  assert.equal(outputs.kosava_supporting, 'true');
  assert.equal(outputs.tornado_agent, 'false');
  assert.equal(outputs.run_node, 'true');
  assert.equal(outputs.evm_matrix, '[]');
  const gatePlan = JSON.parse(outputs.plan_json);
  assert.equal(gatePlan.mode, 'delta');
  assert.equal(gatePlan.lanes.kosava_supporting, true);
  assert.equal(gatePlan.lanes.contracts, false);
  assert.equal(gatePlan.abiFreshnessRelevant, false);
  assert.equal('solidityRelevant' in gatePlan, false);
  assert.equal('changedFiles' in gatePlan, false);
  assert.equal('reasons' in gatePlan, false);

  const abiOnlyOutputs = githubOutputsForPlan(pullRequestPlan([
    change('packages/evm-module/abi/KnowledgeAssets.json'),
  ]));
  assert.equal(abiOnlyOutputs.abi_freshness, 'true');
  assert.equal(abiOnlyOutputs.contracts, 'false');
});

test('aggregate gates reject failed or accidentally skipped selected jobs', () => {
  const plan = pullRequestPlan([change('packages/network-sim/src/index.ts')]);
  const needs = {
    changes: { result: 'success' },
    build: { result: 'success' },
    'abi-freshness': { result: 'skipped' },
    solidity: { result: 'skipped' },
    'solidity-coverage': { result: 'skipped' },
    'tornado-static-analysis': { result: 'skipped' },
    'evm-node-test-artifacts': { result: 'skipped' },
    'evm-devnet-test-artifacts': { result: 'skipped' },
    ...Object.fromEntries(Object.values(PRIMARY_LANE_JOBS).map((job) => [job, { result: 'skipped' }])),
  };
  needs['kosava-supporting'].result = 'success';
  assert.deepEqual(validatePrimaryResults({ eventName: 'pull_request', plan, needs }), []);

  needs['kosava-supporting'].result = 'skipped';
  assert.match(validatePrimaryResults({ eventName: 'pull_request', plan, needs }).join('\n'), /selected/);

  const fullNonContract = pullRequestPlan(
    [change('scripts/unrelated-maintenance.mjs')],
    { labels: ['ci:full'] },
  );
  const fullNonContractNeeds = {
    changes: { result: 'success' },
    build: { result: 'success' },
    'abi-freshness': { result: 'skipped' },
    solidity: { result: 'skipped' },
    'solidity-coverage': { result: 'skipped' },
    'tornado-static-analysis': { result: 'skipped' },
    'evm-node-test-artifacts': { result: 'success' },
    'evm-devnet-test-artifacts': { result: 'success' },
    ...Object.fromEntries(
      Object.values(PRIMARY_LANE_JOBS).map((job) => [job, { result: 'success' }]),
    ),
  };
  assert.deepEqual(validatePrimaryResults({
    eventName: 'pull_request',
    plan: fullNonContract,
    needs: fullNonContractNeeds,
  }), []);

  const abiOnly = pullRequestPlan([
    change('packages/evm-module/abi/KnowledgeAssets.json'),
  ]);
  const abiOnlyNeeds = structuredClone(fullNonContractNeeds);
  abiOnlyNeeds['abi-freshness'].result = 'success';
  assert.deepEqual(validatePrimaryResults({
    eventName: 'pull_request',
    plan: abiOnly,
    needs: abiOnlyNeeds,
  }), []);
  abiOnlyNeeds['abi-freshness'].result = 'skipped';
  assert.match(
    validatePrimaryResults({
      eventName: 'pull_request',
      plan: abiOnly,
      needs: abiOnlyNeeds,
    }).join('\n'),
    /abi-freshness was selected but ended with skipped/,
  );

  const evmPlan = pullRequestPlan([change('packages/agent/src/index.ts')]);
  assert.deepEqual(validateEvmResults({
    eventName: 'pull_request',
    plan: evmPlan,
    needs: { plan: { result: 'success' }, 'evm-integration': { result: 'success' } },
  }), []);
  assert.match(validateEvmResults({
    eventName: 'pull_request',
    plan: evmPlan,
    needs: { plan: { result: 'success' }, 'evm-integration': { result: 'failure' } },
  }).join('\n'), /failure/);
});

test('all shared Hardhat consumers require and restore the matching artifact', () => {
  const { jobs } = parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
  const restorePath = './.github/actions/restore-evm-node-test-artifacts';
  const action = parse(fs.readFileSync(path.join(REPO_ROOT, restorePath, 'action.yml'), 'utf8'));
  assert.equal(action.runs.using, 'composite');
  const download = action.runs.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.match(download.uses, /@[a-f0-9]{40}$/);
  assert.equal(download.with.name, 'evm-node-test-artifacts');
  assert.equal(download.with.path, '${{ runner.temp }}/evm-node-test-artifacts');
  const extract = action.runs.steps.find((step) => step.run);
  assert.equal(extract.shell, 'bash');
  assert.equal(extract.env.ARTIFACT_DIR, download.with.path);
  assert.match(extract.run, /tar -xzf "\$\{ARTIFACT_DIR\}\/evm-node-test-artifacts\.tgz"/);
  assert.equal(jobs['evm-node-test-artifacts'].if, "needs.changes.outputs.node_test_artifacts == 'true'");
  const output = jobs.changes.outputs.node_test_artifacts;
  assert.ok(output.startsWith('${{ steps.plan.outputs.node_test_artifacts || ('));
  const legacyLanes = [...output.matchAll(/steps\.plan\.outputs\.(\w+) == 'true'/g)].map((match) => match[1]);
  assert.deepEqual(new Set(legacyLanes), new Set(NODE_TEST_ARTIFACT_LANES));
  for (const lane of NODE_TEST_ARTIFACT_LANES) {
    const job = PRIMARY_LANE_JOBS[lane];
    const consumer = jobs[job];
    const dependencies = new Set([consumer.needs].flat());
    for (const dependency of ['changes', 'build', 'evm-node-test-artifacts']) {
      assert.ok(dependencies.has(dependency), `${job} requires ${dependency}`);
    }
    const restores = consumer.steps.filter((step) => step.uses === restorePath);
    assert.equal(restores.length, 1, job);
    assert.equal(restores[0].if, job === 'tornado-core' ? "matrix.suite == 'chain'" : undefined);
  }
});

test('artifact capability selects its producer and gate for each consumer lane only', () => {
  assert.equal(NODE_TEST_ARTIFACT_LANES.length, 5);
  for (const lane of CI_LANES) {
    const plan = {
      ...planCi({ eventName: 'push' }), mode: 'delta', fullCi: false,
      runNode: Object.hasOwn(PRIMARY_LANE_JOBS, lane) && lane !== 'bura_blazegraph_arm64',
      lanes: Object.fromEntries(CI_LANES.map((candidate) => [candidate, candidate === lane])),
    };
    const selected = NODE_TEST_ARTIFACT_LANES.includes(lane);
    assert.equal(needsNodeTestArtifacts(plan), selected, lane);
    assert.equal(githubOutputsForPlan(plan).node_test_artifacts, String(selected), lane);
    const needs = {
      changes: { result: 'success' }, build: { result: 'success' },
      ...Object.fromEntries(Object.values(PRIMARY_LANE_JOBS).map((job) => [job, { result: 'success' }])),
      'evm-node-test-artifacts': { result: 'skipped' },
      'evm-devnet-test-artifacts': { result: 'success' },
      'abi-freshness': { result: 'success' }, solidity: { result: 'success' },
      'solidity-coverage': { result: 'skipped' }, 'tornado-static-analysis': { result: 'success' },
    };
    const errors = validatePrimaryResults({ eventName: 'pull_request', plan, needs });
    assert.deepEqual(errors, selected ? ['evm-node-test-artifacts was selected but ended with skipped'] : [], lane);
  }
});

test('aggregate gate accepts the full-push and docs-only job shapes', () => {
  const laneJobs = Object.values(PRIMARY_LANE_JOBS);
  const full = planCi({ eventName: 'push' });
  const fullNeeds = {
    changes: { result: 'success' },
    build: { result: 'success' },
    ...Object.fromEntries(laneJobs.map((job) => [job, { result: 'success' }])),
    'abi-freshness': { result: 'success' },
    solidity: { result: 'skipped' },
    'solidity-coverage': { result: 'success' },
    'tornado-static-analysis': { result: 'success' },
    'evm-node-test-artifacts': { result: 'success' },
    'evm-devnet-test-artifacts': { result: 'success' },
  };
  assert.deepEqual(validatePrimaryResults({ eventName: 'push', plan: full, needs: fullNeeds }), []);

  const missingNodeArtifacts = structuredClone(fullNeeds);
  missingNodeArtifacts['evm-node-test-artifacts'].result = 'skipped';
  assert.match(
    validatePrimaryResults({ eventName: 'push', plan: full, needs: missingNodeArtifacts }).join('\n'),
    /evm-node-test-artifacts was selected but ended with skipped/,
  );

  const missingDevnetArtifacts = structuredClone(fullNeeds);
  missingDevnetArtifacts['evm-devnet-test-artifacts'].result = 'skipped';
  assert.match(
    validatePrimaryResults({ eventName: 'push', plan: full, needs: missingDevnetArtifacts }).join('\n'),
    /evm-devnet-test-artifacts was selected but ended with skipped/,
  );

  const mergeNeeds = structuredClone(fullNeeds);
  mergeNeeds['solidity-coverage'].result = 'skipped';
  assert.match(validatePrimaryResults({
    eventName: 'merge_group',
    plan: full,
    needs: mergeNeeds,
  }).join('\n'), /solidity was selected but ended with skipped/);

  mergeNeeds.solidity.result = 'success';
  assert.deepEqual(validatePrimaryResults({
    eventName: 'merge_group',
    plan: full,
    needs: mergeNeeds,
  }), []);
  assert.deepEqual(validateEvmResults({
    eventName: 'merge_group',
    plan: full,
    needs: { plan: { result: 'success' }, 'evm-integration': { result: 'success' } },
  }), []);

  const docs = pullRequestPlan([change('CHANGELOG.md')]);
  const docsNeeds = {
    changes: { result: 'success' },
    build: { result: 'skipped' },
    ...Object.fromEntries(laneJobs.map((job) => [job, { result: 'skipped' }])),
    'abi-freshness': { result: 'skipped' },
    solidity: { result: 'skipped' },
    'solidity-coverage': { result: 'skipped' },
    'tornado-static-analysis': { result: 'skipped' },
    'evm-node-test-artifacts': { result: 'skipped' },
    'evm-devnet-test-artifacts': { result: 'skipped' },
  };
  assert.deepEqual(validatePrimaryResults({ eventName: 'pull_request', plan: docs, needs: docsNeeds }), []);
  assert.deepEqual(validateEvmResults({
    eventName: 'pull_request',
    plan: docs,
    needs: { plan: { result: 'success' }, 'evm-integration': { result: 'skipped' } },
  }), []);

  const malformed = structuredClone(docs);
  delete malformed.lanes.tornado_agent;
  assert.match(validateEvmResults({
    eventName: 'pull_request',
    plan: malformed,
    needs: { plan: { result: 'success' }, 'evm-integration': { result: 'skipped' } },
  }).join('\n'), /tornado_agent must be a boolean/);

  assert.match(validateEvmResults({
    eventName: 'merge_group',
    plan: docs,
    needs: { plan: { result: 'success' }, 'evm-integration': { result: 'skipped' } },
  }).join('\n'), /merge_group events must use full CI mode/);
});

test('EPCIS capture/query edits require the live Blazegraph lane', () => {
  assert.ok(WORKSPACE_RULES['packages/epcis'].lanes.includes('tornado_blazegraph'));
  assert.ok(WORKSPACE_OWNING_LANES['packages/epcis'].includes('tornado_blazegraph'));
  const workflow = parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
  const steps = workflow.jobs['tornado-blazegraph'].steps;
  const run = steps.find(step => step.run?.includes('test/external-event-query.test.ts'));
  assert.ok(run);
  assert.match(run.run, /DKG_REQUIRE_BLAZEGRAPH=1[^\n]*test\/external-event-query\.test\.ts/);
  assert.ok(run.env.BLAZEGRAPH_TEST_URL);
});

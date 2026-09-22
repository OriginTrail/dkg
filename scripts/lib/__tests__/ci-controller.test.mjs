import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { ciJobRow, COVERAGE_JOBS } from '../ci-lanes.mjs';
import { EVM_SCOPES, NODE_TEST_ARTIFACT_LANES, githubOutputsForPlan } from '../ci-delta.mjs';
import { PRIMARY_LANE_JOBS } from '../ci-results.mjs';
import { CONTROLLER_POLICY_FILES, validateTrustedControllerPins } from '../../ci/trusted-controller-pins.mjs';
import {
  NON_SOLIDITY_LANES,
  REPO_ROOT,
  gateNeeds,
  selectedLanes,
  succeeded,
} from './ci-plan-fixtures.mjs';

// The trusted controller: the plan-ci/assert-ci-results CLIs, their pinned
// sparse checkout, and how the workflows wire planner outputs to jobs.

// This SHA is already reachable from the protected default branch. Candidate
// changes may update workflow wiring, but the planner and aggregate gates must
// continue to execute only reviewed policy from this immutable controller.
const TRUSTED_CI_CONTROLLER_SHA = '780f14aa60c39bdca788967121085c3c0d82d85c';

function workflowJobBlock(workflow, jobName) {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow must define ${jobName}`);
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

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
  const readerVariables = new Set(['CI_CANDIDATE_REPO', 'CI_DIFF_BASE_SHA', 'CI_DIFF_HEAD_SHA']);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !readerVariables.has(name)),
  );
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

test('every rotation shim is recorded next to the controller pin', () => {
  // Compatibility paths for older pinned controllers must be listed where the
  // next rotation happens, so they are deleted with it rather than lingering.
  const source = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  const { jobs } = parse(source);
  const start = source.indexOf('# Rotation shims:');
  assert.notEqual(start, -1, 'ci.yml must list its rotation shims next to the controller pin');
  const note = source.slice(start, source.indexOf('- name: Checkout trusted CI controller', start));
  const recorded = [...note.matchAll(/^\s*#\s+- (.+)$/gm)].map(([, entry]) => entry.trim());
  const shims = [
    ...Object.entries(jobs.changes.outputs)
      .filter(([, value]) => String(value).includes('||'))
      .map(([name]) => `jobs.changes.outputs.${name} fallback`),
    ...jobs['ci-gate'].steps
      .filter((step) => step.name === 'Require selected Windows lifecycle tests')
      .map((step) => `ci-gate step "${step.name}"`),
  ];
  assert.deepEqual(recorded.sort(), shims.sort());
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

  const primaryNeeds = gateNeeds();
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
      NEEDS_JSON: JSON.stringify(gateNeeds(succeeded('build', 'kosava-supporting'))),
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
  // Both planners must see the same manifest contents for the same diff, and
  // no workflow may reintroduce SHA-sampled full runs.
  const manifestReader = 'export CI_CANDIDATE_REPO=candidate CI_DIFF_BASE_SHA="${BASE_SHA}" CI_DIFF_HEAD_SHA="${MERGE_SHA}"';
  for (const [name, source] of [['ci.yml', workflow], ['evm-integration.yml', evmWorkflow]]) {
    assert.ok(source.includes(manifestReader), `${name} must expose the manifest reader inputs`);
    assert.equal(source.includes('--sample-key'), false, `${name} must not request audit sampling`);
  }
  assert.match(evmWorkflow, /^  evm-gate:/m);

  const demoManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'demo/package.json'), 'utf8'));
  assert.match(demoManifest.scripts.test, /kafka-streams\/test\/\*\.mjs/);
  assert.match(demoManifest.scripts.test, /epcis-bike\/test\/\*\.mjs/);
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

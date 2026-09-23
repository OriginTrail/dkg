import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { EVM_SCOPES, MANIFEST_READER_ENV, NODE_TEST_ARTIFACT_LANES, githubOutputsForPlan } from '../ci-delta.mjs';
import { PRIMARY_LANE_JOBS } from '../ci-results.mjs';
import { CONTROLLER_POLICY_FILES, validateTrustedControllerPins } from '../../ci/trusted-controller-pins.mjs';
import { fetchPinnedController, pinnedControllerRef } from '../../ci/fetch-trusted-controller.mjs';
import {
  NON_SOLIDITY_LANES,
  REPO_ROOT,
  gateNeeds,
  selectedLanes,
  succeeded,
  workflowJobCommands,
} from './ci-plan-fixtures.mjs';
import { importSpecifiers } from './load-graph.mjs';

// The trusted controller: the plan-ci/assert-ci-results CLIs, their pinned
// sparse checkout, and how the workflows wire planner outputs to jobs.

// This SHA is already reachable from the protected default branch. Candidate
// changes may update workflow wiring, but the planner and aggregate gates must
// continue to execute only reviewed policy from this immutable controller.
const TRUSTED_CI_CONTROLLER_SHA = '780f14aa60c39bdca788967121085c3c0d82d85c';

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
  const readerVariables = new Set(Object.values(MANIFEST_READER_ENV));
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
  // As the workflow diffs it: the checked-out candidate and its first parent.
  const diff = (head) => {
    git('checkout', '-q', '--detach', head);
    return {
      [MANIFEST_READER_ENV.repository]: repository,
      [MANIFEST_READER_ENV.base]: git('rev-parse', `${head}^1`),
      [MANIFEST_READER_ENV.head]: head,
    };
  };

  assert.equal(mode(diff(exportsHead)), 'delta');
  assert.equal(mode(diff(dependencyHead)), 'full');
  assert.equal(mode({}), 'full', 'no reader without the workflow variables');
  assert.equal(mode({ ...diff(exportsHead), [MANIFEST_READER_ENV.base]: 'HEAD~2' }), 'full', 'only object IDs are accepted');
  assert.equal(mode({ ...diff(exportsHead), [MANIFEST_READER_ENV.base]: '0'.repeat(40) }), 'full', 'missing blobs fail closed');
  // A pair the planner cannot corroborate keeps full CI: the same commit on
  // both sides (which would make any edit look like formatting), a base that
  // is not the head's first parent, or a head that is not the checkout.
  assert.equal(mode({ ...diff(dependencyHead), [MANIFEST_READER_ENV.base]: dependencyHead }), 'full', 'base equal to head');
  assert.equal(mode({ ...diff(dependencyHead), [MANIFEST_READER_ENV.base]: base }), 'full', 'base is an older ancestor');
  assert.equal(mode({ ...diff(dependencyHead), [MANIFEST_READER_ENV.base]: base, [MANIFEST_READER_ENV.head]: exportsHead }), 'full', 'head is not the checkout');
  // The routed change list must be the pair's diff: an extra path, even a
  // harmless one, leaves the manifest on full CI.
  fs.writeFileSync(changesPath, Buffer.from('M\0packages/agent/package.json\0M\0packages/agent/README.md\0'));
  assert.equal(mode(diff(exportsHead)), 'full', 'routed changes differ from the diff');
});

// Every CI-policy script a workflow step runs must come from the trusted
// checkout, however the other checkout is named or the path is spelled, and
// whether the step runs it directly or through a root package.json script, a
// shell script, a local composite action or a local reusable workflow.
function untrustedPolicyRuns(workflowSource, readRepoFile) {
  return workflowJobCommands(workflowSource, { readRepoFile })
    .flatMap(({ commands }) => commands)
    .flatMap((text) => [...text.matchAll(/(\S*?)scripts\/ci\/(?:plan-ci|assert-ci-results)\.mjs\b/g)])
    .filter(([, prefix]) => prefix !== 'trusted-ci/')
    .map(([reference]) => reference);
}

test('workflows execute the planner and aggregate gates from one immutable trusted checkout', () => {
  const workflows = new Map([
    ['primary', fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')],
    ['evm', fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/evm-integration.yml'), 'utf8')],
  ]);

  for (const [name, workflow] of workflows) {
    assert.match(TRUSTED_CI_CONTROLLER_SHA, /^[0-9a-f]{40}$/);
    assert.match(workflow, /node trusted-ci\/scripts\/ci\/plan-ci\.mjs\b/);
    assert.match(workflow, /node trusted-ci\/scripts\/ci\/assert-ci-results\.mjs\b/);
    assert.deepEqual(untrustedPolicyRuns(workflow), [], `${name} must not execute CI policy from the merge candidate`);
  }
  for (const prefix of ['', './', 'candidate/', '$GITHUB_WORKSPACE/candidate/']) {
    const tampered = [
      'jobs:',
      '  plan:',
      '    steps:',
      '      - run: node trusted-ci/scripts/ci/plan-ci.mjs --event push',
      `      - run: node ${prefix}scripts/ci/plan-ci.mjs --event push`,
    ].join('\n');
    assert.deepEqual(untrustedPolicyRuns(tampered), [`${prefix}scripts/ci/plan-ci.mjs`], prefix || '(bare path)');
  }
  // An indirect invocation is followed to the command it runs.
  const repoFiles = {
    'package.json': JSON.stringify({ scripts: { 'ci:plan': 'pnpm run ci:plan:inner', 'ci:plan:inner': 'bash scripts/plan.sh' } }),
    'scripts/plan.sh': 'node scripts/ci/plan-ci.mjs --event push\n',
    '.github/actions/gate/action.yml': 'runs:\n  using: composite\n  steps:\n    - run: node candidate/scripts/ci/assert-ci-results.mjs\n      shell: bash\n',
    '.github/workflows/reusable.yml': 'jobs:\n  plan:\n    steps:\n      - run: node ./scripts/ci/plan-ci.mjs --event push\n',
  };
  const indirect = [
    'jobs:',
    '  plan:',
    '    steps:',
    '      - run: pnpm ci:plan',
    '      - uses: ./.github/actions/gate',
    '  reuse:',
    '    uses: ./.github/workflows/reusable.yml',
  ].join('\n');
  assert.deepEqual(untrustedPolicyRuns(indirect, (file) => repoFiles[file]), [
    'scripts/ci/plan-ci.mjs',
    'candidate/scripts/ci/assert-ci-results.mjs',
    './scripts/ci/plan-ci.mjs',
  ]);

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
  const { jobs: primaryJobs } = parse(primaryWorkflow);
  assert.equal(
    primaryJobs['abi-freshness'].if,
    "needs.changes.outputs.abi_freshness == 'true'",
    'ABI freshness must use the trusted planner output once the controller is protected',
  );
  assert.equal(
    primaryJobs.changes.outputs.abi_freshness,
    '${{ steps.plan.outputs.abi_freshness }}',
    'the trusted planner output must be exposed to the ABI freshness job',
  );
  assert.ok(
    primaryJobs.changes.steps.every((step) => !String(step.run ?? '').includes('candidate/scripts/ci/check-tracked-text-nul.mjs')),
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
  // next rotation happens, so they are deleted with it rather than lingering:
  // output fallbacks, any term in a lane job's condition besides its own
  // lane's output (the current planner selects every lane a job runs for),
  // and the gate's own Windows check.
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
    ...Object.entries(PRIMARY_LANE_JOBS).flatMap(([lane, job]) => String(jobs[job].if).split('||')
      .map((term) => term.trim().match(/^needs\.changes\.outputs\.(\w+) == 'true'$/)?.[1] ?? term.trim())
      .filter((output) => output !== lane)
      .map((output) => `jobs.${job}.if ${output} term`)),
    ...jobs['ci-gate'].steps
      .filter((step) => step.name === 'Require selected Windows lifecycle tests')
      .map((step) => `ci-gate step "${step.name}"`),
  ];
  assert.deepEqual(recorded.sort(), shims.sort());
});

test('the build job fetches the pinned controller through the canonical pin validator', () => {
  // The pinned-parser check below reads the pinned controller from git
  // history. The build job's shallow checkout fetches it by the ref the pin
  // validator derives, so workflow layout cannot change which ref it fetches.
  assert.equal(pinnedControllerRef(), TRUSTED_CI_CONTROLLER_SHA);
  const calls = [];
  fetchPinnedController({ run: (...call) => calls.push(call) });
  assert.deepEqual(calls, [['git', ['fetch', '--no-tags', '--depth=1', 'origin', TRUSTED_CI_CONTROLLER_SHA], { stdio: 'inherit' }]]);
  const { steps } = parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')).jobs.build;
  const fetch = steps.findIndex(({ run = '' }) => run.trim() === 'node scripts/ci/fetch-trusted-controller.mjs');
  const scriptTests = steps.findIndex(({ run = '' }) => run.includes('pnpm run test:scripts'));
  assert.ok(fetch !== -1 && fetch < scriptTests, 'the fetch runs before the repository-script tests');
});

test('workflow controller invocations stay within the current and pinned parsers', () => {
  // Until a rotation lands, workflows run the pinned controller with this
  // branch's wiring; afterwards they run the current one. Both strict parsers
  // must accept every flag, and the manifest reader inputs must be exported
  // before planning.
  const parserOptions = (source) => new Set(
    [...source.matchAll(/^\s+'?([a-z][a-z-]*)'?: \{ type:/gm)].map(([, option]) => option),
  );
  const scripts = ['plan-ci', 'assert-ci-results'];
  const current = Object.fromEntries(scripts.map((script) => [
    script,
    parserOptions(fs.readFileSync(path.join(REPO_ROOT, `scripts/ci/${script}.mjs`), 'utf8')),
  ]));
  // The build job fetches the pinned revision before running this suite; a
  // missing revision fails rather than silently skipping the pinned half.
  let pinned;
  try {
    pinned = Object.fromEntries(scripts.map((script) => [script, parserOptions(execFileSync('git', [
      '-C', REPO_ROOT, 'cat-file', 'blob', `${TRUSTED_CI_CONTROLLER_SHA}:scripts/ci/${script}.mjs`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))]));
  } catch {
    assert.fail(`pinned controller ${TRUSTED_CI_CONTROLLER_SHA} is not in this checkout; run: node scripts/ci/fetch-trusted-controller.mjs`);
  }

  let invocations = 0;
  for (const name of ['ci.yml', 'evm-integration.yml']) {
    const { jobs } = parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows', name), 'utf8'));
    for (const { run = '' } of Object.values(jobs).flatMap((job) => job.steps ?? [])) {
      for (const script of scripts) {
        const at = run.indexOf(`node trusted-ci/scripts/ci/${script}.mjs`);
        if (at === -1) continue;
        invocations++;
        const command = [];
        for (const line of run.slice(at).split('\n')) {
          command.push(line);
          if (!line.trimEnd().endsWith('\\')) break;
        }
        for (const [, flag] of command.join('\n').matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)) {
          assert.ok(current[script].has(flag), `${name} passes --${flag}, which the current ${script}.mjs rejects`);
          assert.ok(pinned[script].has(flag), `${name} passes --${flag}, which the pinned ${script}.mjs rejects`);
        }
        if (script === 'plan-ci') {
          const exported = run.indexOf(`export ${MANIFEST_READER_ENV.repository}=candidate`);
          assert.ok(exported !== -1 && exported < at, `${name} must export the manifest reader inputs before planning`);
        }
      }
    }
  }
  assert.equal(invocations, 4, 'one planner and one aggregate gate per workflow');
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
    for (const specifier of importSpecifiers(source)) {
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
  assert.equal(parse(workflow).jobs['abi-freshness'].if, "needs.changes.outputs.abi_freshness == 'true'");
  // The shared build runs on the planner's run_node, passed through unchanged.
  assert.equal(parse(workflow).jobs.changes.outputs.run_node, '${{ steps.plan.outputs.run_node }}');
  assert.equal(parse(workflow).jobs.build.if, "needs.changes.outputs.run_node == 'true'");
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
  // The workflows must export exactly the names plan-ci.mjs reads.
  const { repository, base, head } = MANIFEST_READER_ENV;
  const manifestReader = `export ${repository}=candidate ${base}="\${BASE_SHA}" ${head}="\${MERGE_SHA}"`;
  for (const [name, source] of [['ci.yml', workflow], ['evm-integration.yml', evmWorkflow]]) {
    assert.ok(source.includes(manifestReader), `${name} must expose the manifest reader inputs`);
    assert.equal(source.includes('--sample-key'), false, `${name} must not request audit sampling`);
  }
  assert.match(evmWorkflow, /^  evm-gate:/m);
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

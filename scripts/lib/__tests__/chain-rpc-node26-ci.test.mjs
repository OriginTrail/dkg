import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { githubOutputsForPlan, planCi } from '../ci-delta.mjs';
import { NODE26_REQUIRED_ASSERTIONS, validateNode26Evidence, validatePrimaryResults } from '../ci-results.mjs';
import { CONTROLLER_POLICY_FILES, validateTrustedControllerPins } from '../../ci/trusted-controller-pins.mjs';
import { EXPECTED_NODE26_ASSERTIONS, REPO_ROOT, TRUSTED_CI_CONTROLLER_SHA, change, gateNeeds, node26Evidence, pullRequestPlan, succeeded } from './ci-plan-fixtures.mjs';
import { workspaceClosure } from './ci-execution-graph.mjs';

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const workflow = parse(read('.github/workflows/ci.yml'));
const selectedPlan = pullRequestPlan([change('packages/chain/src/rpc-http1-dispatcher.ts')]);
const goodNeeds = () => gateNeeds(succeeded(Object.keys(gateNeeds())));
const errorsFor = (needs, plan = selectedPlan) => validatePrimaryResults({ eventName: 'pull_request', plan, needs });

// Fixtures deliberately synthesize outcomes. Actual runtime evidence comes from
// run-chain-rpc-node26.mjs; passing these tests alone does not activate the pin.
test('Node 26 routing covers callers, helpers, shared dependencies, runtime and policy inputs', () => {
  for (const file of [
    'packages/chain/src/rpc-http1-dispatcher.ts',
    'packages/chain/src/rpc-request-transport.ts',
    'packages/chain/src/strict-current-finalized-evm-rpc-client.ts',
    'packages/chain/src/evm-adapter.ts',
    'packages/chain/test/rpc-http1-dispatcher.unit.test.ts',
    'packages/chain/test/helpers/local-tls.ts',
    'packages/chain/test/helpers/chain-rpc-fetch-child.mjs',
    'packages/chain/test/fixtures/localhost-tls/localhost-cert.pem',
    'packages/chain/vitest.unit.config.ts', 'packages/chain/package.json',
    'pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', '.npmrc', '.nvmrc',
    'packages/cli/package.json', 'packages/agent/package.json',
    'packages/cli/scripts/verify-node-sqlite-runtime.mjs',
    'test-policy/test-routes.json', 'test-policy/README.md',
    '.github/workflows/ci.yml', '.github/workflows/chain-rpc-node26.yml',
    ...CONTROLLER_POLICY_FILES,
    ...[...workspaceClosure(['packages/chain'])].map((workspace) => `${workspace}/src/index.ts`),
  ]) {
    const plan = pullRequestPlan([change(file)]);
    assert.equal(plan.lanes.chain_rpc_node26, true, file);
    assert.equal(githubOutputsForPlan(plan).chain_rpc_node26, 'true', file);
  }
  // Check the call sites from source, so a new caller outside chain is visible.
  for (const file of ['packages/chain/src/rpc-request-transport.ts', 'packages/chain/src/strict-current-finalized-evm-rpc-client.ts']) {
    assert.match(read(file), /import.*chainRpcFetch.*rpc-http1-dispatcher/);
  }
});

test('irrelevant and docs-only PRs explicitly omit Node 26; full and release dispatch require it', () => {
  for (const file of ['packages/network-sim/src/index.ts', 'packages/node-ui/src/ui/pages/Dashboard.tsx', 'docs/ci-delta-policy.md', 'CHANGELOG.md']) {
    const plan = pullRequestPlan([change(file)]);
    assert.equal(plan.lanes.chain_rpc_node26, false, file);
    assert.equal(githubOutputsForPlan(plan).chain_rpc_node26, 'false', file);
    const needs = goodNeeds();
    needs['chain-rpc-node26'] = { result: 'skipped' };
    assert.deepEqual(errorsFor(needs, plan), [], file);
    delete needs['chain-rpc-node26'];
    assert.match(errorsFor(needs, plan).join('\n'), /chain-rpc-node26 is missing/);
  }
  for (const plan of [
    ...['merge_group', 'push', 'schedule', 'workflow_dispatch'].map((eventName) => planCi({ eventName })),
    pullRequestPlan([change('CHANGELOG.md')], { labels: ['ci:full'] }),
    planCi({ eventName: 'pull_request_delta_disabled', changeEntries: [change('CHANGELOG.md')] }),
  ]) assert.equal(plan.lanes.chain_rpc_node26, true, plan.mode);
});

test('selected Node 26 failure, cancellation, skip, missing job or missing plan flag blocks', (t) => {
  assert.deepEqual(errorsFor(goodNeeds()), []);
  for (const status of ['failure', 'cancelled', 'skipped', 'missing']) {
    const needs = goodNeeds();
    if (status === 'missing') delete needs['chain-rpc-node26'];
    else needs['chain-rpc-node26'].result = status;
    assert.ok(errorsFor(needs).some((error) => error.includes('chain-rpc-node26')), status);
    t.diagnostic(`${status}: aggregate rejects selected Node 26 job`);
  }
  const malformed = structuredClone(selectedPlan);
  delete malformed.lanes.chain_rpc_node26;
  assert.match(errorsFor(goodNeeds(), malformed).join('\n'), /chain_rpc_node26 must be a boolean/);
  const full = planCi({ eventName: 'merge_group' });
  full.lanes.chain_rpc_node26 = false;
  assert.match(validatePrimaryResults({ eventName: 'merge_group', plan: full, needs: goodNeeds() }).join('\n'), /Full CI mode must select every/);
});

test('the Node 26 validator requires all four independent transport obligations', () => {
  assert.deepEqual([...NODE26_REQUIRED_ASSERTIONS].sort(), [...EXPECTED_NODE26_ASSERTIONS].sort());
  assert.deepEqual(validateNode26Evidence(node26Evidence()), []);
});

test('green jobs with wrong runtime, generic-only or malformed evidence block', () => {
  const cases = [
    { ...node26Evidence(), node: '22.23.2', undici: '6.23.0' },
    { ...node26Evidence(), requireUndici8Fetch: false },
    { ...node26Evidence(), assertions: [{ name: 'generic test', status: 'passed' }] },
    { ...node26Evidence(), success: false },
    { ...node26Evidence(), version: 2 },
    null,
  ];
  for (const evidence of cases) {
    assert.ok(validateNode26Evidence(evidence).length);
    const needs = goodNeeds();
    needs['chain-rpc-node26'].outputs.evidence = JSON.stringify(evidence);
    assert.ok(errorsFor(needs).length, JSON.stringify(evidence));
  }
  for (const output of [undefined, '{broken']) {
    const needs = goodNeeds();
    needs['chain-rpc-node26'].outputs.evidence = output;
    assert.ok(errorsFor(needs).length);
  }
});

test('every independent Node 26 obligation rejects missing, failed, skipped or duplicated evidence', async (t) => {
  for (const name of EXPECTED_NODE26_ASSERTIONS) {
    for (const status of ['missing', 'failed', 'pending', 'skipped', 'todo', 'duplicated']) {
      await t.test(`${status}: ${name}`, () => {
        const evidence = node26Evidence();
        const assertion = evidence.assertions.find((entry) => entry.name === name);
        if (status === 'missing') evidence.assertions = evidence.assertions.filter((entry) => entry.name !== name);
        else if (status === 'duplicated') evidence.assertions.push({ ...assertion });
        else assertion.status = status;
        assert.ok(validateNode26Evidence(evidence).some((error) => error.includes(name)), `${status} obligation must fail validation: ${name}`);
        const needs = goodNeeds();
        needs['chain-rpc-node26'].outputs.evidence = JSON.stringify(evidence);
        assert.ok(errorsFor(needs).some((error) => error.includes(name)), `${status} obligation must block the aggregate: ${name}`);
      });
    }
  }
});

function controllerCopy(t, ref) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-node26-controller-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of CONTROLLER_POLICY_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), ref
      ? execFileSync('git', ['-C', REPO_ROOT, 'show', `${ref}:${file}`])
      : read(file));
  }
  return root;
}
const gate = (root, plan, needs, eventName = 'pull_request') => spawnSync(process.execPath, [
  path.join(root, 'scripts/ci/assert-ci-results.mjs'), '--workflow', 'primary',
], { cwd: root, encoding: 'utf8', env: { ...process.env, EVENT_NAME: eventName, PLAN_JSON: JSON.stringify(plan), NEEDS_JSON: JSON.stringify(needs) } });

test('a deliberately failed required assertion makes the candidate aggregate CLI exit 1', (t) => {
  const root = controllerCopy(t);
  const needs = goodNeeds();
  const evidence = node26Evidence();
  evidence.assertions.at(-1).status = 'failed';
  needs['chain-rpc-node26'].outputs.evidence = JSON.stringify(evidence);
  const result = gate(root, selectedPlan, needs);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /first request of a fresh process/);
  t.diagnostic(`Controlled failing assertion, green job result: aggregate exit ${result.status}; ${result.stderr.trim()}`);
  assert.equal(gate(root, selectedPlan, goodNeeds()).status, 0);
});

test('rollout supplies the workflow before rotating: old/new controllers accept their compatible plans', (t) => {
  const oldRoot = controllerCopy(t, TRUSTED_CI_CONTROLLER_SHA);
  const newRoot = controllerCopy(t);
  for (const eventName of ['pull_request', 'merge_group', 'workflow_dispatch']) {
    const changes = path.join(oldRoot, 'changes.z');
    const output = path.join(oldRoot, 'github-output');
    fs.writeFileSync(changes, Buffer.from('M\0CHANGELOG.md\0'));
    fs.writeFileSync(output, '');
    const planner = spawnSync(process.execPath, [path.join(oldRoot, 'scripts/ci/plan-ci.mjs'), '--event', eventName, '--changes-z', changes, '--github-output', output], { encoding: 'utf8' });
    assert.equal(planner.status, 0, planner.stderr);
    const oldPlan = JSON.parse(planner.stdout);
    assert.equal(oldPlan.lanes.chain_rpc_node26, undefined);
    // Actions sees no old output; the staged workflow's fallback runs it.
    assert.doesNotMatch(fs.readFileSync(output, 'utf8'), /^chain_rpc_node26=/m);
    assert.equal(workflow.jobs.changes.outputs.chain_rpc_node26, "${{ steps.plan.outputs.chain_rpc_node26 || 'true' }}");
    const needs = goodNeeds();
    assert.equal(gate(oldRoot, oldPlan, needs, eventName).status, 0);
    needs['chain-rpc-node26'].result = 'failure';
    assert.equal(gate(oldRoot, oldPlan, needs, eventName).status, 1);
    // Document the staged gap: old policy cannot enforce skipped/missing.
    needs['chain-rpc-node26'].result = 'skipped';
    assert.equal(gate(oldRoot, oldPlan, needs, eventName).status, 0);
  }
  const newPlan = planCi({ eventName: 'merge_group' });
  assert.equal(gate(newRoot, newPlan, goodNeeds(), 'merge_group').status, 0);
  const oldWorkflowNeeds = goodNeeds();
  delete oldWorkflowNeeds['chain-rpc-node26'];
  assert.equal(gate(newRoot, newPlan, oldWorkflowNeeds, 'merge_group').status, 1, 'never rotate before the workflow supplies the job');
  // Preview the separately reviewed activation without changing the real pin.
  const files = ['.github/workflows/ci.yml', '.github/workflows/evm-integration.yml'];
  const previewRef = 'a'.repeat(40);
  const previews = files.map((sourceName) => ({ sourceName, source: read(sourceName).replaceAll(TRUSTED_CI_CONTROLLER_SHA, previewRef) }));
  assert.equal(validateTrustedControllerPins(previews).ref, previewRef);
  t.diagnostic(`Staged pin remains ${TRUSTED_CI_CONTROLLER_SHA}; skipped/missing enforcement starts only after reviewed protected-history rotation.`);
});

test('one reusable implementation serves primary CI and manual candidate diagnosis', () => {
  const transport = parse(read('.github/workflows/chain-rpc-node26.yml'));
  assert.deepEqual(Object.keys(transport.on).sort(), ['workflow_call', 'workflow_dispatch']);
  assert.equal(workflow.jobs['chain-rpc-node26'].uses, './.github/workflows/chain-rpc-node26.yml');
  assert.equal(workflow.jobs['chain-rpc-node26'].if, "needs.changes.outputs.chain_rpc_node26 == 'true'");
  assert.ok(workflow.jobs['ci-gate'].needs.includes('chain-rpc-node26'));
  assert.equal(transport.on.workflow_call.outputs.evidence.value, '${{ jobs.transport.outputs.evidence }}');
  const run = transport.jobs.transport.steps.find((step) => step.id === 'transport');
  assert.equal(run.env.DKG_REQUIRE_UNDICI8_FETCH, '1');
  assert.match(run.run, /run-chain-rpc-node26\.mjs/);
  assert.equal(transport.jobs.transport.outputs.evidence, '${{ steps.transport.outputs.evidence }}');
  assert.ok(transport.jobs.transport.steps.some((step) => step.with?.['node-version'] === 26));
  assert.match(read('packages/chain/test/rpc-http1-dispatcher.unit.test.ts'), /runChainRpcChild\(server.url, \{\}\)/);
  assert.match(read('scripts/ci/run-chain-rpc-node26.mjs'), /spawnSync\(process.execPath/);
});

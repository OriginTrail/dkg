import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runZizmorSarifGate } from '../../ci/enforce-zizmor-sarif.mjs';
import {
  ciPolicyModeExitCode,
  inspectCiPolicy,
} from '../../ci/inspect-ci-policy.mjs';
import {
  CONTROLLER_POLICY_FILES,
  isProtectedHistoryComparison,
  validateTrustedControllerPins,
} from '../../ci/trusted-controller-pins.mjs';
import { evaluateEffectiveDeltaRolloutRules } from '../../ci/validate-delta-rollout-ruleset.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTROLLER_SHA = '780f14aa60c39bdca788967121085c3c0d82d85c';

function controllerCheckout({
  ref = CONTROLLER_SHA,
  repository = 'OriginTrail/dkg',
  uses = 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
  quotedPath = false,
  idFirst = false,
  controllerFiles = CONTROLLER_POLICY_FILES,
} = {}) {
  return [
    `      - ${idFirst ? 'id: controller_checkout' : 'name: Checkout trusted CI controller'}`,
    ...(idFirst ? ['        name: Checkout trusted CI controller'] : []),
    `        uses: ${uses}`,
    '        with:',
    `          repository: ${repository}`,
    `          ref: ${ref}`,
    `          path: ${quotedPath ? '"trusted-ci"' : 'trusted-ci'}`,
    '          sparse-checkout: |',
    ...controllerFiles.map((filePath) => `            ${filePath}`),
    '          sparse-checkout-cone-mode: false',
  ].join('\n');
}

function workflowFixture({
  planCheckout = controllerCheckout(),
  gateCheckout = controllerCheckout(),
  unrelated = '',
  planCheckoutAfterConsumer = false,
} = {}) {
  const planConsumer = `      - name: Plan
        run: node trusted-ci/scripts/ci/plan-ci.mjs --event pull_request`;
  return `
name: fixture
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
${unrelated}${planCheckoutAfterConsumer ? `${planConsumer}\n${planCheckout}` : `${planCheckout}\n${planConsumer}`}
  gate:
    runs-on: ubuntu-latest
    steps:
${gateCheckout}
      - name: Gate
        run: node trusted-ci/scripts/ci/assert-ci-results.mjs --workflow primary
`;
}

const unrelatedCheckout = `      - name: Unrelated checkout
        uses: actions/checkout@${'1'.repeat(40)}
        with:
          repository: example/tool
          ref: ${'2'.repeat(40)}
          path: tooling
`;

test('controller validation models quoted and id-first YAML and ignores unrelated checkouts', () => {
  const result = validateTrustedControllerPins([{
    sourceName: 'ci.yml',
    source: workflowFixture({
      unrelated: unrelatedCheckout,
      planCheckout: controllerCheckout({ quotedPath: true, idFirst: true }),
    }),
  }]);
  assert.equal(result.ref, CONTROLLER_SHA);
  assert.equal(result.checkouts.length, 2);
});

test('controller validation rejects missing, inconsistent, fake, and over-broad checkouts', () => {
  assert.throws(
    () => validateTrustedControllerPins([{
      sourceName: 'missing.yml', source: workflowFixture({ planCheckout: '' }),
    }]),
    /expected one trusted-ci checkout, found 0/,
  );
  assert.throws(
    () => validateTrustedControllerPins([{
      sourceName: 'inconsistent.yml',
      source: workflowFixture({ gateCheckout: controllerCheckout({ ref: 'a'.repeat(40) }) }),
    }]),
    /different refs/,
  );
  assert.throws(
    () => validateTrustedControllerPins([{
      sourceName: 'fake.yml',
      source: workflowFixture({
        planCheckout: controllerCheckout({ uses: `attacker/action@${'3'.repeat(40)}` })
          .replace('name: Checkout', `name: fake actions/checkout@${'4'.repeat(40)} Checkout`),
      }),
    }]),
    /must use actions\/checkout/,
  );
  assert.throws(
    () => validateTrustedControllerPins([{
      sourceName: 'broad.yml',
      source: workflowFixture({
        planCheckout: controllerCheckout({ controllerFiles: ['scripts/ci', 'scripts/lib'] }),
      }),
    }]),
    /canonical controller file list/,
  );
  assert.throws(
    () => validateTrustedControllerPins([{
      sourceName: 'untrusted-repository.yml',
      source: workflowFixture({
        planCheckout: controllerCheckout({ repository: 'attacker/fork' }),
      }),
    }]),
    /must use OriginTrail\/dkg/,
  );
  assert.throws(
    () => validateTrustedControllerPins([{
      sourceName: 'mutable-ref.yml',
      source: workflowFixture({ planCheckout: controllerCheckout({ ref: 'main' }) }),
    }]),
    /immutable 40-character ref/,
  );
  assert.throws(
    () => validateTrustedControllerPins([{
      sourceName: 'late-checkout.yml',
      source: workflowFixture({ planCheckoutAfterConsumer: true }),
    }]),
    /must precede its controller consumer/,
  );
});

test('repository workflows expose one canonical protected-history controller pin', () => {
  const result = validateTrustedControllerPins([
    {
      sourceName: 'ci.yml',
      source: fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'),
    },
    {
      sourceName: 'evm-integration.yml',
      source: fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/evm-integration.yml'), 'utf8'),
    },
  ]);
  assert.equal(result.ref, CONTROLLER_SHA);
  assert.equal(result.checkouts.length, 4);
  assert.ok(CONTROLLER_POLICY_FILES.includes('scripts/ci/plan-ci.mjs'));
  assert.equal(
    CONTROLLER_POLICY_FILES.includes('scripts/ci/enforce-zizmor-sarif.mjs'),
    false,
    'unrelated security helpers must not trigger controller rotation',
  );
  assert.equal(isProtectedHistoryComparison('identical'), true);
  assert.equal(isProtectedHistoryComparison('ahead'), true);
  assert.equal(isProtectedHistoryComparison('diverged'), false, 'candidate-only history must fail');

  const freshnessWorkflow = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/supply-chain-scan.yml'),
    'utf8',
  );
  assert.equal(freshnessWorkflow.match(/node scripts\/ci\/inspect-ci-policy\.mjs/g)?.length, 2);
  assert.doesNotMatch(freshnessWorkflow, /repos\/\$\{GITHUB_REPOSITORY\}\/rulesets/);
  assert.doesNotMatch(freshnessWorkflow, /git diff --quiet/);
});

test('testnet delta rollout requires PRs, merge queue, and both aggregate gates', () => {
  const effectiveRules = [
    { type: 'pull_request', ruleset_id: 10 },
    { type: 'merge_queue', ruleset_id: 20 },
    {
      type: 'required_status_checks',
      ruleset_id: 20,
      parameters: {
        required_status_checks: [
          { context: 'CI gate' },
          { context: 'EVM integration gate' },
        ],
      },
    },
  ];
  const layered = evaluateEffectiveDeltaRolloutRules({
    branch: 'testnet-canary', rules: effectiveRules,
  });
  assert.equal(layered.ok, true, 'protections split across effective rulesets must aggregate');
  assert.deepEqual(layered.rulesetIds, ['10', '20']);

  assert.equal(evaluateEffectiveDeltaRolloutRules({
    branch: 'testnet-canary',
    rules: effectiveRules.filter((rule) => rule.type !== 'pull_request'),
  }).ok, false);
  assert.equal(evaluateEffectiveDeltaRolloutRules({
    branch: 'testnet-canary',
    rules: effectiveRules.filter((rule) => rule.type !== 'merge_queue'),
  }).ok, false);
  assert.equal(evaluateEffectiveDeltaRolloutRules({
    branch: 'testnet-canary',
    rules: effectiveRules.map((rule) => (
      rule.type === 'required_status_checks'
        ? { ...rule, parameters: { required_status_checks: [{ context: 'CI gate' }] } }
        : rule
    )),
  }).ok, false);
  assert.equal(evaluateEffectiveDeltaRolloutRules({
    branch: 'testnet-canary', rules: [],
  }).ok, false, 'an excluded, inactive, or other-branch ruleset is absent from effective rules');
});

test('one effective policy snapshot drives hard-gate and informational modes', async () => {
  const requestedEndpoints = [];
  const effectiveRules = [
    { type: 'pull_request', ruleset_id: 1 },
    { type: 'merge_queue', ruleset_id: 2 },
    {
      type: 'required_status_checks',
      ruleset_id: 2,
      parameters: {
        required_status_checks: [
          { context: 'CI gate' },
          { context: 'EVM integration gate' },
        ],
      },
    },
  ];
  const requestJson = async (endpoint) => {
    requestedEndpoints.push(endpoint);
    if (endpoint === 'repos/OriginTrail/dkg') return { default_branch: 'main' };
    if (endpoint.includes('/compare/')) return { status: 'ahead' };
    if (endpoint === 'repos/OriginTrail/dkg/rules/branches/testnet-canary') return effectiveRules;
    if (endpoint.includes('/contents/')) return { sha: 'same-controller-blob' };
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  const snapshot = await inspectCiPolicy({
    repository: 'OriginTrail/dkg',
    branch: 'testnet-canary',
    workflows: [{ sourceName: 'fixture.yml', source: workflowFixture() }],
    token: 'test-token',
    requestJson,
  });
  assert.equal(snapshot.prerequisites.ok, true);
  assert.equal(snapshot.freshness.ok, true);
  assert.equal(ciPolicyModeExitCode(snapshot, 'enforce'), 0);
  assert.equal(ciPolicyModeExitCode(snapshot, 'report'), 0);
  assert.ok(requestedEndpoints.includes('repos/OriginTrail/dkg/rules/branches/testnet-canary'));
  assert.equal(requestedEndpoints.some((endpoint) => endpoint.includes('/rulesets')), false);

  const missingPrerequisites = { ...snapshot, prerequisites: { ok: false } };
  assert.equal(ciPolicyModeExitCode(missingPrerequisites, 'enforce'), 1);
  assert.equal(ciPolicyModeExitCode(missingPrerequisites, 'report'), 0);
});

test('zizmor SARIF gate accepts clean output and rejects findings, failures, and wrong tools', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-zizmor-gate-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const sarifPath = path.join(temporaryDirectory, 'zizmor.sarif');
  const writeSarif = (results, driverName = 'zizmor') => fs.writeFileSync(sarifPath, JSON.stringify({
    version: '2.1.0',
    runs: [{ tool: { driver: { name: driverName } }, results }],
  }));

  writeSarif([]);
  assert.equal(runZizmorSarifGate(['--sarif', sarifPath, '--scan-outcome', 'success']), 0);

  writeSarif([{ ruleId: 'unpinned-uses', message: { text: 'mutable action ref' } }]);
  assert.equal(runZizmorSarifGate(['--sarif', sarifPath, '--scan-outcome', 'success']), 1);
  writeSarif([]);
  assert.equal(runZizmorSarifGate(['--sarif', sarifPath, '--scan-outcome', 'failure']), 1);

  fs.writeFileSync(sarifPath, JSON.stringify({ version: '2.1.0', runs: [{}] }));
  assert.equal(runZizmorSarifGate(['--sarif', sarifPath, '--scan-outcome', 'success']), 1);
  writeSarif([], 'another-scanner');
  assert.equal(runZizmorSarifGate(['--sarif', sarifPath, '--scan-outcome', 'success']), 1);
  fs.writeFileSync(sarifPath, '{not-json');
  assert.equal(runZizmorSarifGate(['--sarif', sarifPath, '--scan-outcome', 'success']), 2);
});

test('supply-chain workflow preserves SARIF upload and gates findings plus audit events', () => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/supply-chain-scan.yml'),
    'utf8',
  );
  assert.match(workflow, /^        id: zizmor_scan$/m);
  assert.match(workflow, /^        continue-on-error: true$/m);
  assert.match(workflow, /if: \|\n\s+always\(\)/);
  assert.match(workflow, /SCAN_OUTCOME: \$\{\{ steps\.zizmor_scan\.outcome \}\}/);
  assert.match(workflow, /node scripts\/ci\/enforce-zizmor-sarif\.mjs/);
  assert.match(workflow, /^  ci-policy-prerequisites:$/m);
  assert.match(workflow, /Verify controller provenance and testnet rollout safeguards/);
  assert.match(workflow, /- 'pnpm-lock\.yaml'/);
  assert.match(workflow, /- '\*\*\/package\.json'/);
  assert.match(workflow, /^  schedule:$/m);
  assert.match(workflow, /^  workflow_dispatch:$/m);

  const auditStart = workflow.indexOf('  npm-audit:\n');
  const auditRemainder = workflow.slice(auditStart + '  npm-audit:\n'.length);
  const auditEnd = auditRemainder.search(/^  [a-zA-Z0-9_-]+:\n/m);
  const auditBlock = auditEnd === -1 ? auditRemainder : auditRemainder.slice(0, auditEnd);
  assert.doesNotMatch(auditBlock, /^    if:/m);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runZizmorSarifGate } from '../../ci/enforce-zizmor-sarif.mjs';
import {
  CONTROLLER_POLICY_FILES,
  isProtectedHistoryComparison,
  validateTrustedControllerPins,
} from '../../ci/trusted-controller-pins.mjs';
import { evaluateDeltaRolloutRulesets } from '../../ci/validate-delta-rollout-ruleset.mjs';

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

function workflowFixture({ planCheckout = controllerCheckout(), gateCheckout = controllerCheckout(), unrelated = '' } = {}) {
  return `
name: fixture
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
${unrelated}${planCheckout}
      - name: Plan
        run: node trusted-ci/scripts/ci/plan-ci.mjs --event pull_request
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
  assert.match(freshnessWorkflow, /compare\/\$\{CONTROLLER_PINNED\}\.\.\.\$\{DEFAULT_BRANCH\}/);
  assert.match(freshnessWorkflow, /--validate-provenance-status "\$\{CONTROLLER_PROVENANCE\}"/);
  assert.match(freshnessWorkflow, /--list-controller-files/);
  assert.match(freshnessWorkflow, /git diff --quiet[^\n]*"\$\{CONTROLLER_FILES\[@\]\}"/);
});

test('testnet delta rollout requires PRs, merge queue, and both aggregate gates', () => {
  const validRuleset = {
    name: 'protect-testnet-canary',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/testnet-canary'], exclude: [] } },
    rules: [
      { type: 'pull_request' },
      { type: 'merge_queue' },
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [
            { context: 'CI gate' },
            { context: 'EVM integration gate' },
          ],
        },
      },
    ],
  };
  assert.equal(evaluateDeltaRolloutRulesets({
    branch: 'testnet-canary', rulesets: [validRuleset],
  }).ok, true);
  assert.equal(evaluateDeltaRolloutRulesets({
    branch: 'testnet-canary',
    rulesets: [{ ...validRuleset, rules: validRuleset.rules.filter((rule) => rule.type !== 'merge_queue') }],
  }).ok, false);
  assert.equal(evaluateDeltaRolloutRulesets({
    branch: 'testnet-canary',
    rulesets: [{
      ...validRuleset,
      rules: validRuleset.rules.map((rule) => (
        rule.type === 'required_status_checks'
          ? { ...rule, parameters: { required_status_checks: [{ context: 'CI gate' }] } }
          : rule
      )),
    }],
  }).ok, false);
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

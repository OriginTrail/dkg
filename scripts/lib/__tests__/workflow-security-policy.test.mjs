import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  inspectCiPolicyFreshness,
  inspectCiPolicyProtections,
  parseCiPolicyArguments,
  renderCiPolicyReport,
  runCiPolicyInspector,
} from '../../ci/inspect-ci-policy.mjs';
import {
  CONTROLLER_POLICY_FILES,
  isProtectedHistoryComparison,
  validateTrustedControllerPins,
} from '../../ci/trusted-controller-pins.mjs';
import {
  evaluateEffectiveDeltaRolloutRules,
  GITHUB_ACTIONS_INTEGRATION_ID,
  rulesetIdsRequiringDetails,
  TESTNET_CANARY_ROLLOUT_POLICY,
} from '../../ci/validate-delta-rollout-ruleset.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTROLLER_SHA = '780f14aa60c39bdca788967121085c3c0d82d85c';

function rulesetDetail(id, overrides = {}) {
  return {
    id: Number(id),
    enforcement: 'active',
    source_type: 'Repository',
    source: TESTNET_CANARY_ROLLOUT_POLICY.repository,
    target: 'branch',
    bypass_actors: [],
    conditions: {
      ref_name: { include: ['refs/heads/testnet-canary'], exclude: [] },
    },
    ...overrides,
  };
}

function rulesetDetailsFor(rules) {
  return rulesetIdsRequiringDetails(rules).map((rulesetId) => rulesetDetail(rulesetId));
}

function evaluateDeltaRules(rules, rulesets = rulesetDetailsFor(rules)) {
  return evaluateEffectiveDeltaRolloutRules({
    rules,
    rulesets,
  });
}

function controllerCheckout({
  ref = CONTROLLER_SHA,
  repository = TESTNET_CANARY_ROLLOUT_POLICY.repository,
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
  ci-gate:
    needs: [plan]
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

  const reordered = validateTrustedControllerPins([{
    sourceName: 'reordered.yml',
    source: workflowFixture({
      planCheckout: controllerCheckout({ controllerFiles: [...CONTROLLER_POLICY_FILES].reverse() }),
    }),
  }]);
  assert.equal(reordered.ref, CONTROLLER_SHA, 'manifest membership must not impose file ordering');
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
  assert.throws(
    () => validateTrustedControllerPins([{
      sourceName: 'missing-sparse-checkout.yml',
      source: workflowFixture().replace(
        /          sparse-checkout: \|\n(?:            .*\n)+?          sparse-checkout-cone-mode: false\n/,
        '',
      ),
    }]),
    /trusted checkout needs a sparse-checkout file list/,
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
  assert.equal(CONTROLLER_POLICY_FILES.length, 4);
  assert.equal(CONTROLLER_POLICY_FILES.includes('scripts/ci/inspect-ci-policy.mjs'), false);
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
  assert.equal(freshnessWorkflow.match(/node scripts\/ci\/inspect-ci-policy\.mjs/g)?.length, 1);
  assert.match(freshnessWorkflow, /--summary "\$\{GITHUB_STEP_SUMMARY\}"/);
  assert.doesNotMatch(freshnessWorkflow, /\.controller\.tree|\.deltaRollout/);
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
          { context: 'CI gate', integration_id: GITHUB_ACTIONS_INTEGRATION_ID },
          { context: 'EVM integration gate', integration_id: GITHUB_ACTIONS_INTEGRATION_ID },
        ],
      },
    },
  ];
  const layered = evaluateDeltaRules(effectiveRules);
  assert.equal(layered.ok, true, 'protections split across effective rulesets must aggregate');
  assert.deepEqual(layered.rulesetIds, ['10', '20']);

  assert.equal(evaluateDeltaRules(
    effectiveRules.filter((rule) => rule.type !== 'pull_request'),
  ).ok, false);
  assert.equal(evaluateDeltaRules(
    effectiveRules.filter((rule) => rule.type !== 'merge_queue'),
  ).ok, false);
  assert.equal(evaluateDeltaRules(
    effectiveRules.map((rule) => (
      rule.type === 'required_status_checks'
        ? {
          ...rule,
          parameters: {
            required_status_checks: [{
              context: 'CI gate', integration_id: GITHUB_ACTIONS_INTEGRATION_ID,
            }],
          },
        }
        : rule
    )),
  ).ok, false);
  assert.equal(evaluateDeltaRules([]).ok, false,
    'an excluded, inactive, or other-branch ruleset is absent from effective rules');

  const wrongIntegration = structuredClone(effectiveRules);
  wrongIntegration[2].parameters.required_status_checks[0].integration_id = 999;
  assert.equal(evaluateDeltaRules(wrongIntegration).ok, false,
    'a context from the wrong integration must not impersonate the Actions gate');

  const bypassedRuleset = rulesetDetailsFor(effectiveRules).map((ruleset) => (
    ruleset.id === 20
      ? { ...ruleset, bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }] }
      : ruleset
  ));
  assert.equal(evaluateDeltaRules(effectiveRules, bypassedRuleset).ok, false,
    'merge-capable bypass actors must fail the safeguard report');

  const invalidDetails = [
    ['inactive enforcement', { enforcement: 'evaluate' }, /repository enforcement/],
    ['wrong source type', { source_type: 'Organization' }, /repository enforcement/],
    ['wrong repository', { source: 'example/fork' }, /repository enforcement/],
    ['wrong target', { target: 'tag' }, /repository enforcement/],
    [
      'wrong branch',
      { conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } } },
      /exact branch binding/,
    ],
    ['hidden bypass actors', { bypass_actors: undefined }, /authoritative bypass configuration/],
    ['malformed bypass actors', { bypass_actors: null }, /authoritative bypass configuration/],
  ];
  for (const [name, override, expectedMissing] of invalidDetails) {
    const details = rulesetDetailsFor(effectiveRules).map((ruleset) => (
      ruleset.id === 20 ? { ...ruleset, ...override } : ruleset
    ));
    const verdict = evaluateDeltaRules(effectiveRules, details);
    assert.equal(verdict.ok, false, name);
    assert.match(verdict.missing.join('\n'), expectedMissing, name);
  }
  const missingDetails = evaluateDeltaRules(
    effectiveRules,
    rulesetDetailsFor(effectiveRules).filter((ruleset) => ruleset.id !== 20),
  );
  assert.equal(missingDetails.ok, false);
  assert.match(missingDetails.missing.join('\n'), /ruleset 20 details/);
});

test('protection inspection excludes controller freshness acquisition', async () => {
  const requestedEndpoints = [];
  const effectiveRules = [
    { type: 'pull_request', ruleset_id: 1 },
    { type: 'merge_queue', ruleset_id: 2 },
    {
      type: 'required_status_checks',
      ruleset_id: 2,
      parameters: {
        required_status_checks: [
          { context: 'CI gate', integration_id: GITHUB_ACTIONS_INTEGRATION_ID },
          { context: 'EVM integration gate', integration_id: GITHUB_ACTIONS_INTEGRATION_ID },
        ],
      },
    },
  ];
  const requestJson = async (endpoint) => {
    requestedEndpoints.push(endpoint);
    if (endpoint.includes('/compare/')) return { status: 'ahead' };
    if (endpoint === 'repos/OriginTrail/dkg/rules/branches/testnet-canary?per_page=100&page=1') {
      return effectiveRules;
    }
    if (endpoint.startsWith('repos/OriginTrail/dkg/rulesets/')) {
      return rulesetDetail(endpoint.split('/').at(-1));
    }
    if (endpoint.includes('/contents/')) return { sha: 'same-controller-blob' };
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  const inspection = await inspectCiPolicyProtections({
    workflows: [{ sourceName: 'fixture.yml', source: workflowFixture() }],
    token: 'test-token',
    requestJson,
  });
  assert.equal(inspection.checks.provenance.status, 'pass');
  assert.equal(inspection.checks.rollout.status, 'pass');
  assert.equal(inspection.checks.freshness.status, 'not-run');
  assert.equal(
    requestedEndpoints.some((endpoint) => endpoint.includes('/contents/')),
    false,
    'the ruleset check must not acquire controller-tree freshness',
  );

  const snapshot = await inspectCiPolicyFreshness({
    inspection,
    token: 'test-token',
    requestJson,
  });
  assert.equal(snapshot.checks.provenance.status, 'pass');
  assert.equal(snapshot.checks.rollout.status, 'pass');
  assert.equal(snapshot.checks.freshness.status, 'pass');
  assert.ok(requestedEndpoints.includes(
    'repos/OriginTrail/dkg/rules/branches/testnet-canary?per_page=100&page=1',
  ));
  assert.equal(
    requestedEndpoints.filter((endpoint) => endpoint.includes('/contents/')).length,
    CONTROLLER_POLICY_FILES.length * 2,
  );
  assert.deepEqual(
    requestedEndpoints.filter((endpoint) => endpoint.includes('/rulesets/')).sort(),
    ['repos/OriginTrail/dkg/rulesets/1', 'repos/OriginTrail/dkg/rulesets/2'],
  );
});

test('effective policy inspection reads every rules page and rejects malformed pages', async () => {
  const effectiveRulesEndpoint = 'repos/OriginTrail/dkg/rules/branches/testnet-canary';
  const requestedRulePages = [];
  const requestJson = async (endpoint) => {
    if (endpoint.includes('/compare/')) return { status: 'identical' };
    if (endpoint.includes('/contents/')) return { sha: 'same-controller-blob' };
    if (endpoint.startsWith(effectiveRulesEndpoint)) {
      requestedRulePages.push(endpoint);
      if (endpoint.endsWith('page=1')) {
        return Array.from({ length: 100 }, (_, index) => ({
          type: 'creation', ruleset_id: index + 1,
        }));
      }
      if (endpoint.endsWith('page=2')) {
        return [
          { type: 'pull_request', ruleset_id: 101 },
          { type: 'merge_queue', ruleset_id: 101 },
          {
            type: 'required_status_checks',
            ruleset_id: 101,
            parameters: {
              required_status_checks: [
                { context: 'CI gate', integration_id: GITHUB_ACTIONS_INTEGRATION_ID },
                { context: 'EVM integration gate', integration_id: GITHUB_ACTIONS_INTEGRATION_ID },
              ],
            },
          },
        ];
      }
    }
    if (endpoint === 'repos/OriginTrail/dkg/rulesets/101') return rulesetDetail(101);
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  const input = {
    workflows: [{ sourceName: 'fixture.yml', source: workflowFixture() }],
    token: 'test-token',
  };
  const snapshot = await inspectCiPolicyProtections({ ...input, requestJson });
  assert.equal(snapshot.checks.provenance.status, 'pass');
  assert.equal(snapshot.checks.rollout.status, 'pass');
  assert.deepEqual(requestedRulePages, [
    `${effectiveRulesEndpoint}?per_page=100&page=1`,
    `${effectiveRulesEndpoint}?per_page=100&page=2`,
  ]);

  const malformed = await inspectCiPolicyProtections({
    ...input,
    requestJson: async (endpoint) => (
      endpoint.startsWith(effectiveRulesEndpoint) ? {} : requestJson(endpoint)
    ),
  });
  assert.equal(malformed.checks.provenance.status, 'pass');
  assert.equal(malformed.checks.rollout.status, 'error');
  assert.match(malformed.checks.rollout.error, /returned a non-array page/);
});

test('executable policy inspector reports every state without becoming a merge gate', async (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-ci-policy-inspector-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const workflowPath = path.join(temporaryDirectory, 'workflow.yml');
  const outputPath = path.join(temporaryDirectory, 'snapshot.json');
  const summaryPath = path.join(temporaryDirectory, 'summary.md');
  fs.writeFileSync(workflowPath, workflowFixture());

  const validRules = [
    { type: 'pull_request', ruleset_id: 1 },
    { type: 'merge_queue', ruleset_id: 1 },
    {
      type: 'required_status_checks',
      ruleset_id: 1,
      parameters: {
        required_status_checks: [
          { context: 'CI gate', integration_id: GITHUB_ACTIONS_INTEGRATION_ID },
          { context: 'EVM integration gate', integration_id: GITHUB_ACTIONS_INTEGRATION_ID },
        ],
      },
    },
  ];
  const validRequest = async (endpoint) => {
    if (endpoint.includes('/compare/')) return { status: 'identical' };
    if (endpoint.includes('/rules/branches/')) return validRules;
    if (endpoint.startsWith('repos/OriginTrail/dkg/rulesets/')) {
      return rulesetDetail(endpoint.split('/').at(-1));
    }
    if (endpoint.includes('/contents/')) return { sha: 'same-controller-blob' };
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  const args = [
    '--workflow', workflowPath,
    '--output', outputPath,
    '--summary', summaryPath,
  ];

  assert.equal(await runCiPolicyInspector(args, {
    token: 'test-token',
    requestJson: validRequest,
  }), 0);
  let snapshot = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(snapshot.checks.provenance.status, 'pass');
  assert.equal(snapshot.checks.rollout.status, 'pass');
  assert.equal(snapshot.checks.freshness.status, 'pass');

  assert.equal(await runCiPolicyInspector(args, {
    token: 'test-token',
    requestJson: async (endpoint) => (
      endpoint.includes('/rules/branches/') ? [] : validRequest(endpoint)
    ),
  }), 0, 'a scheduled report must surface drift without becoming a candidate-controlled gate');
  snapshot = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(snapshot.checks.provenance.status, 'pass');
  assert.equal(snapshot.checks.rollout.status, 'fail');
  assert.equal(snapshot.checks.freshness.status, 'pass');

  assert.equal(await runCiPolicyInspector(args, {
    token: 'test-token',
    requestJson: async () => { throw new Error('policy API unavailable'); },
  }), 0);
  snapshot = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(snapshot.checks.provenance.status, 'error');
  assert.equal(snapshot.checks.rollout.status, 'error');
  assert.equal(snapshot.checks.freshness.status, 'error');
  assert.match(snapshot.checks.provenance.error, /policy API unavailable/);
  assert.match(snapshot.checks.rollout.error, /policy API unavailable/);

  assert.equal(await runCiPolicyInspector(args, {
    token: 'test-token',
    requestJson: async (endpoint) => {
      if (endpoint.includes('/contents/')) throw new Error('freshness API unavailable');
      return validRequest(endpoint);
    },
  }), 0);
  snapshot = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(snapshot.checks.provenance.status, 'pass');
  assert.equal(snapshot.checks.rollout.status, 'pass');
  assert.equal(snapshot.checks.freshness.status, 'error');
  assert.match(snapshot.checks.freshness.error, /freshness API unavailable/);
  assert.match(fs.readFileSync(summaryPath, 'utf8'), /⚠ unable to inspect/);
});

test('policy report renderer owns clean, drift, safeguard, and acquisition statuses', () => {
  const clean = {
    version: 2,
    policy: TESTNET_CANARY_ROLLOUT_POLICY,
    controller: {
      pin: CONTROLLER_SHA,
      protectedBranches: ['main', 'testnet-canary'],
      freshnessBranch: 'testnet-canary',
    },
    checks: {
      provenance: { status: 'pass', details: { protectedHistory: 'main' } },
      rollout: { status: 'pass', details: { missing: [] } },
      freshness: { status: 'pass', details: { driftedFiles: [] } },
    },
  };
  const cleanReport = renderCiPolicyReport(clean);
  assert.equal(cleanReport.warnings.length, 0);
  assert.match(cleanReport.markdown, /trusted CI controller.*✓ current/);
  assert.match(cleanReport.markdown, /testnet-canary delta safeguards.*✓ current/);

  const driftReport = renderCiPolicyReport({
    ...clean,
    checks: {
      ...clean.checks,
      freshness: {
        status: 'fail', details: { driftedFiles: ['scripts/ci/plan-ci.mjs'] },
      },
    },
  });
  assert.match(driftReport.markdown, /⚠ policy drift/);
  assert.match(driftReport.warnings.join('\n'), /differs from testnet-canary/);

  const untrustedReport = renderCiPolicyReport({
    ...clean,
    checks: {
      ...clean.checks,
      provenance: {
        status: 'fail',
        details: { comparisons: [{ branch: 'main', status: 'diverged' }] },
      },
      freshness: { status: 'not-run' },
    },
  });
  assert.match(untrustedReport.markdown, /⚠ untrusted provenance/);
  assert.match(untrustedReport.warnings.join('\n'), /not in protected main or testnet-canary/);

  const missingReport = renderCiPolicyReport({
    ...clean,
    checks: {
      ...clean.checks,
      rollout: { status: 'fail', details: { missing: ['merge_queue'] } },
    },
  });
  assert.match(missingReport.markdown, /⚠ safeguards missing/);
  assert.match(missingReport.warnings.join('\n'), /merge_queue/);

  const failedReport = renderCiPolicyReport({
    version: 2,
    policy: TESTNET_CANARY_ROLLOUT_POLICY,
    controller: { pin: null },
    checks: {
      provenance: { status: 'error', error: 'GitHub API unavailable' },
      rollout: { status: 'error', error: 'GitHub API unavailable' },
      freshness: { status: 'not-run' },
    },
  });
  assert.match(failedReport.markdown, /⚠ unable to inspect/);
  assert.match(failedReport.warnings.join('\n'), /GitHub API unavailable/);
});

test('real policy CLIs use strict parsers with intentional repeat behavior', () => {
  const policyOptions = parseCiPolicyArguments([
    '--workflow', 'ci.yml',
    '--workflow', 'evm.yml',
  ]);
  assert.deepEqual(policyOptions.workflows, ['ci.yml', 'evm.yml']);
  assert.equal(TESTNET_CANARY_ROLLOUT_POLICY.repository, 'OriginTrail/dkg');
  assert.equal(TESTNET_CANARY_ROLLOUT_POLICY.branch, 'testnet-canary');
  assert.throws(
    () => parseCiPolicyArguments([
      '--repository', 'example/fork', '--workflow', 'ci.yml',
    ]),
    /Unknown option|unknown option/i,
  );
  assert.throws(
    () => parseCiPolicyArguments(['--mode', 'enforce', '--workflow', 'ci.yml']),
    /Unknown option|unknown option/i,
  );
  assert.throws(
    () => parseCiPolicyArguments([]),
    /at least one workflow is required/,
  );
});

test('supply-chain workflow preserves SARIF upload and gates findings plus audit events', (t) => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/supply-chain-scan.yml'),
    'utf8',
  );
  assert.match(workflow, /^        id: zizmor_scan$/m);
  assert.match(workflow, /^        continue-on-error: true$/m);
  assert.match(workflow, /if: \|\n\s+always\(\)/);
  assert.match(workflow, /SCAN_OUTCOME: \$\{\{ steps\.zizmor_scan\.outcome \}\}/);
  assert.doesNotMatch(workflow, /enforce-zizmor-sarif\.mjs/);
  assert.match(workflow, /jq -e/);
  assert.doesNotMatch(workflow, /^  ci-policy-prerequisites:$/m);
  assert.match(workflow, /- 'pnpm-lock\.yaml'/);
  assert.match(workflow, /- '\*\*\/package\.json'/);
  assert.match(workflow, /^  schedule:$/m);
  assert.match(workflow, /^  workflow_dispatch:$/m);

  const workflowModel = parseYaml(workflow);
  const verdictStep = workflowModel.jobs.zizmor.steps.find(
    (step) => step.name === 'Enforce zizmor verdict',
  );
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-zizmor-gate-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const runVerdict = (sarif, scanOutcome = 'success') => {
    fs.writeFileSync(
      path.join(temporaryDirectory, 'zizmor.sarif'),
      typeof sarif === 'string' ? sarif : JSON.stringify(sarif),
    );
    return spawnSync('bash', ['-c', verdictStep.run], {
      cwd: temporaryDirectory,
      env: { ...process.env, SCAN_OUTCOME: scanOutcome },
      encoding: 'utf8',
    });
  };
  const sarif = (results = [], driverName = 'zizmor') => ({
    version: '2.1.0',
    runs: [{ tool: { driver: { name: driverName } }, results }],
  });
  assert.equal(runVerdict(sarif()).status, 0);
  assert.notEqual(runVerdict(sarif([{ ruleId: 'unpinned-uses' }])).status, 0);
  assert.notEqual(runVerdict(sarif(), 'failure').status, 0);
  assert.notEqual(runVerdict(sarif([], 'another-scanner')).status, 0);
  assert.notEqual(runVerdict({ version: '2.1.0', runs: [{}] }).status, 0);
  assert.notEqual(runVerdict('{not-json').status, 0);

  const auditStart = workflow.indexOf('  npm-audit:\n');
  const auditRemainder = workflow.slice(auditStart + '  npm-audit:\n'.length);
  const auditEnd = auditRemainder.search(/^  [a-zA-Z0-9_-]+:\n/m);
  const auditBlock = auditEnd === -1 ? auditRemainder : auditRemainder.slice(0, auditEnd);
  assert.doesNotMatch(auditBlock, /^    if:/m);

  const primaryWorkflow = parseYaml(fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/ci.yml'),
    'utf8',
  ));
  assert.equal(primaryWorkflow.jobs['ci-policy-prerequisites'], undefined);
  assert.equal(primaryWorkflow.jobs['ci-gate'].needs.includes('ci-policy-prerequisites'), false);
  assert.doesNotMatch(
    fs.readFileSync(path.join(REPO_ROOT, 'scripts/lib/ci-results.mjs'), 'utf8'),
    /requireSuccess\(needs, 'ci-policy-prerequisites', true, errors\)/,
    'candidate-controlled aggregates must not claim the scheduled report as a prerequisite',
  );
});

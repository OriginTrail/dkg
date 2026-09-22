import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  CI_LANES,
  EVM_SCOPES,
  NODE_EVM_LANES,
  WORKSPACE_OWNING_EVM_SCOPES,
  WORKSPACE_OWNING_LANES,
  WORKSPACE_RULES,
  githubOutputsForPlan,
  parseNameStatusZ,
  planCi,
} from '../ci-delta.mjs';
import { validatePrimaryResults } from '../ci-results.mjs';
import {
  LANE_JOBS,
  NON_SOLIDITY_LANES,
  REPO_ROOT,
  change,
  gateNeeds,
  pullRequestPlan,
  selectedLanes,
  succeeded,
} from './ci-plan-fixtures.mjs';

// Planner policy: event handling, fail-closed inputs, the Solidity gate and
// the workspace routing table. Path routing lives in ci-delta-routing.test.mjs,
// controller wiring in ci-controller.test.mjs, the aggregate gate in
// ci-results.test.mjs.

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

  const needs = gateNeeds(succeeded(
    'build',
    'abi-freshness',
    'tornado-static-analysis',
    'evm-node-test-artifacts',
    'evm-devnet-test-artifacts',
    LANE_JOBS,
  ));
  assert.match(
    validatePrimaryResults({ eventName: 'pull_request', plan, needs }).join('\n'),
    /solidity was selected but ended with skipped/,
  );
  needs.solidity.result = 'success';
  assert.deepEqual(validatePrimaryResults({ eventName: 'pull_request', plan, needs }), []);
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
    'tornado_agent_windows',
    'bura_cli',
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
    'tornado_agent_windows',
    'bura_cli',
    'bura_query',
    'kosava_node_ui',
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

test('control-plane changes force full Node/EVM CI without overriding the Solidity gate', () => {
  const controlPlanePaths = [
    '.github/workflows/ci.yml',
    '.github/workflows/evm-integration.yml',
    '.github/workflows/rfc64-inventory-windows.yml',
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

test('every reusable workflow the gated workflows call is CI control plane', () => {
  // A workflow that ci.yml or evm-integration.yml runs through `uses:` decides
  // what their aggregate gates mean, so editing one must keep full CI.
  const called = ['ci.yml', 'evm-integration.yml'].flatMap((name) => {
    const { jobs } = parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows', name), 'utf8'));
    return Object.values(jobs)
      .map((job) => job.uses)
      .filter((uses) => typeof uses === 'string' && uses.startsWith('./.github/workflows/'))
      .map((uses) => uses.slice(2));
  });
  assert.ok(called.includes('.github/workflows/rfc64-inventory-windows.yml'));
  for (const filePath of called) {
    assert.equal(pullRequestPlan([change(filePath)]).mode, 'full', filePath);
  }
});

test('ordinary network-sim changes remain a narrow delta after the trust hardening', () => {
  const plan = pullRequestPlan([change('packages/network-sim/src/index.ts')]);
  assert.equal(plan.mode, 'delta');
  assert.equal(plan.fullCi, false);
  assert.deepEqual(selectedLanes(plan), ['kosava_supporting']);
  assert.deepEqual(plan.evmScopes, []);
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
  assert.equal(gatePlan.buildChecks, false);
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

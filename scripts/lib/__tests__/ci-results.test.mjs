import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CI_LANES,
  NODE_TEST_ARTIFACT_LANES,
  githubOutputsForPlan,
  needsNodeTestArtifacts,
  planCi,
} from '../ci-delta.mjs';
import { PRIMARY_LANE_JOBS, validateEvmResults, validatePrimaryResults } from '../ci-results.mjs';
import { LANE_JOBS, change, gateNeeds, pullRequestPlan, succeeded } from './ci-plan-fixtures.mjs';

// The aggregate gates: which job results each plan shape accepts or rejects.

test('a build-only plan requires the shared build and nothing else', () => {
  const plan = pullRequestPlan([change('bench/store-read-latency.bench.ts')]);
  const needs = gateNeeds(succeeded('build'));
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

test('aggregate gates reject failed or accidentally skipped selected jobs', () => {
  const plan = pullRequestPlan([change('packages/network-sim/src/index.ts')]);
  const needs = gateNeeds(succeeded('build'));
  needs['kosava-supporting'].result = 'success';
  assert.deepEqual(validatePrimaryResults({ eventName: 'pull_request', plan, needs }), []);

  needs['kosava-supporting'].result = 'skipped';
  assert.match(validatePrimaryResults({ eventName: 'pull_request', plan, needs }).join('\n'), /selected/);

  const fullNonContract = pullRequestPlan(
    [change('scripts/unrelated-maintenance.mjs')],
    { labels: ['ci:full'] },
  );
  const fullNonContractNeeds = gateNeeds(succeeded(
    'build',
    'evm-node-test-artifacts',
    'evm-devnet-test-artifacts',
    LANE_JOBS,
  ));
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
    const needs = gateNeeds(succeeded(
      'build',
      LANE_JOBS,
      'evm-devnet-test-artifacts',
      'abi-freshness',
      'solidity',
      'tornado-static-analysis',
    ));
    const errors = validatePrimaryResults({ eventName: 'pull_request', plan, needs });
    assert.deepEqual(errors, selected ? ['evm-node-test-artifacts was selected but ended with skipped'] : [], lane);
  }
});

test('aggregate gate accepts the full-push and docs-only job shapes', () => {
  const full = planCi({ eventName: 'push' });
  const fullNeeds = gateNeeds(succeeded(
    'build',
    LANE_JOBS,
    'abi-freshness',
    'solidity-coverage',
    'tornado-static-analysis',
    'evm-node-test-artifacts',
    'evm-devnet-test-artifacts',
  ));
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
  const docsNeeds = gateNeeds();
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

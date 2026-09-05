import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';
import {
  AGENT_REPO_ROOT, AGENT_TIMINGS, AGENT_UNIT_CONFIG, AGENT_INTEGRATION_CONFIG,
  agentShardConfig, discoverAgentTests, planAgentShards,
} from '../../ci/plan-agent-shards.mjs';
import { planWeightedShards } from '../../ci/plan-vitest-shard.mjs';

test('agent shards match actual Vitest discovery exactly once and separate the unit config', () => {
  const discovered = new Map();
  const discover = (config, root) => {
    if (!discovered.has(config)) discovered.set(config, discoverAgentTests(config, root));
    return discovered.get(config);
  };
  const shards = planAgentShards(AGENT_REPO_ROOT, { discover });
  const files = shards.flatMap((shard) => shard.files);
  assert.equal(shards.length, 10);
  assert.equal(new Set(files).size, files.length, 'no file may belong to two shards');
  assert.deepEqual([...files].sort(), discovered.get(AGENT_INTEGRATION_CONFIG));
  assert.deepEqual(shards.filter((shard) => shard.config === AGENT_UNIT_CONFIG)
    .flatMap((shard) => shard.files).sort(), discovered.get(AGENT_UNIT_CONFIG));
  for (const shard of shards) {
    assert.ok(shard.files.length > 0);
    // Positionals are substring filters, so verify the actual resolved files
    // for each invocation as well as the mathematical partition.
    assert.deepEqual(discoverAgentTests(shard.config, AGENT_REPO_ROOT, shard.files), shard.files);
  }
  assert.deepEqual(planAgentShards(AGENT_REPO_ROOT, { discover }), shards);
  assert.ok(AGENT_TIMINGS.bodyWeightsMs['test/rfc64-inventory-v1-lifecycle.test.ts'] > 100_000);
});

test('shards reserve sidecar time and fail closed on malformed timing inputs', () => {
  const plan = planWeightedShards({
    files: ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'],
    bodyWeightsMs: { 'test/a.test.ts': 50_000, 'test/b.test.ts': 45_000, 'test/c.test.ts': 5_000 },
    shardCount: 2, perFileOverheadMs: 0, shardOverheadMs: [0, 40_000],
  });
  assert.deepEqual(plan.map((shard) => shard.files), [['test/a.test.ts', 'test/c.test.ts'], ['test/b.test.ts']]);
  for (const overhead of [[0], [0, -1], [0, Infinity]]) {
    assert.throws(() => planWeightedShards({
      files: ['a', 'b'], bodyWeightsMs: {}, shardCount: 2, shardOverheadMs: overhead,
    }), /one non-negative overhead per shard/);
  }
});

test('agent executable validates its fixed matrix and advertises the matching config', () => {
  const script = path.join(AGENT_REPO_ROOT, 'packages/agent/scripts/ci-shard-agent.mjs');
  for (const shard of [1, 4, 5, 10]) {
    const result = spawnSync(process.execPath, [script, String(shard), '10', '--config'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), agentShardConfig(shard));
  }
  for (const args of [['0', '10'], ['11', '10'], ['1', '11'], ['1x', '10'], ['1', '10', '--bad']]) {
    assert.notEqual(spawnSync(process.execPath, [script, ...args]).status, 0);
  }
  const workflow = parse(fs.readFileSync(path.join(AGENT_REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
  const job = workflow.jobs['tornado-agent'];
  const run = job.steps.find((step) => step.name?.startsWith('Agent tests')).run;
  assert.match(run, /ci-shard-agent\.mjs.*--config/);
  assert.match(run, /-- --config "\$\{SHARD_CONFIG\}" "\$\{SHARD_FILES\[@\]\}"/);
  assert.match(run, /test "\$\{#SHARD_FILES\[@\]\}" -gt 0/);
  for (const step of job.steps.filter((step) => step.name?.startsWith('RFC-64'))) {
    assert.equal(step.if, 'matrix.shard == 10', 'evidence sidecars must match the reserved shard');
  }
});

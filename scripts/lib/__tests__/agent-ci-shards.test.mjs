import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';
import {
  AGENT_REPO_ROOT, AGENT_SHARD_COUNT, AGENT_UNIT_CONFIG, AGENT_INTEGRATION_CONFIG,
  agentShardDescriptor, discoverAgentTests, planAgentShards,
} from '../../ci/plan-agent-shards.mjs';
import { planWeightedShards } from '../../ci/plan-vitest-shard.mjs';
import { loadAgentTimings } from '../../ci/load-agent-timings.mjs';

const timings = loadAgentTimings(new URL('../../ci/timings/agent.json', import.meta.url));
const script = path.join(AGENT_REPO_ROOT, 'packages/agent/scripts/ci-shard-agent.mjs');

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
  const executableFiles = [];
  for (const shard of shards) {
    const descriptor = agentShardDescriptor(shard.index);
    assert.equal(shard.config, descriptor.config);
    assert.equal(shard.reservedOverheadMs, descriptor.reservedOverheadMs);
    assert.equal(shard.index, descriptor.index);
    const configured = spawnSync(process.execPath, [script, String(shard.index), String(AGENT_SHARD_COUNT), '--config'], { encoding: 'utf8' });
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(configured.stdout.trim(), descriptor.config);
    const executable = spawnSync(process.execPath, [script, String(shard.index), String(AGENT_SHARD_COUNT)], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(executable.status, 0, executable.stderr);
    const printed = executable.stdout.trimEnd().split('\n');
    assert.deepEqual(printed, shard.files, `actual executable shard ${shard.index}`);
    executableFiles.push(...printed);
    const expectedMs = shard.files.reduce((sum, file) => sum + (timings.bodyWeightsMs[file] ?? 60_000) + timings.perFileOverheadMs, descriptor.reservedOverheadMs);
    assert.equal(shard.estimatedMs, expectedMs);
    assert.ok(shard.files.length > 0);
    // Positionals are substring filters, so verify the actual resolved files
    // for each invocation as well as the mathematical partition.
    assert.deepEqual(discoverAgentTests(shard.config, AGENT_REPO_ROOT, shard.files), shard.files);
  }
  assert.equal(new Set(executableFiles).size, executableFiles.length);
  assert.deepEqual(executableFiles.sort(), discovered.get(AGENT_INTEGRATION_CONFIG));
  assert.deepEqual(shards.map((shard) => shard.reservedOverheadMs), [0, 0, 0, 0, 0, 0, 0, 0, 0, 40_000]);
  assert.deepEqual(planAgentShards(AGENT_REPO_ROOT, { discover }), shards);
  assert.ok(timings.bodyWeightsMs['test/rfc64-inventory-v1-lifecycle.test.ts'] > 100_000);
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

test('agent executable rejects invalid arguments and matches workflow dispatch', () => {
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

test('agent timing snapshots validate their schema and expose only frozen planning data', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-timings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'timings.json');
  const valid = { schemaVersion: 1, source: { runId: 123 }, perFileOverheadMs: 1100, bodyWeightsMs: { 'test/a.test.ts': 123 } };
  fs.writeFileSync(file, JSON.stringify(valid));
  const normalized = loadAgentTimings(file);
  assert.deepEqual(Object.keys(normalized).sort(), ['bodyWeightsMs', 'perFileOverheadMs']);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.bodyWeightsMs));
  assert.throws(() => { normalized.bodyWeightsMs['test/a.test.ts'] = 0; }, TypeError);
  for (const invalid of [
    null, { ...valid, schemaVersion: 2 }, { ...valid, perFileOverheadMs: '1100' },
    { ...valid, perFileOverheadMs: -1 }, { ...valid, perFileOverheadMs: null },
    { ...valid, bodyWeightsMs: [] }, { ...valid, bodyWeightsMs: {} },
    ...['1', -1, null].map((duration) => ({ ...valid, bodyWeightsMs: { 'test/a.test.ts': duration } })),
    { ...valid, bodyWeightsMs: { 'test/../escape.test.ts': 1 } },
  ]) {
    fs.writeFileSync(file, JSON.stringify(invalid));
    assert.throws(() => loadAgentTimings(file), /Invalid agent timing snapshot/);
  }
  fs.writeFileSync(file, '{');
  assert.throws(() => loadAgentTimings(file), /Invalid agent timing snapshot/);
});

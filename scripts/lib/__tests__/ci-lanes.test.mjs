import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { parse } from 'yaml';
import { validateCiLaneWorkflow } from '../ci-lane-workflow.mjs';
import { CI_LANE_TOPOLOGY, CI_MATRICES, COVERAGE_JOBS, compileCiTopology } from '../ci-lanes.mjs';
import { validateReceipts } from '../coverage-artifacts.mjs';
import { runVitestLanes, runVitestRow } from '../../ci/run-vitest-lanes.mjs';

const workflow = () => parse(fs.readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
test('the real workflow consumes emitted matrices and canonical row execution', () => validateCiLaneWorkflow(workflow()));
test('literal matrices and bypassing the canonical runner fail validation', () => {
  const changedMatrix = workflow();
  changedMatrix.jobs['tornado-agent'].strategy.matrix = { shard: [1] };
  assert.throws(() => validateCiLaneWorkflow(changedMatrix), /emitted matrix/);
  const missingPackage = workflow();
  for (const step of missingPackage.jobs['tornado-core'].steps) if (step.run) step.run = step.run.replace('run-vitest-lanes.mjs', 'run-vitest-junit.mjs');
  assert.throws(() => validateCiLaneWorkflow(missingPackage), /canonical row/);
});
test('one topology change updates matrix, runner denominator and required receipts', async () => {
  const topology = structuredClone(CI_LANE_TOPOLOGY);
  topology.tornado_publisher.groups[0].shards = 5;
  const compiled = compileCiTopology(topology);
  const rows = compiled.matrices['tornado-publisher'].include;
  assert.equal(rows.length, 5);
  assert.equal(rows.at(-1).label, 'publisher [5/5]');
  const executed = [];
  assert.equal(await runVitestRow('tornado-publisher', rows.at(-1).row, { topology, execute: async (...args) => { executed.push(args); return 0; } }), 0);
  assert.deepEqual(executed, [['publisher', ['--shard', '5', '--', '--shard=5/5']]]);
  const needs = Object.fromEntries(Object.keys(compiled.jobs).map((job) => [job, { result: job === 'tornado-publisher' ? 'success' : 'skipped' }]));
  const receipts = rows.map(({ shard }) => ({ version: 2, executedTests: 1, package: 'publisher', shard, revision: 'HEAD', fingerprint: 'hash', coverage: { 'src/a.ts': {} } }));
  const context = { revision: 'HEAD', fingerprint: () => 'hash', jobs: compiled.jobs };
  assert.deepEqual(validateReceipts(receipts, needs, context), ['publisher']);
  assert.throws(() => validateReceipts(receipts.slice(0, -1), needs, context), /missing coverage shards: publisher:5/);
});
test('every matrix row executes exactly the package/shard receipt obligation', async () => {
  for (const [job, { include }] of Object.entries(CI_MATRICES)) {
    const seen = [];
    for (const { row } of include) await runVitestRow(job, row, { argumentsFor: async (item) => [String(item.shard)], execute: async (lane, args) => { seen.push(`${lane}:${args[0]}`); return 0; } });
    const expected = Object.entries(COVERAGE_JOBS[job]).flatMap(([pkg, count]) => Array.from({ length: count }, (_, i) => `${pkg}:${count === 1 ? 0 : i + 1}`));
    assert.deepEqual(seen.sort(), expected.sort());
  }
});
test('bounded supporting execution finishes every lane after failures and exceptions', async () => {
  let active = 0;
  let peak = 0;
  const finished = [];
  const status = await runVitestRow('kosava-supporting', 0, { execute: async (lane, args) => {
    assert.deepEqual(args, ['--', '--maxWorkers=2']);
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--; finished.push(lane);
    if (lane === 'epcis') throw new Error('fixture spawn failure');
    return lane === 'mcp-dkg' ? 2 : 0;
  } });
  assert.equal(status, 1);
  assert.equal(peak, 3);
  assert.deepEqual(finished.sort(), Object.keys(COVERAGE_JOBS['kosava-supporting']).sort());
  assert.equal(await runVitestLanes('bura-supporting', 3, { execute: async () => 0 }), 0);
  await assert.rejects(runVitestLanes('tornado-agent'), /unsharded/);
  await assert.rejects(runVitestLanes('kosava-supporting', 0), /concurrency/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { parse } from 'yaml';
import { validateCiLaneWorkflow } from '../ci-lane-workflow.mjs';
import { COVERAGE_JOBS } from '../ci-lanes.mjs';
import { runVitestLanes } from '../../ci/run-vitest-lanes.mjs';

const workflow = () => parse(fs.readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
test('the real CI workflow agrees with canonical lanes, packages and shard counts', () => validateCiLaneWorkflow(workflow()));
test('matrix drift and a missing package invocation fail before report aggregation', () => {
  const changedMatrix = workflow();
  changedMatrix.jobs['tornado-agent'].strategy.matrix.shard.pop();
  assert.throws(() => validateCiLaneWorkflow(changedMatrix), /shard matrix/);
  const missingPackage = workflow();
  for (const step of missingPackage.jobs['tornado-core'].steps) if (step.run) step.run = step.run.replace('--lane rdf-utils', '--lane missing-package');
  assert.throws(() => validateCiLaneWorkflow(missingPackage), /package invocations/);
});
test('bounded supporting execution finishes every lane after failures and exceptions', async () => {
  let active = 0;
  let peak = 0;
  const finished = [];
  const status = await runVitestLanes('kosava-supporting', 3, { execute: async (lane) => {
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { COVERAGE_JOBS, validateReceipts } from '../coverage-artifacts.mjs';

function fixture() {
  const needs = Object.fromEntries(Object.keys(COVERAGE_JOBS).map((job) => [job, { result: 'skipped' }]));
  needs['tornado-publisher'].result = 'success';
  const receipts = [1, 2, 3, 4].map((shard) => ({ version: 2, executedTests: 1, package: 'publisher', shard: String(shard), revision: 'head', fingerprint: 'hash', coverage: { 'packages/publisher/src/a.ts': {} } }));
  return { needs, receipts, context: { revision: 'head', fingerprint: () => 'hash' } };
}

test('coverage requires every selected shard and rejects stale, duplicate or empty evidence', () => {
  const { needs, receipts, context } = fixture();
  assert.deepEqual(validateReceipts(receipts, needs, context), ['publisher']);
  assert.throws(() => validateReceipts(receipts.slice(1), needs, context), /missing coverage shards/);
  assert.throws(() => validateReceipts([...receipts, receipts[0]], needs, context), /duplicate/);
  for (const field of ['revision', 'fingerprint', 'version']) {
    const bad = structuredClone(receipts); bad[0][field] = 'old';
    assert.throws(() => validateReceipts(bad, needs, context), /stale/);
  }
  for (const value of [undefined, 0, -1, '1']) {
    const bad = structuredClone(receipts); bad[0].executedTests = value;
    assert.throws(() => validateReceipts(bad, needs, context), /no executed tests/);
  }
  const empty = structuredClone(receipts); empty[0].coverage = {};
  assert.throws(() => validateReceipts(empty, needs, context), /empty/);
  needs['tornado-publisher'].result = 'failure';
  assert.throws(() => validateReceipts(receipts, needs, context), /did not succeed/);
  delete needs['tornado-agent'];
  needs['tornado-publisher'].result = 'success';
  assert.throws(() => validateReceipts(receipts, needs, context), /missing job result/);
});

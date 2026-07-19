import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  assertNoRemoteDkgEndpoints,
  assertSafeOutputPath,
  canonicalJson,
  isolatedChildEnvironment,
  isPathInside,
  parseCommandOutput,
  parseVitestEvidence,
  percentile,
  sha256,
  summarizeMeasurements,
  validateScenarioMatrix,
} from '../wal-legacy-baseline.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

test('scenario matrix is valid and covers every mandatory WAL-000 domain', async () => {
  const matrix = validateScenarioMatrix(JSON.parse(await readFile(
    resolve(repositoryRoot, 'bench/wal-000-legacy-baseline/scenario-matrix.json'),
    'utf8',
  )));
  const coverage = new Set(Object.values(matrix.profiles).flatMap((profile) =>
    profile.scenarios.flatMap((scenario) => scenario.covers)));
  for (const required of [
    'publish', 'share', 'update', 'expiry', 'membership', 'private-access',
    'vm-activation', 'chain-finality', 'reconnect-delta', 'late-join',
    'interrupted-sync', 'restart', 'conflict',
  ]) assert.equal(coverage.has(required), true, `missing coverage: ${required}`);
  assert.equal(matrix.profiles.performance.defaultRepetitions >= 3, true);
  assert.equal(matrix.profiles.semantic.scenarios.filter((scenario) =>
    scenario.role === 'sync-characterization').length, 2);
  assert.equal(matrix.profiles.performance.scenarios.every((scenario) =>
    scenario.role === 'sync-characterization'), true);
});

test('matrix validation rejects malformed and duplicate scenarios', () => {
  assert.throws(() => validateScenarioMatrix({}), /unsupported/);
  const base = {
    schema: 'dkg-wal-000-scenario-matrix-v1', baselineId: 'x', baseRef: 'main',
    baseCommit: '0000000000000000000000000000000000000000',
    profiles: { semantic: { defaultRepetitions: 1, scenarios: [] } },
  };
  assert.throws(() => validateScenarioMatrix(base), /must contain scenarios/);
  const scenario = {
    id: 'a', category: 'x', role: 'sync-characterization', kind: 'command',
    command: 'node', args: [], covers: ['x'], timeoutMs: 1,
  };
  assert.throws(() => validateScenarioMatrix({
    ...base,
    profiles: { semantic: { defaultRepetitions: 1, scenarios: [scenario, scenario] } },
  }), /duplicate/);
});

test('canonical JSON, hashing, and percentile summaries are deterministic', () => {
  assert.equal(canonicalJson({ b: 2, a: [3, { d: 4, c: 5 }] }), '{"a":[3,{"c":5,"d":4}],"b":2}');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(percentile([9, 1, 5], 50), 5);
  assert.deepEqual(summarizeMeasurements([1, 2, 3, 100]), {
    samples: 4, minimum: 1, median: 2, p95: 100, p99: 100, maximum: 100,
  });
});

test('safety checks reject repository receipts and non-loopback endpoints', () => {
  assert.equal(isPathInside('/repo', '/repo/out'), true);
  assert.equal(isPathInside('/repo', '/tmp/out'), false);
  assert.throws(() => assertSafeOutputPath('/repo', '/repo/receipt'), /outside/);
  assert.doesNotThrow(() => assertSafeOutputPath('/repo', '/tmp/receipt'));
  assert.doesNotThrow(() => assertNoRemoteDkgEndpoints({ DKG_API_URL: 'http://127.0.0.1:9200' }));
  assert.throws(() => assertNoRemoteDkgEndpoints({ DKG_API_URL: 'https://mainnet.example' }), /non-loopback/);
  assert.throws(() => assertNoRemoteDkgEndpoints({ BASE_RPC_URL: 'https://mainnet.example' }), /non-loopback/);
  assert.throws(() => assertNoRemoteDkgEndpoints({ RPC_LOCALHOST: 'https://mainnet.example' }), /non-loopback/);
});

test('child environment strips credentials and forces isolated paths', () => {
  const environment = isolatedChildEnvironment({
    PATH: '/bin',
    ADMIN_PRIVATE_KEY: 'secret',
    DKG_AUTH_TOKEN: 'secret',
    DKG_API_URL: 'http://127.0.0.1:9200',
  }, '/tmp/run');
  assert.equal(environment.PATH, '/bin');
  assert.equal(environment.ADMIN_PRIVATE_KEY, undefined);
  assert.equal(environment.DKG_AUTH_TOKEN, undefined);
  assert.equal(environment.DKG_API_URL, undefined);
  assert.equal(environment.DKG_HOME, '/tmp/run/dkg-home');
  assert.equal(environment.TMPDIR, '/tmp/run/tmp');
  assert.equal(environment.DKG_SKIP_EVM_BUILD, '1');
});

test('Vitest and benchmark evidence parsers produce stable machine data', () => {
  const parsed = parseVitestEvidence({ testResults: [{ assertionResults: [
    { fullName: 'z test', status: 'passed' },
    { ancestorTitles: ['a'], title: 'test', status: 'failed' },
  ] }] });
  assert.deepEqual(parsed.assertions, [
    { fullName: 'a test', status: 'failed' },
    { fullName: 'z test', status: 'passed' },
  ]);
  assert.equal(parsed.assertionCount, 2);
  assert.deepEqual(parsed.counts, { failed: 1, passed: 1 });
  assert.deepEqual(parseCommandOutput('json-stdout', '{"ok":true}\n'), { ok: true });
  assert.deepEqual(parseCommandOutput('sync-responder-json', 'header\nMachine-readable results:\n{"ok":true}\n'), { ok: true });
  assert.throws(() => parseCommandOutput('unknown', '{}'), /unknown output parser/);
});

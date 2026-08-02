import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  GATE2_RUNTIME_BUILD_ARGS,
  GATE2_RUNTIME_CLEAN_ARGS,
  GATE2_RUNTIME_PACKAGE_CLOSURE,
  assertGate2ExecutedRuntimeMatchesBuildV1,
  buildGate2ExecutedRuntimeManifestV1,
  buildGate2RuntimeManifestFromEntriesV1,
  buildGate2RuntimeProvenanceV1,
} from '../runtime-provenance.ts';

const SOURCE_COMMIT = 'b'.repeat(40);
const FILES = [
  { path: 'packages/agent/dist/index.js', byteLength: 1, sha256: `0x${'1'.repeat(64)}` },
  { path: 'packages/chain/dist/index.js', byteLength: 2, sha256: `0x${'2'.repeat(64)}` },
  { path: 'packages/core/dist/index.js', byteLength: 3, sha256: `0x${'3'.repeat(64)}` },
  { path: 'packages/storage/dist/index.js', byteLength: 4, sha256: `0x${'4'.repeat(64)}` },
] as const;

test('clean runtime closure includes the release CLI entrypoint', () => {
  assert.ok(GATE2_RUNTIME_PACKAGE_CLOSURE.some((entry) =>
    entry.path === 'packages/cli/dist'));
  for (const args of [GATE2_RUNTIME_CLEAN_ARGS, GATE2_RUNTIME_BUILD_ARGS]) {
    const values: readonly string[] = args;
    assert.ok(values.includes('@origintrail-official/dkg...'));
    assert.equal(values.includes('@origintrail-official/dkg-agent...'), false);
  }
});

test('runtime manifests are deterministic and bind exact loaded bytes', () => {
  const build = buildGate2RuntimeManifestFromEntriesV1(SOURCE_COMMIT, FILES);
  const reordered = buildGate2RuntimeManifestFromEntriesV1(SOURCE_COMMIT, [...FILES].reverse());
  assert.deepEqual(build, reordered);
  const loaded = buildGate2ExecutedRuntimeManifestV1(SOURCE_COMMIT, FILES);
  assert.doesNotThrow(() => assertGate2ExecutedRuntimeMatchesBuildV1(loaded, build));

  const changed = buildGate2ExecutedRuntimeManifestV1(SOURCE_COMMIT, [
    { ...FILES[0], sha256: `0x${'f'.repeat(64)}` },
    ...FILES.slice(1),
  ]);
  assert.throws(
    () => assertGate2ExecutedRuntimeMatchesBuildV1(changed, build),
    /outside the clean-build snapshot/u,
  );
});

test('runtime provenance rejects missing entrypoints and process substitution', () => {
  const build = buildGate2RuntimeManifestFromEntriesV1(SOURCE_COMMIT, FILES);
  const incomplete = buildGate2ExecutedRuntimeManifestV1(SOURCE_COMMIT, FILES.slice(1));
  assert.throws(
    () => assertGate2ExecutedRuntimeMatchesBuildV1(incomplete, build),
    /mandatory runtime entrypoint/u,
  );
  const loaded = buildGate2ExecutedRuntimeManifestV1(SOURCE_COMMIT, FILES);
  assert.throws(
    () => buildGate2RuntimeProvenanceV1(build, [
      { id: 'receiverBeforeCrash', loaded },
      { id: 'author', loaded },
      { id: 'receiverAfterRestart', loaded },
    ]),
    /process 0 must be author/u,
  );
});

test('direct run.ts execution fails closed without the clean-build launch receipt', () => {
  const repoRoot = resolve(import.meta.dirname, '../../..');
  const runPath = resolve(import.meta.dirname, '../run.ts');
  const result = spawnSync(process.execPath, ['--import', 'tsx', runPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /requires its clean-build launcher; direct run\.ts execution is forbidden/u,
  );
});

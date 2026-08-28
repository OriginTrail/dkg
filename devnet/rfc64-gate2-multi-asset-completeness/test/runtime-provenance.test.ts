import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
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

test('Gate 2 compatibility codec preserves the pre-extraction wire contract', () => {
  const build = buildGate2RuntimeManifestFromEntriesV1(SOURCE_COMMIT, FILES);
  const loaded = buildGate2ExecutedRuntimeManifestV1(SOURCE_COMMIT, FILES);
  const provenance = buildGate2RuntimeProvenanceV1(build, [
    { id: 'author', loaded },
    { id: 'receiverBeforeCrash', loaded },
    { id: 'receiverAfterRestart', loaded },
  ]);

  assert.equal(build.schemaVersion, 'dkg-rfc64-gate2-runtime-manifest-v1');
  assert.equal(
    build.manifestDigest,
    '0x8cbd9ec990acd49abb799776d45f30bfe678f78b2d766b2323d31d65c14c85fd',
  );
  assert.deepEqual(build.build, {
    buildArgs: [
      '-r',
      '--filter',
      '@origintrail-official/dkg-agent...',
      '--filter',
      '!@origintrail-official/dkg-evm-module',
      'run',
      'build',
    ],
    cleanArgs: [
      '-r',
      '--filter',
      '@origintrail-official/dkg-agent...',
      '--filter',
      '!@origintrail-official/dkg-evm-module',
      'run',
      'clean',
    ],
    command: 'pnpm',
  });
  assert.deepEqual(build.packageClosure, [
    { name: '@origintrail-official/dkg-agent', path: 'packages/agent/dist' },
    { name: '@origintrail-official/dkg-chain', path: 'packages/chain/dist' },
    { name: '@origintrail-official/dkg-core', path: 'packages/core/dist' },
    { name: '@origintrail-official/dkg-publisher', path: 'packages/publisher/dist' },
    { name: '@origintrail-official/dkg-query', path: 'packages/query/dist' },
    {
      name: '@origintrail-official/dkg-random-sampling',
      path: 'packages/random-sampling/dist',
    },
    { name: '@origintrail-official/dkg-rdf-utils', path: 'packages/rdf-utils/dist' },
    { name: '@origintrail-official/dkg-storage', path: 'packages/storage/dist' },
  ]);
  assert.equal(loaded.schemaVersion, 'dkg-rfc64-gate2-executed-runtime-manifest-v1');
  assert.equal(
    loaded.manifestDigest,
    '0xaf09bd484855cdb7a86581f64d7356b204f093babfef1ae86371e61dc854b453',
  );
  assert.equal(provenance.schemaVersion, 'dkg-rfc64-gate2-runtime-provenance-v1');
  assert.equal(
    provenance.provenanceDigest,
    '0x0f8f2b7becf479a832938ef3b3dd77065c10fb8eeb12be2dee97d30db5da43ed',
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

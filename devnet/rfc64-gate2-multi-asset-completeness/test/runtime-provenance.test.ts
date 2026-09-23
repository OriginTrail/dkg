import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  assertGate2ExecutedRuntimeMatchesBuildV1,
  buildGate2ExecutedRuntimeManifestV1,
  buildGate2RuntimeManifestFromEntriesV1,
  buildGate2RuntimeProvenanceV1,
  GATE2_RUNTIME_PACKAGE_CLOSURE,
} from '../runtime-provenance.ts';
import { resolveGate2HarnessDataDirV1 } from '../two-agent-harness.ts';

const SOURCE_COMMIT = 'b'.repeat(40);
const FILES = [
  { path: 'packages/cli/dist/cli.js', byteLength: 5, sha256: `0x${'5'.repeat(64)}` },
  { path: 'packages/agent/dist/index.js', byteLength: 1, sha256: `0x${'1'.repeat(64)}` },
  { path: 'packages/chain/dist/index.js', byteLength: 2, sha256: `0x${'2'.repeat(64)}` },
  { path: 'packages/core/dist/index.js', byteLength: 3, sha256: `0x${'3'.repeat(64)}` },
  { path: 'packages/storage/dist/index.js', byteLength: 4, sha256: `0x${'4'.repeat(64)}` },
] as const;
const IDENTITIES = {
  author: { hostIdentity: 'host-a', pid: 101 },
  receiverBeforeCrash: { hostIdentity: 'host-b', pid: 101 },
  receiverAfterRestart: { hostIdentity: 'host-c', pid: 101 },
} as const;

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

test('release CLI profile binds the clean build, loaded entrypoint, and process identities', () => {
  const build = buildGate2RuntimeManifestFromEntriesV1(SOURCE_COMMIT, FILES);
  const loaded = buildGate2ExecutedRuntimeManifestV1(SOURCE_COMMIT, FILES);
  const provenance = buildGate2RuntimeProvenanceV1(build, [
    { id: 'author', identity: IDENTITIES.author, loaded },
    { id: 'receiverBeforeCrash', identity: IDENTITIES.receiverBeforeCrash, loaded },
    { id: 'receiverAfterRestart', identity: IDENTITIES.receiverAfterRestart, loaded },
  ]);

  assert.equal(build.schemaVersion, 'dkg-rfc64-release-cli-runtime-manifest-v1');
  assert.equal(
    build.manifestDigest,
    '0x3049d37d55239005f0fcfa577a571df697fc8ddc9e9f56c122622ae6258400eb',
  );
  assert.deepEqual(build.build, {
    buildArgs: [
      '-r',
      '--filter',
      '@origintrail-official/dkg...',
      '--filter',
      '!@origintrail-official/dkg-evm-module',
      'run',
      'build',
    ],
    cleanArgs: [
      '-r',
      '--filter',
      '@origintrail-official/dkg...',
      '--filter',
      '!@origintrail-official/dkg-evm-module',
      'run',
      'clean',
    ],
    command: 'pnpm',
  });
  assert.deepEqual(build.packageClosure, GATE2_RUNTIME_PACKAGE_CLOSURE);
  assert.equal(loaded.schemaVersion, 'dkg-rfc64-release-cli-executed-runtime-manifest-v1');
  assert.equal(loaded.entrypoint, 'packages/cli/dist/cli.js');
  assert.equal(
    loaded.manifestDigest,
    '0x2e7894a9672bf040b1bba32806484f7c0b09c998859dcc2a161c83025b90e1b7',
  );
  assert.equal(provenance.schemaVersion, 'dkg-rfc64-gate2-runtime-provenance-v2');
  assert.equal(
    provenance.provenanceDigest,
    '0xc84f08cd3dd6a39a890f56419f7f03f42ae2d496a8a0d656d22e16860e28a403',
  );
});

test('runtime provenance rejects missing entrypoints and process substitution', () => {
  const build = buildGate2RuntimeManifestFromEntriesV1(SOURCE_COMMIT, FILES);
  const complete = buildGate2ExecutedRuntimeManifestV1(SOURCE_COMMIT, FILES);
  const { entrypoint: _entrypoint, ...withoutEntrypoint } = complete;
  const incomplete = withoutEntrypoint as typeof complete;
  assert.throws(
    () => assertGate2ExecutedRuntimeMatchesBuildV1(incomplete, build),
    /internally canonical|mandatory runtime entrypoint/u,
  );
  const loaded = buildGate2ExecutedRuntimeManifestV1(SOURCE_COMMIT, FILES);
  assert.throws(
    () => buildGate2RuntimeProvenanceV1(build, [
      { id: 'receiverBeforeCrash', identity: IDENTITIES.receiverBeforeCrash, loaded },
      { id: 'author', identity: IDENTITIES.author, loaded },
      { id: 'receiverAfterRestart', identity: IDENTITIES.receiverAfterRestart, loaded },
    ]),
    /process 0 must be author/u,
  );
});

test('process identity permits equal PIDs on different hosts and rejects same-host reuse', () => {
  const build = buildGate2RuntimeManifestFromEntriesV1(SOURCE_COMMIT, FILES);
  const loaded = buildGate2ExecutedRuntimeManifestV1(SOURCE_COMMIT, FILES);
  assert.doesNotThrow(() => buildGate2RuntimeProvenanceV1(build, [
    { id: 'author', identity: { hostIdentity: 'host-a', pid: 201 }, loaded },
    { id: 'receiverBeforeCrash', identity: { hostIdentity: 'host-b', pid: 201 }, loaded },
    { id: 'receiverAfterRestart', identity: { hostIdentity: 'host-c', pid: 202 }, loaded },
  ]));
  assert.throws(
    () => buildGate2RuntimeProvenanceV1(build, [
      { id: 'author', identity: { hostIdentity: 'host-a', pid: 201 }, loaded },
      { id: 'receiverBeforeCrash', identity: { hostIdentity: 'host-a', pid: 201 }, loaded },
      { id: 'receiverAfterRestart', identity: { hostIdentity: 'host-c', pid: 202 }, loaded },
    ]),
    /duplicate process identity/u,
  );
});

test('relative data directories use the daemon launch cwd', () => {
  assert.equal(
    resolveGate2HarnessDataDirV1('/srv/dkg/release', 'state/receiver'),
    '/srv/dkg/release/state/receiver',
  );
  assert.equal(
    resolveGate2HarnessDataDirV1('/srv/dkg/release', '/var/lib/dkg/receiver'),
    '/var/lib/dkg/receiver',
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

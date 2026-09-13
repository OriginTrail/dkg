// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  MAX_CANONICAL_DOCUMENT_BYTES,
  MAX_CANONICAL_NODES,
  canonicalize,
} from '../../../../devnet/rfc64-runtime-canonical.mts';
import {
  buildExecutedRuntimeManifestV1,
  buildRuntimeManifestFromEntriesV1,
  buildRuntimeManifestV1,
} from '../../../../devnet/rfc64-runtime-provenance.mts';
import {
  assertRfc64PrivateRuntimeProvenanceV1,
  buildRfc64PrivateRuntimeProvenanceV1,
  RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1,
} from './runtime-provenance.mjs';

const SOURCE_COMMIT = 'a'.repeat(40);
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const RUNTIME_FILES = Object.freeze([
  runtimeFile('packages/agent/dist/index.js', 1),
  runtimeFile('packages/chain/dist/index.js', 2),
  runtimeFile('packages/core/dist/index.js', 3),
  runtimeFile('packages/storage/dist/index.js', 4),
]);

test('private process provenance normalizes loaded files into one bounded source table', () => {
  const provenance = fixtureProvenance();
  assert.equal(provenance.processes.length, RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1.length);
  assert.deepEqual(provenance.processes[0].loaded.runtimeFileIndexes, [0, 1, 2, 3]);
  assert.equal(Object.hasOwn(provenance.processes[0].loaded, 'runtimeFiles'), false);
  assert.deepEqual(assertRfc64PrivateRuntimeProvenanceV1(provenance), provenance);
  assert.doesNotThrow(() => canonicalize(provenance));
});

test('eleven-process live-build provenance fits the original canonical boundaries', () => {
  const sourceBuild = buildRuntimeManifestV1(REPO_ROOT, SOURCE_COMMIT);
  const loaded = buildExecutedRuntimeManifestV1(SOURCE_COMMIT, sourceBuild.runtimeFiles);
  const provenance = buildRfc64PrivateRuntimeProvenanceV1(
    sourceBuild,
    RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1.map((id) => ({ id, loaded })),
  );
  const bytes = canonicalize(provenance);
  assert.ok(Buffer.byteLength(bytes) <= MAX_CANONICAL_DOCUMENT_BYTES);
  assert.equal(provenance.processes.length, 11);
  assert.equal(Object.hasOwn(provenance.processes[0].loaded, 'runtimeFiles'), false);
});

test('private process provenance rejects normalized index and manifest tampering', () => {
  const provenance = fixtureProvenance();
  for (const indexes of [[0, 1, 1, 3], [1, 0, 2, 3], [0, 1, 2, 99]]) {
    const tampered = structuredClone(provenance);
    tampered.processes[0].loaded.runtimeFileIndexes = indexes;
    assert.throws(() => assertRfc64PrivateRuntimeProvenanceV1(tampered));
  }
  const tamperedDigest = structuredClone(provenance);
  tamperedDigest.processes[0].loaded.manifestDigest = `0x${'ff'.repeat(32)}`;
  assert.throws(
    () => assertRfc64PrivateRuntimeProvenanceV1(tamperedDigest),
    /normalized manifest binding/u,
  );
  const extraField = structuredClone(provenance);
  extraField.processes[0].loaded.runtimeFiles = [];
  assert.throws(() => assertRfc64PrivateRuntimeProvenanceV1(extraField), /not canonical/u);
});

test('canonical evidence retains the original exact node and byte ceilings', () => {
  assert.doesNotThrow(() => canonicalize(Array.from(
    { length: MAX_CANONICAL_NODES - 1 },
    () => null,
  )));
  assert.throws(
    () => canonicalize(Array.from({ length: MAX_CANONICAL_NODES }, () => null)),
    /node ceiling/u,
  );
  assert.doesNotThrow(() => canonicalize('x'.repeat(1_048_576)));
  assert.throws(
    () => canonicalize(['é'.repeat(1_048_576), 'é'.repeat(1_048_576)]),
    /byte ceiling/u,
  );
});

function fixtureProvenance() {
  const sourceBuild = buildRuntimeManifestFromEntriesV1(SOURCE_COMMIT, RUNTIME_FILES);
  const loaded = buildExecutedRuntimeManifestV1(SOURCE_COMMIT, RUNTIME_FILES);
  return buildRfc64PrivateRuntimeProvenanceV1(
    sourceBuild,
    RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1.map((id) => ({ id, loaded })),
  );
}

function runtimeFile(path, discriminator) {
  return Object.freeze({
    byteLength: discriminator,
    path,
    sha256: `0x${discriminator.toString(16).padStart(64, '0')}`,
  });
}

// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';

import { buildRuntimeManifestV1 } from '../../../../devnet/rfc64-runtime-provenance.mts';
import { executeRfc64PrivateReleaseGateV1 } from './run.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const SOURCE_REVISION = 'c'.repeat(40);

test('real agents preserve receiver memory when canonical revocation denies resync', {
  timeout: 180_000,
}, async () => {
  const runtimeManifest = buildRuntimeManifestV1(REPO_ROOT, SOURCE_REVISION);
  const artifact = await executeRfc64PrivateReleaseGateV1({
    runtimeManifest,
    sourceRevision: SOURCE_REVISION,
  });

  assert.equal(artifact.status, 'PASS', JSON.stringify(artifact.checks));
  assert.equal(artifact.checks.receiverUsedProvider2AfterOwnerStopped, true);
  assert.equal(artifact.checks.revokedReceiverDeniedAfterFinalizedRosterAdvance, true);
  assert.equal(artifact.checks.revocationDoesNotCorruptPreviouslyCommittedMemory, true);
  assert.equal(artifact.revokedReceiver.denial.denied, true);
  assert.deepEqual(
    artifact.revokedReceiver.state.graphCounts,
    artifact.failoverReceiver.graphCounts,
  );
});

test('a finalized roster mismatch aborts before publish or synchronization', {
  timeout: 90_000,
}, async () => {
  const runtimeManifest = buildRuntimeManifestV1(REPO_ROOT, SOURCE_REVISION);
  await assert.rejects(
    executeRfc64PrivateReleaseGateV1({
      childEnvironment: {
        DKG_RFC64_PRIVATE_AUTHORITY_FAULT: 'omit-receiver',
      },
      runtimeManifest,
      sourceRevision: SOURCE_REVISION,
    }),
    /finalized chain authority differs from the declared gate topology/u,
  );
});

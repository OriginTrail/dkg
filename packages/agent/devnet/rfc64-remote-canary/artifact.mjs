// SPDX-License-Identifier: Apache-2.0

import { writeRfc64ArtifactAtomicV1 } from '../rfc64-artifact-v1.mjs';
import { ARTIFACT_SCHEMA, RemoteCanaryError } from './common.mjs';
import {
  createRemoteCanaryDryRunArtifactV1,
  executeRemoteCanaryCertificationV1,
} from './phases.mjs';

/** Atomically replace prior results; a stale PASS cannot survive any attempted run. */
export async function runRemoteCanaryArtifactLifecycleV1({
  config,
  loadConfig,
  artifactPath,
  dryRun = false,
  dependencies = {},
}) {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  await writeArtifactAtomicV1(artifactPath, {
    schema: ARTIFACT_SCHEMA,
    status: 'INCOMPLETE',
    phase: 'starting',
    startedAt,
  });
  try {
    if ((config === undefined) === (loadConfig === undefined)) {
      throw new TypeError('exactly-one-config-source-required');
    }
    const loadedConfig = loadConfig === undefined ? config : await loadConfig();
    const artifact = dryRun
      ? createRemoteCanaryDryRunArtifactV1(loadedConfig, now)
      : await executeRemoteCanaryCertificationV1(loadedConfig, { ...dependencies, now });
    await writeArtifactAtomicV1(artifactPath, artifact);
    return artifact;
  } catch (error) {
    const failed = Object.freeze({
      schema: ARTIFACT_SCHEMA,
      status: 'FAIL',
      phase: error instanceof RemoteCanaryError ? error.phase : 'failed',
      startedAt,
      finishedAt: now().toISOString(),
      failure: Object.freeze({
        code: error instanceof RemoteCanaryError
          ? error.code
          : 'unexpected-execution-failure',
      }),
    });
    try {
      await writeArtifactAtomicV1(artifactPath, failed);
    } catch (artifactError) {
      throw new AggregateError([error, artifactError], 'certificate-and-artifact-write-failed');
    }
    throw error;
  }
}

export function writeArtifactAtomicV1(artifactPath, artifact) {
  return writeRfc64ArtifactAtomicV1(artifactPath, artifact);
}

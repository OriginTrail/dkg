// SPDX-License-Identifier: Apache-2.0

import { writeRfc64ArtifactAtomicV1 } from '../rfc64-artifact-v1.mjs';
import {
  ARTIFACT_SCHEMA,
  createRemoteCanaryCertificateV1,
  validateRemoteCanaryCertificateV1,
} from './artifact-contract.mjs';
import { validateRemoteCanaryConfigV1 } from './config.mjs';
import { RemoteCanaryError } from './errors.mjs';
import { pathsAliasV1 } from './path-alias.mjs';
import {
  createRemoteCanaryDryRunArtifactFromNormalizedV1,
  executeRemoteCanaryCertificationFromNormalizedV1,
} from './phases.mjs';

/** @typedef {import('./domain-contract.js').RemoteCanaryDependenciesV1} RemoteCanaryDependenciesV1 */

/**
 * @typedef {Readonly<{
 *   loadConfig: () => unknown | Promise<unknown>,
 *   artifactPath: string,
 *   dryRun?: boolean,
 *   dependencies?: RemoteCanaryDependenciesV1,
 * }>} ArtifactLifecycleInputV1
 */

/** Invalidate prior results after configuration and input/output alias safety are established. */
/** @param {ArtifactLifecycleInputV1} input */
export async function runRemoteCanaryArtifactLifecycleV1({
  loadConfig,
  artifactPath,
  dryRun = false,
  dependencies = {},
}) {
  if (typeof loadConfig !== 'function') throw new TypeError('config-loader-required');
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const loadedConfig = await loadConfig();
  const validatedConfig = validateRemoteCanaryConfigV1(loadedConfig);
  await assertArtifactDoesNotAliasConfiguredInputV1(artifactPath, validatedConfig);
  await writeArtifactAtomicV1(artifactPath, createRemoteCanaryCertificateV1({
    schema: ARTIFACT_SCHEMA,
    status: 'INCOMPLETE',
    phase: 'starting',
    startedAt,
  }));
  try {
    const artifact = dryRun
      ? createRemoteCanaryDryRunArtifactFromNormalizedV1(validatedConfig, now)
      : await executeRemoteCanaryCertificationFromNormalizedV1(
          validatedConfig,
          { ...dependencies, now },
        );
    await writeArtifactAtomicV1(artifactPath, artifact);
    return artifact;
  } catch (error) {
    const failed = createRemoteCanaryCertificateV1({
      schema: ARTIFACT_SCHEMA,
      status: 'FAIL',
      phase: error instanceof RemoteCanaryError ? (error.phase ?? 'failed') : 'failed',
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

/** @param {string} artifactPath @param {import('./domain-contract.js').RemoteCanaryCertificateV1} artifact */
export function writeArtifactAtomicV1(artifactPath, artifact) {
  return writeRfc64ArtifactAtomicV1(
    artifactPath,
    validateRemoteCanaryCertificateV1(artifact),
  );
}

/**
 * Reject output aliases with credentials or externally supplied evidence
 * before the lifecycle is allowed to replace any bytes.
 *
 * @param {string} artifactPath
 * @param {import('./domain-contract.js').NormalizedRemoteCanaryConfigV1} config
 */
export async function assertArtifactDoesNotAliasConfiguredInputV1(artifactPath, config) {
  const configuredInputs = [
    ...config.nodes.flatMap((node) => (
      node.auth.kind === 'bearer-file' ? [node.auth.secretFile] : []
    )),
    ...(config.rpcUsage.kind === 'evidence-file' ? [config.rpcUsage.path] : []),
  ];
  for (const configuredInput of new Set(configuredInputs)) {
    if (await pathsAliasV1(artifactPath, configuredInput)) {
      throw new RemoteCanaryError('artifact-input-path-alias', 'configuration');
    }
  }
}

// SPDX-License-Identifier: Apache-2.0

import { writeRfc64ArtifactAtomicV1 } from '../rfc64-artifact-v1.mjs';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ARTIFACT_SCHEMA } from './artifact-contract.mjs';
import { validateRemoteCanaryConfigV1 } from './config.mjs';
import { RemoteCanaryError } from './errors.mjs';
import {
  createRemoteCanaryDryRunArtifactV1,
  executeRemoteCanaryCertificationV1,
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

/** Atomically replace prior results; a stale PASS cannot survive any attempted run. */
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
  await writeArtifactAtomicV1(artifactPath, {
    schema: ARTIFACT_SCHEMA,
    status: 'INCOMPLETE',
    phase: 'starting',
    startedAt,
  });
  try {
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

/** @param {string} artifactPath @param {unknown} artifact */
export function writeArtifactAtomicV1(artifactPath, artifact) {
  return writeRfc64ArtifactAtomicV1(artifactPath, artifact);
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

/** @param {string} left @param {string} right */
async function pathsAliasV1(left, right) {
  const [canonicalLeft, canonicalRight, leftStat, rightStat] = await Promise.all([
    canonicalizePotentialPathV1(left),
    canonicalizePotentialPathV1(right),
    statIfPresentV1(left),
    statIfPresentV1(right),
  ]);
  return canonicalLeft === canonicalRight || (
    leftStat !== null
    && rightStat !== null
    && leftStat.dev === rightStat.dev
    && leftStat.ino === rightStat.ino
  );
}

/** @param {string} path */
async function canonicalizePotentialPathV1(path) {
  let cursor = resolve(path);
  const missingSegments = [];
  for (;;) {
    try {
      return join(await realpath(cursor), ...missingSegments);
    } catch (error) {
      if (!hasErrorCodeV1(error, 'ENOENT')) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/** @param {string} path */
async function statIfPresentV1(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (hasErrorCodeV1(error, 'ENOENT')) return null;
    throw error;
  }
}

/** @param {unknown} error @param {string} code */
function hasErrorCodeV1(error, code) {
  return error !== null
    && typeof error === 'object'
    && /** @type {{ code?: unknown }} */ (error).code === code;
}

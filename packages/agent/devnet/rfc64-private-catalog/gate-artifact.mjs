// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { isSafeChildDiagnosticPhaseV1 } from './child-protocol.mjs';
import {
  RFC64_PRIVATE_GATE_SCHEMA_V1 as SCHEMA,
  RFC64_PRIVATE_RELEASE_CHECK_KEYS_V1,
  RFC64_PRIVATE_RELEASE_LIMITATION_V1,
} from './gate-artifact-contract.mjs';
import {
  assertRfc64PrivateGatePassProvenanceV1,
  decodeRfc64PrivateGatePassArtifactV1,
} from './gate-artifact-pass-codec.mjs';
import { stableJsonV1 } from './gate-artifact-codec-primitives.mjs';

export {
  RFC64_PRIVATE_RELEASE_CHECK_KEYS_V1,
  RFC64_PRIVATE_RELEASE_LIMITATION_V1,
  assertRfc64PrivateGatePassProvenanceV1,
  decodeRfc64PrivateGatePassArtifactV1,
};

/** Tag a child-command failure with fixed diagnostics safe for gate artifacts. */
export function createGateCommandFailureV1(commandPhase, cause) {
  const error = new Error(`RFC-64 private gate child command failed during ${commandPhase}`, {
    cause,
  });
  error.name = 'Rfc64PrivateGateCommandFailureV1';
  error.commandPhase = commandPhase;
  return error;
}

/**
 * Run one gate invocation with an artifact that can never retain an earlier
 * PASS. The initial INCOMPLETE record is durable before gate work starts, and
 * every caught failure replaces it with a sanitized FAIL record.
 */
export async function runRfc64PrivateGateArtifactLifecycleV1({
  artifactPath,
  execute,
  resolveSourceRevision,
  now = () => new Date(),
}) {
  const startedAt = now().toISOString();
  let canonicalSourceRevision = null;
  await writeGateArtifactAtomicV1(artifactPath, {
    schema: SCHEMA,
    status: 'INCOMPLETE',
    phase: 'starting',
    startedAt,
    sourceRevision: canonicalSourceRevision,
  });

  try {
    if (typeof resolveSourceRevision !== 'function') {
      throw new TypeError('RFC-64 private gate requires one source revision resolver');
    }
    canonicalSourceRevision = canonicalSourceRevisionV1(await resolveSourceRevision());
    if (canonicalSourceRevision === null) {
      throw new TypeError('RFC-64 private gate source revision is malformed');
    }
    const artifact = await execute({ sourceRevision: canonicalSourceRevision });
    const completed = {
      ...artifact,
      startedAt,
      finishedAt: now().toISOString(),
      sourceRevision: canonicalSourceRevision,
    };
    if (completed.status === 'PASS') {
      decodeRfc64PrivateGatePassArtifactV1(completed);
    }
    await writeGateArtifactAtomicV1(artifactPath, completed);
    return completed;
  } catch (error) {
    const failed = {
      schema: SCHEMA,
      status: 'FAIL',
      phase: 'failed',
      startedAt,
      finishedAt: now().toISOString(),
      sourceRevision: canonicalSourceRevision,
      failure: sanitizeGateFailureV1(error),
    };
    try {
      await writeGateArtifactAtomicV1(artifactPath, failed);
    } catch (artifactError) {
      throw new AggregateError(
        [error, artifactError],
        'RFC-64 private gate failed and its sanitized failure artifact could not be written',
      );
    }
    throw error;
  }
}

/** Replace the artifact with one same-directory atomic rename. */
export async function writeGateArtifactAtomicV1(artifactPath, artifact) {
  const artifactDirectory = dirname(artifactPath);
  await mkdir(artifactDirectory, { recursive: true });
  const temporaryPath = join(
    artifactDirectory,
    `.${basename(artifactPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${stableJsonV1(artifact)}\n`, {
      encoding: 'utf8',
      mode: 0o644,
      flag: 'wx',
    });
    await rename(temporaryPath, artifactPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Return only fixed classifications. Never retain caller-controlled error data. */
export function sanitizeGateFailureV1(error) {
  if (
    error instanceof Error
    && error.name === 'Rfc64PrivateGateCommandFailureV1'
    && isSafeChildDiagnosticPhaseV1(error.commandPhase)
  ) {
    return Object.freeze({
      failureClass: 'gate-command-failed',
      commandPhase: error.commandPhase,
    });
  }
  const failureClass = error instanceof AggregateError
    ? 'gate-and-artifact-failed'
    : error instanceof Error && error.name === 'AbortError'
      ? 'gate-aborted'
      : 'gate-execution-failed';
  return Object.freeze({ failureClass });
}

function canonicalSourceRevisionV1(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{7,64}$/iu.test(value)) return null;
  return value.toLowerCase();
}

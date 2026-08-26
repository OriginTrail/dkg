// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const SCHEMA = 'dkg-rfc64-private-release-gate-v1';
const RUNTIME_PROCESS_IDS = Object.freeze([
  'probe-owner',
  'probe-provider2',
  'probe-receiver',
  'probe-outsider',
  'owner',
  'provider2',
  'receiver',
  'outsider',
  'receiver-restart',
]);

/**
 * Run one gate invocation with an artifact that can never retain an earlier
 * PASS. The initial INCOMPLETE record is durable before gate work starts, and
 * every caught failure replaces it with a sanitized FAIL record.
 */
export async function runRfc64PrivateGateArtifactLifecycleV1({
  artifactPath,
  execute,
  sourceRevision = null,
  now = () => new Date(),
}) {
  const startedAt = now().toISOString();
  const canonicalSourceRevision = canonicalSourceRevisionV1(sourceRevision);
  await writeGateArtifactAtomicV1(artifactPath, {
    schema: SCHEMA,
    status: 'INCOMPLETE',
    phase: 'starting',
    startedAt,
    sourceRevision: canonicalSourceRevision,
  });

  try {
    const artifact = await execute();
    const completed = {
      ...artifact,
      startedAt,
      finishedAt: now().toISOString(),
      sourceRevision: canonicalSourceRevision,
    };
    if (completed.status === 'PASS') {
      assertRfc64PrivateGatePassProvenanceV1(completed);
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

/** A committed PASS must name one exact source revision, runtime build, and bounded run. */
export function assertRfc64PrivateGatePassProvenanceV1(artifact) {
  if (artifact === null || typeof artifact !== 'object') {
    throw new TypeError('RFC-64 private gate PASS artifact must be an object');
  }
  if (artifact.schema !== SCHEMA || artifact.status !== 'PASS') {
    throw new TypeError('RFC-64 private gate PASS artifact has an invalid schema or status');
  }
  const startedAt = canonicalIsoInstantV1(artifact.startedAt, 'startedAt');
  const finishedAt = canonicalIsoInstantV1(artifact.finishedAt, 'finishedAt');
  if (finishedAt < startedAt) {
    throw new TypeError('RFC-64 private gate PASS finishedAt precedes startedAt');
  }
  if (
    typeof artifact.sourceRevision !== 'string'
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(artifact.sourceRevision)
  ) {
    throw new TypeError('RFC-64 private gate PASS requires an exact source revision');
  }
  if (
    typeof artifact.runtimeManifestDigest !== 'string'
    || !/^0x[0-9a-f]{64}$/u.test(artifact.runtimeManifestDigest)
  ) {
    throw new TypeError('RFC-64 private gate PASS requires an exact runtime manifest digest');
  }
  const provenance = artifact.runtimeProvenance;
  if (
    provenance === null
    || typeof provenance !== 'object'
    || Array.isArray(provenance)
    || provenance.schema !== 'dkg-rfc64-private-runtime-provenance-v1'
    || provenance.sourceBuild?.sourceCommit !== artifact.sourceRevision
    || provenance.sourceBuild?.manifestDigest !== artifact.runtimeManifestDigest
    || !Array.isArray(provenance.processes)
    || provenance.processes.length !== RUNTIME_PROCESS_IDS.length
  ) {
    throw new TypeError('RFC-64 private gate PASS runtime provenance is incomplete');
  }
  for (const [index, processEvidence] of provenance.processes.entries()) {
    if (
      processEvidence === null
      || typeof processEvidence !== 'object'
      || Array.isArray(processEvidence)
      || processEvidence.id !== RUNTIME_PROCESS_IDS[index]
      || processEvidence.loaded?.sourceCommit !== artifact.sourceRevision
      || typeof processEvidence.loaded?.manifestDigest !== 'string'
      || !/^0x[0-9a-f]{64}$/u.test(processEvidence.loaded.manifestDigest)
      || !Array.isArray(processEvidence.loaded.runtimeFiles)
      || processEvidence.loaded.runtimeFiles.length < 1
    ) {
      throw new TypeError('RFC-64 private gate PASS child runtime provenance is incomplete');
    }
  }
  return artifact;
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

function canonicalIsoInstantV1(value, field) {
  if (typeof value !== 'string') {
    throw new TypeError(`RFC-64 private gate PASS ${field} must be an ISO instant`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`RFC-64 private gate PASS ${field} must be a canonical ISO instant`);
  }
  return timestamp;
}

function stableJsonV1(value) {
  return JSON.stringify(sortKeysV1(value), null, 2);
}

function sortKeysV1(value) {
  if (Array.isArray(value)) return value.map(sortKeysV1);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortKeysV1(value[key])]),
    );
  }
  return value;
}

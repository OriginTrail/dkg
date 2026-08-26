// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

import { canonicalize, type CanonicalValue } from '../rfc64-runtime-canonical.mts';
import {
  RUNTIME_BUILD_ARGS,
  RUNTIME_CLEAN_ARGS,
  RUNTIME_PACKAGE_CLOSURE,
  assertExecutedRuntimeMatchesBuildV1,
  assertRuntimeManifestEqualV1,
  buildExecutedRuntimeManifestV1,
  buildRuntimeManifestFromEntriesV1,
  buildRuntimeManifestV1,
  runCleanRuntimeBuildV1,
  type ExecutedRuntimeManifestV1,
  type RuntimeEvidenceProfileV1,
  type RuntimeFileEvidenceV1,
  type RuntimeManifestV1,
} from '../rfc64-runtime-provenance.mts';
import { validateFixedRuntimeProcessEvidenceV1 } from '../rfc64-runtime-process-evidence.mts';

export const GATE2_RUNTIME_MANIFEST_SCHEMA_VERSION =
  'dkg-rfc64-gate2-runtime-manifest-v1' as const;
export const GATE2_RUNTIME_MANIFEST_DIGEST_DOMAIN =
  'dkg-rfc64-gate2-runtime-manifest-v1\n' as const;
export const GATE2_EXECUTED_RUNTIME_MANIFEST_SCHEMA_VERSION =
  'dkg-rfc64-gate2-executed-runtime-manifest-v1' as const;
export const GATE2_EXECUTED_RUNTIME_MANIFEST_DIGEST_DOMAIN =
  'dkg-rfc64-gate2-executed-runtime-manifest-v1\n' as const;
export const GATE2_RUNTIME_PROVENANCE_SCHEMA_VERSION =
  'dkg-rfc64-gate2-runtime-provenance-v1' as const;
export const GATE2_RUNTIME_PROVENANCE_DIGEST_DOMAIN =
  'dkg-rfc64-gate2-runtime-provenance-v1\n' as const;

export const GATE2_RUNTIME_PACKAGE_CLOSURE = RUNTIME_PACKAGE_CLOSURE;
export const GATE2_RUNTIME_CLEAN_ARGS = RUNTIME_CLEAN_ARGS;
export const GATE2_RUNTIME_BUILD_ARGS = RUNTIME_BUILD_ARGS;

export const GATE2_RUNTIME_EVIDENCE_PROFILE_V1: Readonly<RuntimeEvidenceProfileV1> =
  Object.freeze({
    buildArgs: GATE2_RUNTIME_BUILD_ARGS,
    cleanArgs: GATE2_RUNTIME_CLEAN_ARGS,
    executedManifestDigestDomain: GATE2_EXECUTED_RUNTIME_MANIFEST_DIGEST_DOMAIN,
    executedManifestSchemaVersion: GATE2_EXECUTED_RUNTIME_MANIFEST_SCHEMA_VERSION,
    mandatoryEntrypoints: Object.freeze([
      'packages/agent/dist/index.js',
      'packages/chain/dist/index.js',
      'packages/core/dist/index.js',
      'packages/storage/dist/index.js',
    ]),
    manifestDigestDomain: GATE2_RUNTIME_MANIFEST_DIGEST_DOMAIN,
    manifestSchemaVersion: GATE2_RUNTIME_MANIFEST_SCHEMA_VERSION,
    packageClosure: GATE2_RUNTIME_PACKAGE_CLOSURE,
  });

export type Gate2RuntimeFileEvidenceV1 = RuntimeFileEvidenceV1;
export type Gate2RuntimeManifestV1 = RuntimeManifestV1 & {
  readonly schemaVersion: typeof GATE2_RUNTIME_MANIFEST_SCHEMA_VERSION;
};
export type Gate2ExecutedRuntimeManifestV1 = ExecutedRuntimeManifestV1 & {
  readonly schemaVersion: typeof GATE2_EXECUTED_RUNTIME_MANIFEST_SCHEMA_VERSION;
};

export interface Gate2RuntimeLaunchReceiptV1 {
  readonly manifest: Readonly<Gate2RuntimeManifestV1>;
  readonly sourceCommit: string;
}

export type Gate2RuntimeProcessIdV1 =
  | 'author'
  | 'receiverBeforeCrash'
  | 'receiverAfterRestart';

export interface Gate2RuntimeProcessEvidenceV1 {
  readonly id: Gate2RuntimeProcessIdV1;
  readonly loaded: Gate2ExecutedRuntimeManifestV1;
}

export interface Gate2RuntimeProvenanceV1 {
  readonly processes: readonly Gate2RuntimeProcessEvidenceV1[];
  readonly provenanceDigest: string;
  readonly schemaVersion: typeof GATE2_RUNTIME_PROVENANCE_SCHEMA_VERSION;
  readonly sourceBuild: Gate2RuntimeManifestV1;
}

let pendingLaunchReceipt: Readonly<Gate2RuntimeLaunchReceiptV1> | undefined;

export function runGate2CleanRuntimeBuildV1(repoRoot: string): void {
  runCleanRuntimeBuildV1(repoRoot, GATE2_RUNTIME_EVIDENCE_PROFILE_V1);
}

export function buildGate2RuntimeManifestV1(
  repoRoot: string,
  sourceCommit: string,
): Readonly<Gate2RuntimeManifestV1> {
  return buildRuntimeManifestV1(
    repoRoot,
    sourceCommit,
    GATE2_RUNTIME_EVIDENCE_PROFILE_V1,
  ) as Readonly<Gate2RuntimeManifestV1>;
}

export function buildGate2RuntimeManifestFromEntriesV1(
  sourceCommit: string,
  entries: readonly Gate2RuntimeFileEvidenceV1[],
): Readonly<Gate2RuntimeManifestV1> {
  return buildRuntimeManifestFromEntriesV1(
    sourceCommit,
    entries,
    GATE2_RUNTIME_EVIDENCE_PROFILE_V1,
  ) as Readonly<Gate2RuntimeManifestV1>;
}

export function assertGate2RuntimeManifestEqualV1(
  actual: Gate2RuntimeManifestV1,
  expected: Gate2RuntimeManifestV1,
): void {
  assertRuntimeManifestEqualV1(actual, expected);
}

export function buildGate2ExecutedRuntimeManifestV1(
  sourceCommit: string,
  entries: readonly Gate2RuntimeFileEvidenceV1[],
): Readonly<Gate2ExecutedRuntimeManifestV1> {
  return buildExecutedRuntimeManifestV1(
    sourceCommit,
    entries,
    GATE2_RUNTIME_EVIDENCE_PROFILE_V1,
  ) as Readonly<Gate2ExecutedRuntimeManifestV1>;
}

export function assertGate2ExecutedRuntimeMatchesBuildV1(
  executed: Gate2ExecutedRuntimeManifestV1,
  cleanBuild: Gate2RuntimeManifestV1,
): void {
  assertExecutedRuntimeMatchesBuildV1(
    executed,
    cleanBuild,
    GATE2_RUNTIME_EVIDENCE_PROFILE_V1,
  );
}

export function buildGate2RuntimeProvenanceV1(
  sourceBuild: Gate2RuntimeManifestV1,
  inputProcesses: readonly Gate2RuntimeProcessEvidenceV1[],
): Readonly<Gate2RuntimeProvenanceV1> {
  const expectedIds: readonly Gate2RuntimeProcessIdV1[] = Object.freeze([
    'author',
    'receiverBeforeCrash',
    'receiverAfterRestart',
  ]);
  const processes = validateFixedRuntimeProcessEvidenceV1({
    expectedProcessIds: expectedIds,
    processes: inputProcesses,
    validateLoaded: (loaded) => assertGate2ExecutedRuntimeMatchesBuildV1(
      loaded,
      sourceBuild,
    ),
  });
  const payload = Object.freeze({
    processes,
    schemaVersion: GATE2_RUNTIME_PROVENANCE_SCHEMA_VERSION,
    sourceBuild,
  });
  return Object.freeze({
    ...payload,
    provenanceDigest: `0x${createHash('sha256')
      .update(GATE2_RUNTIME_PROVENANCE_DIGEST_DOMAIN)
      .update(canonicalize(payload as unknown as CanonicalValue))
      .digest('hex')}`,
  });
}

export function installGate2RuntimeLaunchReceiptV1(
  receipt: Gate2RuntimeLaunchReceiptV1,
): void {
  if (pendingLaunchReceipt !== undefined) {
    throw new Error('Gate 2 runtime launch receipt is already installed');
  }
  if (receipt.manifest.sourceCommit !== receipt.sourceCommit) {
    throw new Error('Gate 2 runtime launch receipt does not bind its source commit');
  }
  pendingLaunchReceipt = Object.freeze({
    manifest: receipt.manifest,
    sourceCommit: receipt.sourceCommit,
  });
}

export function consumeGate2RuntimeLaunchReceiptV1(): Readonly<Gate2RuntimeLaunchReceiptV1> {
  const receipt = pendingLaunchReceipt;
  pendingLaunchReceipt = undefined;
  if (receipt === undefined) {
    throw new Error(
      'Gate 2 live harness requires its clean-build launcher; direct run.ts execution is forbidden',
    );
  }
  return receipt;
}

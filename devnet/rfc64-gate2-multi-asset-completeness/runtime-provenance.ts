// SPDX-License-Identifier: Apache-2.0

/**
 * Gate 2 compatibility adapter. The reusable runtime evidence contract lives
 * at the scenario-neutral devnet boundary.
 */
export {
  GATE2_EXECUTED_RUNTIME_MANIFEST_DIGEST_DOMAIN,
  GATE2_EXECUTED_RUNTIME_MANIFEST_SCHEMA_VERSION,
  GATE2_RUNTIME_BUILD_ARGS,
  GATE2_RUNTIME_CLEAN_ARGS,
  GATE2_RUNTIME_MANIFEST_DIGEST_DOMAIN,
  GATE2_RUNTIME_MANIFEST_SCHEMA_VERSION,
  GATE2_RUNTIME_PACKAGE_CLOSURE,
  GATE2_RUNTIME_PROVENANCE_DIGEST_DOMAIN,
  GATE2_RUNTIME_PROVENANCE_SCHEMA_VERSION,
  assertGate2ExecutedRuntimeMatchesBuildV1,
  assertGate2RuntimeManifestEqualV1,
  buildGate2ExecutedRuntimeManifestV1,
  buildGate2RuntimeManifestFromEntriesV1,
  buildGate2RuntimeManifestV1,
  buildGate2RuntimeProvenanceV1,
  consumeGate2RuntimeLaunchReceiptV1,
  installGate2RuntimeLaunchReceiptV1,
  runGate2CleanRuntimeBuildV1,
  type Gate2ExecutedRuntimeManifestV1,
  type Gate2RuntimeFileEvidenceV1,
  type Gate2RuntimeLaunchReceiptV1,
  type Gate2RuntimeManifestV1,
  type Gate2RuntimeProcessEvidenceV1,
  type Gate2RuntimeProcessIdV1,
  type Gate2RuntimeProvenanceV1,
} from '../rfc64-runtime-provenance.mts';

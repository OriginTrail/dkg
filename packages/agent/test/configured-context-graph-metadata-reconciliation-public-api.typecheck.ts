// SPDX-License-Identifier: Apache-2.0

import type {
  ConfiguredContextGraphMetadataReconciliationDiagnostic,
  ConfiguredContextGraphMetadataReconciliationResult,
} from '@origintrail-official/dkg-agent';

const unavailable: ConfiguredContextGraphMetadataReconciliationDiagnostic = {
  kind: 'public-chain-proof-unavailable',
  reason: 'rpc-failure',
  detail: 'temporary outage',
};
const pending: ConfiguredContextGraphMetadataReconciliationResult = {
  outcome: 'pending',
  reason: 'missing-metadata',
  diagnostic: unavailable,
};
const authoritative: ConfiguredContextGraphMetadataReconciliationResult = {
  outcome: 'authoritative',
  diagnostic: { kind: 'public-metadata-projection-completed' },
};
void pending;
void authoritative;

const impossibleConflictDiagnostic: ConfiguredContextGraphMetadataReconciliationResult = {
  outcome: 'pending',
  reason: 'conflicting-policy',
  // @ts-expect-error Conflicts are completely represented by the stable pending reason.
  diagnostic: { kind: 'public-metadata-projection-completed' },
};
void impossibleConflictDiagnostic;

const impossibleInternalRepairState: ConfiguredContextGraphMetadataReconciliationResult = {
  outcome: 'authoritative',
  // @ts-expect-error Projection-repair workflow states are not public diagnostics.
  diagnostic: { kind: 'projection-complete' },
};
void impossibleInternalRepairState;

// SPDX-License-Identifier: Apache-2.0

import type {
  ActivePublicContextGraphChainProof,
  ChainAttestedPublicMetaRepairResult,
  ConfiguredContextGraphMetadataReconciliationResult,
} from '@origintrail-official/dkg-agent';

const privateProof: ActivePublicContextGraphChainProof = {
  state: 'not-public',
  reason: 'private',
};
const pending: ConfiguredContextGraphMetadataReconciliationResult = {
  outcome: 'pending',
  reason: 'missing-metadata',
  repair: {
    outcome: 'not-chain-attested',
    chainProof: privateProof,
  },
};
void pending;

// @ts-expect-error Conflicting repair diagnostics can never be authoritative.
const impossibleAuthoritativeConflict: ConfiguredContextGraphMetadataReconciliationResult = {
  outcome: 'authoritative',
  repair: { outcome: 'conflicting-policy', chainProof: { state: 'public' } },
};
void impossibleAuthoritativeConflict;

// @ts-expect-error A conflicting-policy reason requires the matching repair diagnostic.
const impossibleConflictReason: ConfiguredContextGraphMetadataReconciliationResult = {
  outcome: 'pending',
  reason: 'conflicting-policy',
  repair: { outcome: 'already-complete', chainProof: { state: 'not-requested' } },
};
void impossibleConflictReason;

// @ts-expect-error A conflicting repair cannot be reported as missing metadata.
const impossibleMissingMetadataConflict: ConfiguredContextGraphMetadataReconciliationResult = {
  outcome: 'pending',
  reason: 'missing-metadata',
  repair: { outcome: 'conflicting-policy', chainProof: { state: 'public' } },
};
void impossibleMissingMetadataConflict;

// @ts-expect-error A completed projection necessarily carries positive public chain proof.
const impossibleProjection: ChainAttestedPublicMetaRepairResult = {
  outcome: 'projection-complete',
  chainProof: privateProof,
};
void impossibleProjection;

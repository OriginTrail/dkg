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

// @ts-expect-error A completed projection necessarily carries positive public chain proof.
const impossibleProjection: ChainAttestedPublicMetaRepairResult = {
  outcome: 'projection-complete',
  chainProof: privateProof,
};
void impossibleProjection;

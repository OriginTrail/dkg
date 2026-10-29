// SPDX-License-Identifier: Apache-2.0

import type { ChainIdV1, NetworkIdV1, TimestampMsV1 } from '@origintrail-official/dkg-core';
import { resolveRfc64CatalogExecutionPlanV1 } from '../../src/rfc64/catalog-rollout-authority-v1.js';
import {
  resolveRfc64CatalogActivationsV1,
  resolveRfc64CatalogAuthoringPolicyV1,
} from '../../src/rfc64/public-catalog-activation-config-v1.js';

/** Synthetic publication fixtures still cross the real normalized catalog boundary. */
export function confirmedPublicationCatalogConfigV1(enabled = false) {
  const activation = resolveRfc64CatalogActivationsV1({ catalog: { enabled } }, {
    networkId: 'mock:31337' as NetworkIdV1, evmChainId: '31337' as ChainIdV1,
  });
  return {
    rfc64CatalogExecutionPlan: resolveRfc64CatalogExecutionPlanV1({
      configuredContextGraphs: [], activation: activation.catalog,
      effectiveRollout: activation.activationState.execution.rollout,
      ...(enabled ? { responsibilityDefaultMode: 'catalog' as const } : {}),
    }),
    rfc64CatalogAuthoringPolicy: enabled ? resolveRfc64CatalogAuthoringPolicyV1({
      selectedCatalogAuthoringControls: [], acceptedPolicies: [],
      legacyPublicFallback: { mode: 'all-accepted-public', config: {
        peers: [], catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
      } },
    }) : undefined,
  };
}

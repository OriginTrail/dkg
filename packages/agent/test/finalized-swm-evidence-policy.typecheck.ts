// SPDX-License-Identifier: Apache-2.0

import {
  reconcileFinalizedSwmTwin,
  reconcileFinalizedSwmTwinWithEvidence,
} from '@origintrail-official/dkg-agent/dist/sync/requester/finalized-swm-twin-reconciliation.js';

declare const params: Parameters<typeof reconcileFinalizedSwmTwinWithEvidence>[0];

// Each named entrypoint selects its own headless reconciliation policy.
void reconcileFinalizedSwmTwin(params);
void reconcileFinalizedSwmTwinWithEvidence(params);
// @ts-expect-error The evidence API cannot select historical headless behavior.
void reconcileFinalizedSwmTwinWithEvidence(params, false);

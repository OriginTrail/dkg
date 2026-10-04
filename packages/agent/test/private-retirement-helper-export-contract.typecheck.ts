// SPDX-License-Identifier: Apache-2.0

import { GossipPublishHandler, type GossipPublishHandlerCallbacks } from '@origintrail-official/dkg-agent';
import { reconcileFinalizedSwmTwin, type FinalizedSwmTwinRetirement } from '@origintrail-official/dkg-agent/dist/sync/requester/finalized-swm-twin-reconciliation.js';

void GossipPublishHandler;
void reconcileFinalizedSwmTwin;
declare const callbacks: GossipPublishHandlerCallbacks;
declare const retirement: FinalizedSwmTwinRetirement;
void callbacks;
void retirement;

// @ts-expect-error the structural internal namespace keeps new implementations private
import type * as PrivateRetirement from '@origintrail-official/dkg-agent/dist/internal/finalized-swm-retirement-completion.js';
void (null as unknown as typeof PrivateRetirement);

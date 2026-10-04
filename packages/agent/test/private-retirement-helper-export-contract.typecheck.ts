// SPDX-License-Identifier: Apache-2.0

import { GossipPublishHandler, type GossipPublishHandlerCallbacks } from '@origintrail-official/dkg-agent';
import { reconcileFinalizedSwmTwin, type FinalizedSwmTwinRetirement } from '@origintrail-official/dkg-agent/dist/sync/requester/finalized-swm-twin-reconciliation.js';

void GossipPublishHandler;
void reconcileFinalizedSwmTwin;
declare const callbacks: GossipPublishHandlerCallbacks;
declare const retirement: FinalizedSwmTwinRetirement;
void callbacks;
void retirement;

// @ts-expect-error extracted retirement and decoding implementations remain private
import type * as PrivateHelper0 from '@origintrail-official/dkg-agent/dist/dkg-agent-finalized-swm-retirement.js';
void (null as unknown as typeof PrivateHelper0);

// @ts-expect-error extracted retirement and decoding implementations remain private
import type * as PrivateHelper1 from '@origintrail-official/dkg-agent/dist/gossip-publish-decode.js';
void (null as unknown as typeof PrivateHelper1);

// @ts-expect-error extracted retirement and decoding implementations remain private
import type * as PrivateHelper2 from '@origintrail-official/dkg-agent/dist/sync/requester/finalized-swm-retirement-completion.js';
void (null as unknown as typeof PrivateHelper2);

// @ts-expect-error extracted retirement and decoding implementations remain private
import type * as PrivateHelper3 from '@origintrail-official/dkg-agent/dist/sync/requester/finalized-swm-twin-storage.js';
void (null as unknown as typeof PrivateHelper3);

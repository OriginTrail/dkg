// SPDX-License-Identifier: Apache-2.0
import type { GossipSubManager, SubscriptionSource } from '@origintrail-official/dkg-core';

/** All bookkeeping belongs to the manager whose wiring it describes. */
export class GossipSession {
  readonly gossipRegistered = new Set<string>();
  readonly sharedMemoryGossipRegistered = new Set<string>();
  readonly swmHostModeSubscribed = new Map<string, SubscriptionSource>();
  readonly swmHostModeCurated = new Map<string, boolean>();
  readonly swmHostModeHandlers = new Map<string, (topic: string, data: Uint8Array, from: string) => void>();
  /** Live intents snapshotted before the durable startup plan is read. */
  readonly startupLiveIntents = new Map<string, { syncMode?: 'always-on' | 'on-demand' }>();
  active: boolean;

  constructor(readonly manager?: GossipSubManager) {
    this.active = manager !== undefined;
  }

  retire(): void {
    this.active = false;
  }
}

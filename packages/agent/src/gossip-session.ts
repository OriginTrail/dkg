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
  #retired = false;

  readonly #manager: GossipSubManager | undefined;
  constructor(manager?: GossipSubManager) { this.#manager = manager; }

  get active(): boolean { return this.live() !== null; }

  /** The only manager accessor for optional wiring establishes the live invariant. */
  live(): Readonly<{ manager: GossipSubManager }> | null {
    return this.#retired || this.#manager === undefined ? null : { manager: this.#manager };
  }

  requireManager(): GossipSubManager {
    const live = this.live();
    if (live === null) throw new Error('Gossip manager is unavailable outside a live session');
    return live.manager;
  }

  retire(): void { this.#retired = true; }
}

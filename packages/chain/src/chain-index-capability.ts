// SPDX-License-Identifier: Apache-2.0

import type { ChainEventLogStore } from './chain-index/chain-event-log.js';
import type { KnowledgeAssetReadModelFactory } from './chain-index/knowledge-asset-read-model.js';

/** The process-owned log and the optional reader bound to that same log. */
export interface ChainIndexCapability {
  readonly store: ChainEventLogStore;
  readonly readModelFactory?: KnowledgeAssetReadModelFactory;
}

/** Extendable SDK input; contradictory ownership is rejected during construction. */
export interface ChainIndexCompatibilityConfig {
  chainIndex?: ChainIndexCapability;
  /** @deprecated Use chainIndex: { store } for new callers. */
  chainEventLogStore?: ChainEventLogStore;
}

/** Exactly one owning capability, its legacy store-only input, or no owner. */
export type ChainIndexConfig =
  | { readonly chainIndex: ChainIndexCapability; readonly chainEventLogStore?: never }
  | {
    readonly chainIndex?: never;
    /** @deprecated Use chainIndex: { store } for new callers. */
    readonly chainEventLogStore: ChainEventLogStore;
  }
  | { readonly chainIndex?: never; readonly chainEventLogStore?: never };

/** Normalize the store-only SDK input once, before passing the capability on. */
export function resolveChainIndexCapability(config: ChainIndexCompatibilityConfig): ChainIndexCapability | undefined {
  if (config.chainIndex !== undefined && config.chainEventLogStore !== undefined) {
    throw new TypeError('Supply chainIndex or the legacy chainEventLogStore, not both');
  }
  if (config.chainIndex !== undefined && config.chainIndex?.store === undefined) {
    throw new TypeError('chainIndex requires its process-owned store');
  }
  return config.chainIndex ?? (config.chainEventLogStore === undefined
    ? undefined
    : { store: config.chainEventLogStore });
}

// SPDX-License-Identifier: Apache-2.0

import type { ChainEventLogStore } from './chain-index/chain-event-log.js';
import type { KnowledgeAssetReadModelFactory } from './chain-index/knowledge-asset-read-model.js';

/** The process-owned log and the optional reader bound to that same log. */
export interface ChainIndexCapability {
  readonly store: ChainEventLogStore;
  readonly readModelFactory?: KnowledgeAssetReadModelFactory;
}

/** Normalize the store-only SDK input once, before passing the capability on. */
export function resolveChainIndexCapability(config: {
  readonly chainIndex?: ChainIndexCapability;
  readonly chainEventLogStore?: ChainEventLogStore;
}): ChainIndexCapability | undefined {
  if ('chainEventLogReadModelFactory' in config) {
    throw new TypeError('A custom chain-index reader must be supplied with its store in chainIndex');
  }
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

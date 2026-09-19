// SPDX-License-Identifier: Apache-2.0

/**
 * The node's ONE chain log.
 *
 * One tick, one cursor, one `chain_events` table, one backfill. Everything that
 * needs an indexed on-chain event subscribes here; nothing else polls for one.
 */

export {
  chainEventLogCoverageIncludes,
  chainEventLogCoverageIsComplete,
  chainEventLogTopicSetVersion,
  extendChainEventLogCoverage,
  findChainEventLogCoverage,
  normalizeChainEventLogAddress,
  normalizeChainEventLogBlockNumber,
  normalizeChainEventLogHash,
  type ChainEventLogCommit,
  type ChainEventLogCoverage,
  type ChainEventLogCursor,
  type ChainEventLogHead,
  type ChainEventLogQuery,
  type ChainEventLogRow,
  type ChainEventLogState,
  type ChainEventLogStore,
  type ChainEventLogTopicSet,
} from './chain-event-log.js';

export {
  ChainEventDecoderRegistry,
  HUB_ROTATION_EVENT_NAMES,
  type ChainEventLogFamily,
  type HubRotationEvent,
  type HubRotationEventName,
} from './chain-event-decoders.js';

export {
  currentHubBinding,
  hubBoundAddressesForRange,
  reduceHubBindings,
  splitRangeAtHubRotations,
  type HubBinding,
  type HubBindingReduction,
} from './hub-bindings.js';

export {
  CHAIN_EVENT_LOG_ZERO_HASH,
  ChainIndexTick,
  type ChainEventLogFetchedRow,
  type ChainIndexLogRequest,
  type ChainIndexObservedHead,
  type ChainIndexTickOptions,
  type ChainIndexTickOutcome,
  type ChainIndexTickPorts,
  type ChainIndexTickResult,
} from './chain-index-tick.js';

export {
  ChainIndexRunner,
  type ChainIndexRunnerOptions,
} from './chain-index-runner.js';

export {
  resolveChainIndexAuthorityAnchor,
  type ChainIndexAnchorRefusal,
  type ChainIndexAnchorResult,
  type ChainIndexAuthorityAnchor,
  type ResolveChainIndexAuthorityAnchorInput,
} from './chain-index-anchor.js';

export {
  createChainIndexAuthorityPageSource,
  type ChainIndexAuthorityPageSource,
  type ChainIndexAuthorityPageSourceOptions,
} from './chain-index-authority-page.js';

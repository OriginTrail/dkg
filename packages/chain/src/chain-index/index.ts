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
  chainEventLogStateReadRefusal,
  chainEventLogTopicSetVersion,
  extendChainEventLogCoverage,
  findChainEventLogCoverage,
  normalizeChainEventLogAddress,
  normalizeChainEventLogBlockNumber,
  normalizeChainEventLogHash,
  type ChainEventLogCommit,
  type ChainEventLogCountQuery,
  type ChainEventLogCoverage,
  type ChainEventLogCursor,
  type ChainEventLogHead,
  type ChainEventLogQuery,
  type ChainEventLogRow,
  type ChainEventLogState,
  type ChainEventLogStateReadRefusal,
  type ChainEventLogStore,
  type ChainEventLogTopicSet,
} from './chain-event-log.js';

export {
  chainEventLogTombstoneGeneration,
  tombstoneChainEventLogScope,
} from './chain-event-log-tombstones.js';

export {
  CHAIN_EVENT_LOG_FAMILIES,
  ChainEventDecoderRegistry,
  HUB_ROTATION_EVENT_NAMES,
  KNOWLEDGE_ASSET_EVENT_NAMES,
  type ChainEventLogFamily,
  type ContextGraphKaRegistration,
  type HubRotationEvent,
  type HubRotationEventName,
  type KnowledgeAssetEvent,
  type KnowledgeAssetEventName,
  type KnowledgeAssetMerkleRootEntry,
} from './chain-event-decoders.js';

export {
  latestMerkleRootOf,
  reduceContextGraphKaRegistrations,
  reduceKnowledgeAssetEvents,
  type ContextGraphKaList,
  type KnowledgeAssetRootStack,
  type KnowledgeAssetRootVersion,
} from './knowledge-asset-reducer.js';

export {
  createChainEventLogSubscription,
  type ChainEventLogServableRange,
  type ChainEventLogSubscription,
  type ChainEventLogSubscriptionOptions,
} from './chain-event-log-subscription.js';

export {
  createKnowledgeAssetReadModel,
  type ContextGraphForKaAnswer,
  type ContextGraphKaAtAnswer,
  type KnowledgeAssetOwnWrite,
  type KnowledgeAssetReadModel,
  type KnowledgeAssetReadModelOptions,
  type KnowledgeAssetReadOptions,
  type KnowledgeAssetReadView,
} from './knowledge-asset-read-model.js';

export {
  hubBindingSuccessions,
  hubBoundAddressesForRange,
  reduceHubBindings,
  splitRangeAtHubRotations,
  type HubBinding,
  type HubBindingReduction,
  type HubBindingSuccession,
} from './hub-bindings.js';

export {
  CHAIN_EVENT_LOG_ZERO_HASH,
  ChainIndexTick,
  chainEventLogFloorKey,
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
  chainIndexAuthorityAnchorHolds,
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

// SPDX-License-Identifier: Apache-2.0

/**
 * The consumer labels RPC usage is attributed to: how a code-owned read label
 * is normalized, and the closed, versioned vocabulary that a retained process
 * snapshot may serialize. Static declarations with no tracker state;
 * `rpc-usage.ts` re-exports the public ones, which is where callers import
 * them from.
 */
import {
  CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER,
  CONTEXT_GRAPH_AUTHORITY_RPC_SITES,
} from './context-graph-authority-rpc-sites.js';

/**
 * Longest attributed consumer key that survives the daemon's logfmt token
 * guard (`packages/cli/src/daemon/rpc-usage-log.ts` `safeToken`) and this
 * module's own normalizer. A composition past it (`rpc-usage.ts`) degrades to
 * the bare read label rather than to `other`, so the billing view never loses
 * a read.
 */
export const MAX_RPC_USAGE_CONSUMER_CHARS = 64;

function isRpcUsageConsumerCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || char === '_'
    || char === '.'
    || char === ':'
    || char === '-'
  );
}

/**
 * Bound code-owned read labels for logfmt-safe consumer attribution. Labels are
 * intentionally not derived from calldata, addresses, request ids, or peer ids.
 */
export function normalizeRpcUsageConsumer(consumer: string | undefined): string | undefined {
  if (typeof consumer !== 'string') return undefined;
  let normalized = '';
  let previousWasUnderscore = false;
  for (const char of consumer.trim()) {
    const normalizedChar = isRpcUsageConsumerCharacter(char) ? char : '_';
    if (normalizedChar === '_') {
      if (normalized.length === 0 || previousWasUnderscore) continue;
      previousWasUnderscore = true;
    } else {
      previousWasUnderscore = false;
    }
    normalized += normalizedChar;
    // A final underscore can still be removed. Past that point, the bounded
    // result is necessarily `other`, so never accumulate an unbounded label.
    if (normalized.length > MAX_RPC_USAGE_CONSUMER_CHARS + 1) return 'other';
  }
  if (normalized.endsWith('_')) normalized = normalized.slice(0, -1);
  if (normalized.length === 0) return undefined;
  if (normalized.length > MAX_RPC_USAGE_CONSUMER_CHARS) return 'other';
  return normalized;
}

const RPC_USAGE_SNAPSHOT_RAW_CONSUMERS = [
  // Explicit remainder and overflow buckets.
  'unattributed',
  'other',

  // Fixed header reads.
  'chainIndex.head',
  'chainIndex.lineage',
  'chainIndex.authorityLineage',
  'authorityIndex.head',
  'authorityIndex.anchor',
  'authorityIndex.lineage',
  'authorityIndex.stabilize',
  'authorityProjection.validateAnchor',
  'receiptFinality.head',
  'receiptFinality.header',

  // Event-log scans.
  'eventLogPageScan',
  'getMaxKaNumberForAuthor',
  'listContextGraphsFromChain',
  'repairContextGraphRegistry',
  'resolveContextGraphIdByNameHash',
  'kasV9.queryFilter(KnowledgeBatchCreated)',
  'cgStorage.queryFilter(ContextGraphExpanded)',
  'cgStorage.queryFilter(KnowledgeAssetRegisteredToContextGraph)',
  'kas.queryFilter(KnowledgeAssetCreated)',
  'kas.queryFilter(KnowledgeAssetsMinted)',
  'kas.queryFilter(Transfer)',
  'cgNameRegistry.queryFilter(NameClaimed)',
  'cgStorage.queryFilter(ContextGraphCreated)',
  'profileStorage.queryFilter(RelayCapabilityUpdated)',

  // Provider reads and fixed projection operations.
  'transaction lookup',
  'publish wallet native balance',
  'allowance visibility poll',
  'getBlock',
  'getBlockNumber',
  'getNetwork (chainId)',
  'validate configured chainId',
  'hasContractCode getCode',
  'DKGKnowledgeAssets.getMaxKaNumberForAuthor',
  'DKGKnowledgeAssets getCode',
  'Hub rotation poll getBlockNumber',
  'Hub rotation poll getLogs',
  'Hub rotation poll initial getBlockNumber',
  'resolveContextGraphIdByNameHash current-slot anchor',
  'resolveContextGraphIdByNameHash validate current-slot anchor',
  'getContextGraphAuthoritySnapshot',
  'conviction getBlock',
  'confirmation-depth chain-proof snapshot',
  'publish receipt finality',
  'resolveFinalizedContextGraphIdByNameHash',
  'resolveFinalizedContextGraphIdsByNameHashes',
  'resolveFinalizedContextGraphAuthoritySnapshotByNameHash',
  'resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes',
  'readContextGraphAuthorityIndexRevisions',
  'readContextGraphAuthorityIndexSnapshots',

  // Browser-wallet RPC labels are generated from the closed method union.
  'browser wallet rpc eth_chainId',
  'browser wallet rpc eth_call',
  'browser wallet rpc eth_getTransactionReceipt',
  'browser wallet rpc eth_getTransactionByHash',
  'browser wallet rpc eth_blockNumber',
  'browser wallet rpc eth_getBlockByNumber',

  // Fixed contract-view labels.
  'parametersStorage.minimumRequiredSignatures',
  'parametersStorage.contextGraphRegistrationDeposit',
  'shardingTableStorage.nodeExists',
  'shardingTable.getShardingTable',
  'identityStorage.getIdentityId',
  'identityStorage.keyHasPurpose',
  'contextGraphs.isAuthorizedPublisher',
  'token.allowance',
  'token.balanceOf',
  'IERC1271.isValidSignature',
  'chronos.getCurrentEpoch',
  'cgStorage.isContextGraphActive',
  'cgStorage.kaToContextGraph',
  'cgStorage.getContextGraphKaCount',
  'cgStorage.getContextGraphKaAt',
  'cgStorage.getAccessPolicy',
  'cgStorage.getPublishPolicy',
  'cgStorage.getParticipantAgents',
  'cgStorage.getNameHash',
  'pcaNFT.agentToAccountId',
  'pcaNFT.accounts',
  'pcaNFT.getRemainingAllowance',
  'pcaNFT.ownerOf',
  'pcaNFT.getAccountInfo',
  'pcaNFT.isAgent',
  'pcaNFT.balanceOf',
  'pcaNFT.tokenOfOwnerByIndex',
  'pcaNFT.getRegisteredAgents',
  'profileStorage.getRelayCapable',
  'askStorage.getStakeWeightedAverageAsk',
  'kas.getLatestMerkleRoot',
  'kas.getKnowledgeAssetUpdateContext',
  'kas.getMerkleRootsAtUpdateBlock',
  'kas.getMerkleRootsBeforeUpdateBlock',
  'kas.getTokenAmount',
  'kas.getMerkleRoots',
  'kas.getLatestMerkleRootPublisher',
  'kas.getLatestMerkleRootAuthor',
  'kas.getMerkleLeafCount',
  'kas.getCatalogRoot',
  'kas.getCatalogLeafCount',
  'kasV9.getBatchPublisher',
  'kasV9.getPublisherRangesCount',
  'kasV9.getPublisherRange',
  'DKGKnowledgeAssets.ownerOf',
  'rss.getNodeChallenge',
  'rss.getNodeEpochProofPeriodScore',

  // The marketplace's views (evm-adapter-marketplace.ts), by contract.
  'marketplace epoch times', 'chronos.epochAtTimestamp', 'chronos.timestampForEpoch',
  'serviceSubscriptions.previewCost', 'serviceSubscriptions.currentWindowAllowance',
  'serviceSubscriptionsStorage.getSubscription', 'serviceSubscriptionsStorage.getBudgets',
  'serviceSubscriptionsStorage.subscriptionExists', 'serviceSubscriptionsStorage.getGrant',
  'serviceSubscriptionsStorage.grantEnd', 'serviceSubscriptionsStorage.grantNonce',
  'serviceSubscriptionsStorage.getServiceSpending', 'serviceSubscriptionsStorage.maxBudgetsPerSubscription',
  'serviceSubscriptionsStorage.buyerCount', 'serviceSubscriptionsStorage.buyerAt',
  'queryInferenceSettlement.budgetLeft', 'queryInferenceSettlement.stakeFactor',
  'queryInferenceSettlement.epochPool', 'queryInferenceSettlement.queryInferenceGross',
  'queryInferenceStorage.batchState', 'queryInferenceStorage.nonceWord', 'queryInferenceStorage.budgetUsed',
  'queryInferenceStorage.fundingIn', 'queryInferenceStorage.getEpochTotals', 'queryInferenceStorage.getNodeEpoch',
  'shardingTableStorage.getNode', 'randomSamplingStorage.getNodeEpochScore',
  'profileStorage.profileExists', 'convictionStakingStorage.getNodeStakeV10', 'parametersStorage.minimumStake',
  'parametersStorage.protocolTreasury', 'marketplace wallet balance', 'marketplace wallet nonce', 'marketplace base fee',

  // Background views coalesced into one request, and the bytecode check before it.
  'multicall3.aggregate3',
  'multicall3.getCode',
] as const;

const RPC_USAGE_SNAPSHOT_HUB_CONTRACT_NAMES = [
  'RandomSampling',
  'RandomSamplingStorage',
  'IdentityStorage',
  'ConvictionStakingStorage',
  'StakingStorage',
  'Identity',
  'Profile',
  'ParametersStorage',
  'Staking',
  'ProfileStorage',
  'KnowledgeAssets',
  'AskStorage',
  'ContextGraphNameRegistry',
  'ContextGraphs',
  'KnowledgeAssetsLifecycle',
  'DKGPublishingConvictionNFT',
  'DKGStakingConvictionNFT',
  'ShardingTableStorage',
  'PublishingConviction',
  'ShardingTable',
  'Chronos',
  'Token',
  'StakingV10',
  'ServiceSubscriptions',
  'ServiceSubscriptionsWallet',
  'ServiceSubscriptionsStorage',
  'QueryInferenceSettlement',
  'QueryInferenceStorage',
] as const;

const RPC_USAGE_SNAPSHOT_HUB_ASSET_NAMES = [
  'DKGKnowledgeAssets',
  'KnowledgeAssetsStorage',
  'ContextGraphStorage',
] as const;

/**
 * Update deliberately when a new code-owned consumer is added.
 *
 * v2 adds the fourteen residual `cgStorage.getContextGraph:cgAuth.*` call-site
 * labels. Membership only — the snapshot SHAPE is versioned separately by
 * `schemaVersion`, so a reader that pins a label vocabulary must gate on this
 * field rather than infer stability from the shape version.
 *
 * v3 adds `multicall3.aggregate3` and `multicall3.getCode`: one aggregate
 * request now carries background views that v2 counted one request each under
 * their own labels.
 *
 * v4 adds the marketplace's Hub lookups and views (evm-adapter-marketplace.ts).
 */
export const RPC_USAGE_SNAPSHOT_CONSUMER_VOCABULARY_VERSION = 4 as const;

/** Complete closed vocabulary that the cumulative diagnostic may serialize. */
export const RPC_USAGE_SNAPSHOT_CONSUMERS: readonly string[] = Object.freeze(
  [...new Set([
    ...RPC_USAGE_SNAPSHOT_RAW_CONSUMERS,
    ...RPC_USAGE_SNAPSHOT_HUB_CONTRACT_NAMES.map(
      (name) => `Hub.getContractAddress(${name})`,
    ),
    ...RPC_USAGE_SNAPSHOT_HUB_ASSET_NAMES.map(
      (name) => `Hub.getAssetStorageAddress(${name})`,
    ),
    CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER,
    ...Object.values(CONTEXT_GRAPH_AUTHORITY_RPC_SITES).map(
      (site) => `${CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER}:${site}`,
    ),
  ])]
    .map((consumer) => normalizeRpcUsageConsumer(consumer) ?? 'other')
    .sort(),
);

const RPC_USAGE_SNAPSHOT_CONSUMER_SET: ReadonlySet<string> =
  new Set(RPC_USAGE_SNAPSHOT_CONSUMERS);

/**
 * Final privacy boundary for consumer labels retained by process snapshots.
 *
 * Existing window drains keep their diagnostic labels, but the authenticated
 * cumulative route is long-lived and machine-readable. Even an accidentally
 * caller-supplied label must therefore fail closed before it reaches retained
 * storage. Only the exported, versioned code-owned vocabulary can survive;
 * every unknown value collapses to the fixed `other` bucket.
 */
export function boundedRpcUsageSnapshotConsumerLabel(
  consumer: string | undefined,
): string | undefined {
  const normalized = normalizeRpcUsageConsumer(consumer);
  if (normalized === undefined) return undefined;
  return RPC_USAGE_SNAPSHOT_CONSUMER_SET.has(normalized) ? normalized : 'other';
}

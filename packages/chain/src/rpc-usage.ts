// SPDX-License-Identifier: Apache-2.0
/**
 * RAW JSON-RPC request accounting — the PROVIDER-BILLING view of chain usage.
 *
 * Why this exists (incident-driven): a node burned ~$200 of RPC credits in a
 * day and nothing measured it. The existing `dkg.chain.rpc.total` counts
 * LOGICAL chain operations (one contract read, one broadcast, …), but providers
 * bill per raw JSON-RPC request, and one logical op fans out into several raw
 * requests (a tx populate alone issues eth_estimateGas + eth_getTransactionCount
 * + eth_chainId + fee reads). So credit burn must be counted at the TRANSPORT
 * choke-point: `JsonRpcProvider.send(method, …)`. The adapter constructs its
 * providers with `batchMaxCount: 1` (see evm-adapter-base), so one `send()` ==
 * one HTTP JSON-RPC request == one billable unit — the count is exact.
 *
 * Three consumers, one tracker:
 *  - OTel counter `dkg.chain.rpc.requests.total{rpc_method, chain_id}` — for
 *    the metrics backend once one is provisioned.
 *  - `drainWindow()` — per-window DELTA counts the daemon logs as structured
 *    `rpc_usage` lines every minute, which ride the already-deployed
 *    OTLP-logs → Alloy → Loki path so Grafana can chart RPC usage per node /
 *    per method TODAY, with exact sums (deltas, not cumulative gauges).
 *  - `snapshotProcessRpcUsage()` — non-draining, process-lifetime cumulative
 *    totals for authenticated diagnostic interval measurements.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { getMetrics } from '@origintrail-official/dkg-core';
import {
  CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER,
  CONTEXT_GRAPH_AUTHORITY_RPC_SITES,
  type ContextGraphAuthorityRpcSite,
} from './context-graph-authority-rpc-sites.js';

/**
 * The JSON-RPC methods our own code (via ethers v6) can issue. Used to BOUND
 * the metric label — anything outside maps to 'other' so the label set can
 * never grow unbounded. (Methods are self-generated, not peer input, so this is
 * defensive; the raw method still appears verbatim in the rpc_usage log lines,
 * where cardinality is not a concern.)
 */
export const KNOWN_RPC_METHODS: ReadonlySet<string> = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getLogs',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_sendRawTransaction',
  'eth_newFilter',
  'eth_getFilterChanges',
  'eth_uninstallFilter',
  'net_version',
  'web3_clientVersion',
]);

/** Bound a method name for use as a metric label (unknown → 'other'). */
export function boundedRpcMethodLabel(method: string): string {
  return KNOWN_RPC_METHODS.has(method) ? method : 'other';
}

/** Fixed process-level source roles. Values never derive from operator or peer input. */
export const RPC_USAGE_ADAPTER_ROLES = Object.freeze([
  'main_agent',
  'publisher_wallet',
  'route_runtime',
  'other',
] as const);
export type RpcUsageAdapterRole = typeof RPC_USAGE_ADAPTER_ROLES[number];
const RPC_USAGE_ADAPTER_ROLE_SET: ReadonlySet<string> = new Set(RPC_USAGE_ADAPTER_ROLES);

export function normalizeRpcUsageAdapterRole(value: unknown): RpcUsageAdapterRole {
  return typeof value === 'string' && RPC_USAGE_ADAPTER_ROLE_SET.has(value)
    ? value as RpcUsageAdapterRole
    : 'other';
}

/** The complete bounded vocabulary for individually attributed endpoint slots. */
export const RPC_ENDPOINT_SLOT_LABELS = Object.freeze([
  'primary',
  'fallback_1',
  'fallback_2',
  'fallback_3',
  'fallback_4',
  'fallback_5',
  'fallback_6',
  'fallback_7',
  'fallback_8',
  'fallback_9',
  'fallback_10',
  'fallback_11',
  'fallback_12',
  'fallback_13',
  'fallback_14',
  'fallback_15',
] as const);

type TrackedRpcEndpointSlotLabel = typeof RPC_ENDPOINT_SLOT_LABELS[number];
export type RpcEndpointSlotLabel = TrackedRpcEndpointSlotLabel | 'other';
const RPC_ENDPOINT_SLOT_LABEL_SET: ReadonlySet<string> = new Set(RPC_ENDPOINT_SLOT_LABELS);

/** Canonical method-aware diagnostic attribution carried by a usage window. */
export type RpcUsageAttribution =
  | { readonly method: 'eth_call'; readonly consumer: string; readonly count: number }
  | {
      readonly method:
        | 'eth_blockNumber'
        | 'eth_getBlockByNumber'
        | 'eth_getBlockByHash';
      readonly consumer: string;
      readonly count: number;
    }
  | {
      readonly method: 'eth_getLogs';
      readonly consumer: string;
      readonly endpointSlot: RpcEndpointSlotLabel;
      readonly count: number;
    };

type ConcreteRpcUsageWindow = NormalizedRpcUsageWindow & {
  readonly attributions: readonly RpcUsageAttribution[];
};

function normalizeRpcUsageAttribution(value: unknown): RpcUsageAttribution | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as {
    method?: unknown;
    consumer?: unknown;
    endpointSlot?: unknown;
    count?: unknown;
  };
  if (typeof candidate.consumer !== 'string' || typeof candidate.count !== 'number') {
    return undefined;
  }
  if (
    candidate.method === 'eth_call'
    || candidate.method === 'eth_blockNumber'
    || candidate.method === 'eth_getBlockByNumber'
    || candidate.method === 'eth_getBlockByHash'
  ) {
    return {
      method: candidate.method,
      consumer: candidate.consumer,
      count: candidate.count,
    };
  }
  if (candidate.method === 'eth_getLogs') {
    return {
      method: 'eth_getLogs',
      consumer: candidate.consumer,
      endpointSlot: normalizeRpcEndpointSlotLabel(candidate.endpointSlot),
      count: candidate.count,
    };
  }
  return undefined;
}

export function emptyRpcUsageWindow(): ConcreteRpcUsageWindow {
  return {
    byMethod: {},
    ethCallByConsumer: {},
    attributions: [],
    lifetimeTotal: 0,
  };
}

/** Normalize a public drain-window input into the concrete telemetry model. */
export function normalizeRpcUsageWindow(window: RpcUsageWindow): ConcreteRpcUsageWindow {
  const attributions = window.attributions
    ? window.attributions.flatMap((value) => {
        const normalized = normalizeRpcUsageAttribution(value);
        return normalized === undefined ? [] : [normalized];
      })
    : [
        ...Object.entries(window.ethCallByConsumer ?? {}).map(
          ([consumer, count]): RpcUsageAttribution => ({ method: 'eth_call', consumer, count }),
        ),
        ...Object.entries(window.ethGetLogsByConsumerAndEndpointSlot ?? {}).flatMap(
          ([consumer, byEndpointSlot]) => Object.entries(byEndpointSlot).map(
            ([endpointSlot, count]): RpcUsageAttribution => ({
              method: 'eth_getLogs',
              consumer,
              endpointSlot: normalizeRpcEndpointSlotLabel(endpointSlot),
              count,
            }),
          ),
        ),
      ];
  const ethCallByConsumer: Record<string, number> = {};
  for (const attribution of attributions) {
    if (attribution.method !== 'eth_call') continue;
    ethCallByConsumer[attribution.consumer] =
      (ethCallByConsumer[attribution.consumer] ?? 0) + attribution.count;
  }
  return {
    byMethod: window.byMethod,
    ethCallByConsumer,
    attributions,
    lifetimeTotal: window.lifetimeTotal,
  };
}

/**
 * THE drain contract — one name for one concept, wherever a usage window can
 * be drained from: an agent (delegates to its adapter), a publisher runtime
 * (merges its per-wallet adapters), or the daemon's composite source. Deltas
 * since the previous drain. Always a concrete window: capability-optionality
 * exists only at the ChainAdapter API edge and is collapsed to
 * emptyRpcUsageWindow() the moment it crosses into a drainable, so consumers
 * never juggle "missing capability" vs "empty window".
 */
export interface RpcUsageDrainable {
  drainRpcUsage(): RpcUsageWindow;
}

/**
 * Merge usage windows from multiple trackers into one (pure model operation:
 * per-method sums, summed lifetimes). A process can own several
 * chain adapters with independent trackers — one per configured RPC consumer
 * (e.g. the agent's adapter plus one per publisher wallet); billing-exact
 * accounting is the SUM across all of them. undefined inputs (an absent
 * optional capability, a not-yet-started runtime) are skipped; the result is
 * always a concrete window — empty when there is nothing to merge.
 */
export function mergeRpcUsageWindows(
  ...windows: Array<RpcUsageWindow | undefined>
): NormalizedRpcUsageWindow {
  const defined = windows.filter((w): w is RpcUsageWindow => w !== undefined);
  if (defined.length === 0) return emptyRpcUsageWindow();
  const byMethod: Record<string, number> = {};
  const attributions = new Map<string, RpcUsageAttribution>();
  let lifetimeTotal = 0;
  for (const input of defined) {
    const w = normalizeRpcUsageWindow(input);
    for (const [m, c] of Object.entries(w.byMethod)) byMethod[m] = (byMethod[m] ?? 0) + c;
    for (const attribution of w.attributions) {
      const key = attribution.method === 'eth_getLogs'
        ? `${attribution.method}\0${attribution.consumer}\0${attribution.endpointSlot}`
        : `${attribution.method}\0${attribution.consumer}`;
      const current = attributions.get(key);
      attributions.set(key, {
        ...attribution,
        count: (current?.count ?? 0) + attribution.count,
      } as RpcUsageAttribution);
    }
    lifetimeTotal += w.lifetimeTotal;
  }
  const mergedAttributions = [...attributions.values()];
  const ethCallByConsumer: Record<string, number> = {};
  for (const attribution of mergedAttributions) {
    if (attribution.method !== 'eth_call') continue;
    ethCallByConsumer[attribution.consumer] = attribution.count;
  }
  return {
    byMethod,
    ethCallByConsumer,
    attributions: mergedAttributions,
    lifetimeTotal,
  };
}

export interface RpcUsageWindow {
  /**
   * Raw requests since the previous drain, keyed by the RAW JSON-RPC method
   * name (NOT sanitized — full diagnostic fidelity is the point). Keys are
   * bounded in COUNT, not value: at most {@link RpcUsageTracker.MAX_WINDOW_METHODS}
   * distinct names per window, overflow aggregated under 'other'. Consumers
   * must sanitize keys for their own sink (the cli logfmt formatter does).
   */
  byMethod: Record<string, number>;
  /**
   * Raw `eth_call` attribution by bounded code-owned consumer label.
   * This is a companion diagnostic dimension only: `byMethod.eth_call` remains
   * the billing-exact aggregate count and existing dashboards should continue
   * to use it. The consumer map is emitted as separate daemon log lines so it
   * cannot double-count aggregate `rpc_usage` queries. Empty map means no
   * attributed `eth_call`s in the current drain window. Optional only to
   * preserve source compatibility for external drain sources that still return
   * the pre-attribution aggregate window. Package-owned producers return the
   * concrete {@link NormalizedRpcUsageWindow} shape.
   */
  ethCallByConsumer?: Record<string, number>;
  /**
   * Canonical diagnostic attribution. When absent, normalization accepts the
   * legacy method-specific maps below for source compatibility.
   */
  attributions?: readonly RpcUsageAttribution[];
  /**
   * Raw `eth_getLogs` attribution by bounded code-owned consumer and configured
   * endpoint slot. This is diagnostic detail only: `byMethod.eth_getLogs`
   * remains the billing-exact aggregate. Endpoint slots are deliberately
   * opaque (`primary`, `fallback_1` ... `fallback_15`, `other`) so provider
   * URLs, credentials, and hostnames can never enter this telemetry surface.
   * Unscoped calls use the fixed `unattributed` consumer, which makes the
   * detail sum reconcile with the aggregate for package-owned producers.
   * Optional for source compatibility with pre-attribution drain sources.
   */
  ethGetLogsByConsumerAndEndpointSlot?: Record<string, Record<string, number>>;
  /** Raw requests since process start (monotonic; NOT reset by drain). */
  lifetimeTotal: number;
}

/** Concrete package-owned telemetry window after legacy inputs are normalized. */
export interface NormalizedRpcUsageWindow extends RpcUsageWindow {
  ethCallByConsumer: Record<string, number>;
}

/**
 * Total raw requests in a window — DERIVED from byMethod on demand. The
 * window model deliberately stores no separate total, so an inconsistent
 * {byMethod, total} pair is unrepresentable.
 */
export function rpcUsageWindowTotal(window: Pick<RpcUsageWindow, 'byMethod'>): number {
  let total = 0;
  for (const count of Object.values(window.byMethod)) total += count;
  return total;
}

const rpcUsageConsumerContext = new AsyncLocalStorage<string>();
const rpcUsageSiteContext = new AsyncLocalStorage<string>();
const rpcUsageAdapterRoleContext = new AsyncLocalStorage<RpcUsageAdapterRole>();

/**
 * Longest attributed consumer key that survives the daemon's logfmt token
 * guard (`packages/cli/src/daemon/rpc-usage-log.ts` `safeToken`) and this
 * module's own normalizer. A composition past it degrades to the bare read
 * label rather than to `other`, so the billing view never loses a read.
 */
const MAX_RPC_USAGE_CONSUMER_CHARS = 64;

/**
 * Bound code-owned read labels for logfmt-safe consumer attribution. Labels are
 * intentionally not derived from calldata, addresses, request ids, or peer ids.
 */
export function normalizeRpcUsageConsumer(consumer: string | undefined): string | undefined {
  if (typeof consumer !== 'string') return undefined;
  const normalized = consumer
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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
] as const;

const RPC_USAGE_SNAPSHOT_HUB_ASSET_NAMES = [
  'DKGKnowledgeAssets',
  'KnowledgeAssetsStorage',
  'ContextGraphStorage',
] as const;

/** Update deliberately when a new code-owned consumer is added. */
export const RPC_USAGE_SNAPSHOT_CONSUMER_VOCABULARY_VERSION = 1 as const;

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

/** Run a provider read under a bounded diagnostic consumer label. */
export function withRpcUsageConsumer<T>(consumer: string, fn: () => T): T {
  const normalized = normalizeRpcUsageConsumer(consumer);
  if (!normalized) return fn();
  return rpcUsageConsumerContext.run(normalized, fn);
}

/**
 * Assign a fixed role to trackers constructed inside `fn`. The role is read
 * once at construction, so later asynchronous work cannot drift between roles.
 */
export function withRpcUsageAdapterRole<T>(role: RpcUsageAdapterRole, fn: () => T): T {
  return rpcUsageAdapterRoleContext.run(normalizeRpcUsageAdapterRole(role), fn);
}

/**
 * Attribute a read to the CALL SITE that wanted it, beside the read label.
 *
 * The consumer label above is established by the transport itself
 * (`rpc-failover-client`), INNERMOST, so it always wins over anything a caller
 * wraps around its own code: every `getContextGraph` read is therefore billed
 * to one undifferentiated `cgStorage.getContextGraph`, whoever asked. That is
 * the blind spot this second dimension removes — a funnel read that ~26 call
 * sites share cannot be budgeted while they are indistinguishable.
 *
 * OUTERMOST WINS, unlike the consumer label: the first site entered in a call
 * tree is the caller we want (sync authorize, the publish probe, a VM
 * reconcile), and the funnel entry it passes through further down must not
 * overwrite it. So a funnel entry labels itself and is only reported when no
 * labelled caller sits above it. Sites are code-owned constants, never derived
 * from peer input, and an already-established site costs one ALS read.
 */
export function withRpcUsageSite<T>(site: ContextGraphAuthorityRpcSite, fn: () => T): T {
  if (rpcUsageSiteContext.getStore() !== undefined) return fn();
  const normalized = normalizeRpcUsageConsumer(site);
  if (!normalized) return fn();
  return rpcUsageSiteContext.run(normalized, fn);
}

/** Current diagnostic consumer label, if a caller established one. */
function activeRpcUsageConsumer(): string | undefined {
  return rpcUsageConsumerContext.getStore();
}

/** Current call-site label, if some caller up the stack established one. */
function activeRpcUsageSite(): string | undefined {
  return rpcUsageSiteContext.getStore();
}

function activeRpcUsageAdapterRole(): RpcUsageAdapterRole | undefined {
  return rpcUsageAdapterRoleContext.getStore();
}

export interface RpcUsageSnapshotCompleteness {
  readonly complete: boolean;
  readonly reasons: readonly string[];
  /** Monotonic tracker-registration generation within this process epoch. */
  readonly populationEpoch: number;
  readonly sources: Readonly<{
    mainAgent: RpcUsageSnapshotSourcePopulation;
    publisherWallets: RpcUsageSnapshotSourcePopulation;
    routeRuntimes: RpcUsageSnapshotSourcePopulation;
    other: RpcUsageSnapshotSourcePopulation;
  }>;
}

export interface RpcUsageSnapshotSourcePopulation {
  readonly status: 'included';
  /** Cumulative registrations, not a live-object count or stable identity. */
  readonly totalRegisteredTrackers: number;
  /** Attempts survive source retirement/replacement in the process aggregate. */
  readonly totalsRetained: true;
}

export interface RpcUsageCumulativeSnapshot {
  readonly schemaVersion: 1;
  readonly processEpoch: string;
  readonly capturedAtUtc: string;
  readonly capturedAtMonotonicMs: number;
  readonly completeness: RpcUsageSnapshotCompleteness;
  readonly cumulative: Readonly<{
    /** Authoritative physical-attempt totals. */
    methods: Readonly<Record<string, number>>;
    /** Overlapping detail dimension; each method reconciles to `methods`. */
    consumers: Readonly<Record<string, Readonly<Record<string, number>>>>;
    /** Overlapping detail dimension; each method reconciles to `methods`. */
    adapterRoles: Readonly<Record<string, Readonly<Record<string, number>>>>;
  }>;
}

export interface RpcUsageSnapshotClock {
  readonly utcNow?: () => Date;
  readonly monotonicNowMs?: () => number;
}

function incrementBoundedCounter(map: Map<string, number>, key: string): void {
  const current = map.get(key) ?? 0;
  map.set(key, current >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : current + 1);
}

function frozenRecord(map: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(map));
}

/**
 * Process-lifetime physical-attempt accumulator. It retains only bounded,
 * code-owned dimensions, so adapter retirement cannot make totals decrease and
 * no per-adapter identity remains resident.
 */
export class RpcUsageCumulativeAccumulator {
  static readonly MAX_CONSUMERS_PER_METHOD = 128;

  private readonly methods = new Map<string, number>();
  private readonly consumers = new Map<string, Map<string, number>>();
  private readonly adapterRoles = new Map<string, Map<string, number>>();
  private readonly registeredTrackers = new Map<RpcUsageAdapterRole, number>();

  constructor(readonly processEpoch: string = randomUUID()) {}

  registerTracker(adapterRole: RpcUsageAdapterRole): void {
    const role = normalizeRpcUsageAdapterRole(adapterRole);
    incrementBoundedCounter(this.registeredTrackers, role);
  }

  record(method: string, consumer: string | undefined, adapterRole: RpcUsageAdapterRole): void {
    const methodLabel = boundedRpcMethodLabel(method);
    incrementBoundedCounter(this.methods, methodLabel);

    const byConsumer = this.consumers.get(methodLabel) ?? new Map<string, number>();
    if (!this.consumers.has(methodLabel)) this.consumers.set(methodLabel, byConsumer);
    const requestedConsumer = boundedRpcUsageSnapshotConsumerLabel(consumer) ?? 'unattributed';
    const consumerLabel = byConsumer.has(requestedConsumer)
      || byConsumer.size < RpcUsageCumulativeAccumulator.MAX_CONSUMERS_PER_METHOD
      ? requestedConsumer
      : 'other';
    incrementBoundedCounter(byConsumer, consumerLabel);

    const byRole = this.adapterRoles.get(methodLabel) ?? new Map<string, number>();
    if (!this.adapterRoles.has(methodLabel)) this.adapterRoles.set(methodLabel, byRole);
    incrementBoundedCounter(byRole, normalizeRpcUsageAdapterRole(adapterRole));
  }

  snapshot(clock: RpcUsageSnapshotClock = {}): RpcUsageCumulativeSnapshot {
    const consumers = Object.fromEntries(
      [...this.consumers].map(([method, counts]) => [method, frozenRecord(counts)]),
    );
    const adapterRoles = Object.fromEntries(
      [...this.adapterRoles].map(([method, counts]) => [method, frozenRecord(counts)]),
    );
    const source = (role: RpcUsageAdapterRole): RpcUsageSnapshotSourcePopulation =>
      Object.freeze({
        status: 'included' as const,
        totalRegisteredTrackers: this.registeredTrackers.get(role) ?? 0,
        totalsRetained: true as const,
      });
    const sources = Object.freeze({
      mainAgent: source('main_agent'),
      publisherWallets: source('publisher_wallet'),
      routeRuntimes: source('route_runtime'),
      other: source('other'),
    });
    const populationEpoch = Object.values(sources).reduce(
      (sum, value) => sum + value.totalRegisteredTrackers,
      0,
    );
    return Object.freeze({
      schemaVersion: 1 as const,
      processEpoch: this.processEpoch,
      capturedAtUtc: (clock.utcNow?.() ?? new Date()).toISOString(),
      capturedAtMonotonicMs: clock.monotonicNowMs?.() ?? performance.now(),
      completeness: Object.freeze({
        complete: true,
        reasons: Object.freeze([]) as readonly string[],
        populationEpoch,
        sources,
      }),
      cumulative: Object.freeze({
        methods: frozenRecord(this.methods),
        consumers: Object.freeze(consumers),
        adapterRoles: Object.freeze(adapterRoles),
      }),
    });
  }
}

const processRpcUsage = new RpcUsageCumulativeAccumulator();

/** Non-draining process snapshot; taking it performs no chain I/O. */
export function snapshotProcessRpcUsage(
  clock: RpcUsageSnapshotClock = {},
): RpcUsageCumulativeSnapshot {
  return processRpcUsage.snapshot(clock);
}

/**
 * `readLabel:site` for the one Context Graph authority funnel when a call site
 * is in scope; all unrelated reads keep their bare consumer. Both halves are
 * already normalized, so the composition only has to stay inside the logfmt
 * token bound.
 */
function composeRpcUsageConsumer(
  consumer: string,
  site: string | undefined,
): string {
  if (site === undefined || consumer !== CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER) {
    return consumer;
  }
  const composed = `${consumer}:${site}`;
  return composed.length > MAX_RPC_USAGE_CONSUMER_CHARS ? consumer : composed;
}

/**
 * Bound endpoint identity to a fixed, non-secret configured slot. The first 16
 * configured endpoints retain individual attribution; larger or missing slots
 * collapse to `other` rather than expanding telemetry cardinality.
 */
export function normalizeRpcEndpointSlotLabel(value: unknown): RpcEndpointSlotLabel {
  if (value === 'other') return value;
  if (typeof value === 'string' && RPC_ENDPOINT_SLOT_LABEL_SET.has(value)) {
    return value as TrackedRpcEndpointSlotLabel;
  }
  return 'other';
}

export function boundedRpcEndpointSlotLabel(
  endpointSlot: number | undefined,
): RpcEndpointSlotLabel {
  if (
    typeof endpointSlot !== 'number'
    || !Number.isSafeInteger(endpointSlot)
    || endpointSlot < 0
  ) return 'other';
  return RPC_ENDPOINT_SLOT_LABELS[endpointSlot] ?? 'other';
}

/**
 * In-process accumulator for raw JSON-RPC request counts. `record()` is on the
 * hot path of every RPC — it does one map increment and one counter add, never
 * throws, and never touches the network.
 */
export class RpcUsageTracker {
  private window = new Map<string, number>();
  private ethCallConsumers = new Map<string, number>();
  private headerAttributions = new Map<
    string,
    { method: 'eth_blockNumber' | 'eth_getBlockByNumber' | 'eth_getBlockByHash'; consumer: string; count: number }
  >();
  private ethGetLogsAttributions = new Map<
    string,
    { consumer: string; endpointSlot: RpcEndpointSlotLabel; count: number }
  >();
  private lifetime = 0;
  constructor(
    // Live thunk (matches RpcFailoverClient): the adapter assigns `chainId`
    // after construction, so resolve it at record time.
    private readonly chainId: () => string,
    private readonly adapterRole: RpcUsageAdapterRole =
      activeRpcUsageAdapterRole() ?? 'main_agent',
    private readonly cumulative: RpcUsageCumulativeAccumulator = processRpcUsage,
  ) {
    this.adapterRole = normalizeRpcUsageAdapterRole(this.adapterRole);
    this.cumulative.registerTracker(this.adapterRole);
  }

  /**
   * Count one raw JSON-RPC request. Called from the provider's `_send` and the
   * FetchRequest retry hook. Window keys keep the RAW method name BY DESIGN:
   * the log path's `method` is parsed at Loki query time (logfmt), so raw
   * names cost no index cardinality and preserve full diagnostic fidelity
   * (seeing the real `debug_traceTransaction` is the point). Only the METRIC
   * label is bounded to the known set — Prometheus label cardinality is a
   * real storage cost. As a spam guard, a window holds at most
   * MAX_WINDOW_METHODS distinct raw keys; pathological method-name churn
   * (buggy caller, hostile input) overflows into 'other' instead of emitting
   * one rpc_usage log line per fabricated name every minute.
   */
  static readonly MAX_WINDOW_METHODS = 64;
  static readonly MAX_WINDOW_CONSUMERS = 128;
  static readonly MAX_TRACKED_ENDPOINT_SLOTS = RPC_ENDPOINT_SLOT_LABELS.length;
  static readonly MAX_WINDOW_GET_LOGS_ATTRIBUTIONS = 256;
  static readonly MAX_WINDOW_HEADER_ATTRIBUTIONS = 128;

  record(method: string, endpointSlot?: number): void {
    // Authoritative window/lifetime state first, OUTSIDE any try — pure map
    // arithmetic that cannot realistically throw, and it must never be
    // skipped because an OPTIONAL sink misbehaved.
    const raw = typeof method === 'string' && method.length > 0 && method.length <= 128 ? method : 'other';
    const key = this.window.has(raw) || this.window.size < RpcUsageTracker.MAX_WINDOW_METHODS ? raw : 'other';
    this.window.set(key, (this.window.get(key) ?? 0) + 1);
    if (raw === 'eth_call') {
      const activeConsumer = activeRpcUsageConsumer();
      const normalizedConsumer = activeConsumer === undefined
        ? undefined
        : composeRpcUsageConsumer(activeConsumer, activeRpcUsageSite());
      if (normalizedConsumer) {
        const consumerKey = this.ethCallConsumers.has(normalizedConsumer) ||
          this.ethCallConsumers.size < RpcUsageTracker.MAX_WINDOW_CONSUMERS
          ? normalizedConsumer
          : 'other';
        this.ethCallConsumers.set(consumerKey, (this.ethCallConsumers.get(consumerKey) ?? 0) + 1);
      }
    }
    if (
      raw === 'eth_blockNumber'
      || raw === 'eth_getBlockByNumber'
      || raw === 'eth_getBlockByHash'
    ) {
      const consumer = normalizeRpcUsageConsumer(activeRpcUsageConsumer()) ?? 'unattributed';
      const rawKey = `${raw}\0${consumer}`;
      const overflowKey = `${raw}\0other`;
      const overflow = !this.headerAttributions.has(rawKey)
        && this.headerAttributions.size >= RpcUsageTracker.MAX_WINDOW_HEADER_ATTRIBUTIONS;
      const key = overflow ? overflowKey : rawKey;
      const existing = this.headerAttributions.get(key);
      if (existing) existing.count += 1;
      else {
        this.headerAttributions.set(key, {
          method: raw,
          consumer: overflow ? 'other' : consumer,
          count: 1,
        });
      }
    }
    if (raw === 'eth_getLogs') {
      // Authority sites describe the `getContextGraph` eth_call funnel only;
      // they must not relabel unrelated log scans that happen in the same ALS
      // scope.
      const consumer = activeRpcUsageConsumer() ?? 'unattributed';
      const slot = boundedRpcEndpointSlotLabel(endpointSlot);
      const rawKey = `${consumer}\0${slot}`;
      const overflowKey = 'other\0other';
      const overflow = !this.ethGetLogsAttributions.has(rawKey)
        && this.ethGetLogsAttributions.size
          >= RpcUsageTracker.MAX_WINDOW_GET_LOGS_ATTRIBUTIONS;
      const key = overflow ? overflowKey : rawKey;
      const existing = this.ethGetLogsAttributions.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        this.ethGetLogsAttributions.set(key, {
          consumer: overflow ? 'other' : consumer,
          endpointSlot: overflow ? 'other' : slot,
          count: 1,
        });
      }
    }
    const activeConsumer = activeRpcUsageConsumer();
    const cumulativeConsumer = raw === 'eth_call' && activeConsumer !== undefined
      ? composeRpcUsageConsumer(activeConsumer, activeRpcUsageSite())
      : activeConsumer;
    this.cumulative.record(raw, cumulativeConsumer, this.adapterRole);
    this.lifetime += 1;
    // Best-effort applies ONLY to the OTel side effect (and the chainId
    // thunk it evaluates) — a throwing metrics backend must not break the
    // RPC call, and the window above is already committed either way.
    try {
      getMetrics().chainRpcRequestsTotal.add(1, {
        rpc_method: boundedRpcMethodLabel(method),
        chain_id: this.chainId(),
      });
    } catch {
      /* metrics emission must never break an RPC call */
    }
  }

  /**
   * Return the DELTA since the previous drain and reset the window. Deltas (not
   * cumulative totals) are what the daemon logs, so `sum_over_time` in Grafana
   * yields exact request counts over any range.
   */
  drainWindow(): ConcreteRpcUsageWindow {
    const byMethod: Record<string, number> = {};
    for (const [method, count] of this.window) byMethod[method] = count;
    this.window.clear();
    const ethCallByConsumer: Record<string, number> = {};
    for (const [consumer, count] of this.ethCallConsumers) ethCallByConsumer[consumer] = count;
    this.ethCallConsumers.clear();
    const attributions: RpcUsageAttribution[] = [
      ...Object.entries(ethCallByConsumer).map(
        ([consumer, count]): RpcUsageAttribution => ({ method: 'eth_call', consumer, count }),
      ),
      ...[...this.ethGetLogsAttributions.values()].map(
        ({ consumer, endpointSlot, count }): RpcUsageAttribution => ({
          method: 'eth_getLogs',
          consumer,
          endpointSlot: normalizeRpcEndpointSlotLabel(endpointSlot),
          count,
        }),
      ),
      ...[...this.headerAttributions.values()].map(
        ({ method, consumer, count }): RpcUsageAttribution => ({ method, consumer, count }),
      ),
    ];
    this.ethGetLogsAttributions.clear();
    this.headerAttributions.clear();
    return {
      byMethod,
      ethCallByConsumer,
      attributions,
      lifetimeTotal: this.lifetime,
    };
  }
}

/**
 * Narrow process-owned accounting capability for RPC callers that are not a
 * ChainAdapter (for example daemon diagnostics). The accumulator implementation
 * stays private to this package boundary while direct transports participate in
 * the same canonical usage-window contract.
 */
export interface RpcUsageRecorder extends RpcUsageDrainable {
  record(method: string, endpointSlot?: number): void;
}

export function createRpcUsageRecorder(
  chainId: () => string,
  adapterRole: RpcUsageAdapterRole = activeRpcUsageAdapterRole() ?? 'other',
): RpcUsageRecorder {
  const tracker = new RpcUsageTracker(chainId, adapterRole);
  return Object.freeze({
    record: (method: string, endpointSlot?: number) => tracker.record(method, endpointSlot),
    drainRpcUsage: () => tracker.drainWindow(),
  });
}

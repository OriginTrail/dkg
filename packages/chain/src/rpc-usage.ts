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
 * Two consumers, one tracker:
 *  - OTel counter `dkg.chain.rpc.requests.total{rpc_method, chain_id}` — for
 *    the metrics backend once one is provisioned.
 *  - `drainWindow()` — per-window DELTA counts the daemon logs as structured
 *    `rpc_usage` lines every minute, which ride the already-deployed
 *    OTLP-logs → Alloy → Loki path so Grafana can chart RPC usage per node /
 *    per method TODAY, with exact sums (deltas, not cumulative gauges).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { getMetrics } from '@origintrail-official/dkg-core';

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
/**
 * Label recorded when a request reaches the transport with no consumer scope.
 * It is deliberately a visible bucket rather than a dropped count: a silent gap
 * reads as "nobody asked" when it means "we could not say who".
 */
export const RPC_USAGE_UNATTRIBUTED_CONSUMER = 'unattributed' as const;

/**
 * A JSON-RPC method name as this node ever records one. Attribution inputs can
 * arrive from outside the process (merged windows), and a method that is not a
 * plain token is dropped rather than sanitized: a sanitized line would still
 * be a line the sender chose to inject.
 */
const RPC_USAGE_METHOD_TOKEN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

function isRpcUsageMethodToken(value: unknown): value is string {
  return typeof value === 'string' && RPC_USAGE_METHOD_TOKEN.test(value);
}

export type RpcUsageAttribution =
  | {
      readonly method: string;
      readonly consumer: string;
      readonly count: number;
      readonly endpointSlot?: undefined;
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
  if (isRpcUsageMethodToken(candidate.method) && candidate.method !== 'eth_getLogs') {
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
    if (attribution.consumer === RPC_USAGE_UNATTRIBUTED_CONSUMER) continue;
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
    if (attribution.consumer === RPC_USAGE_UNATTRIBUTED_CONSUMER) continue;
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
  if (normalized.length > 64) return 'other';
  return normalized;
}

/** Run a provider read under a bounded diagnostic consumer label. */
export function withRpcUsageConsumer<T>(consumer: string, fn: () => T): T {
  const normalized = normalizeRpcUsageConsumer(consumer);
  if (!normalized) return fn();
  return rpcUsageConsumerContext.run(normalized, fn);
}

/** Current diagnostic consumer label, if a caller established one. */
export function activeRpcUsageConsumer(): string | undefined {
  return rpcUsageConsumerContext.getStore();
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
  /** `${method}\0${consumer}` -> count, for every method except eth_getLogs. */
  private methodConsumers = new Map<string, number>();
  private ethGetLogsAttributions = new Map<
    string,
    { consumer: string; endpointSlot: RpcEndpointSlotLabel; count: number }
  >();
  private lifetime = 0;
  constructor(
    // Live thunk (matches RpcFailoverClient): the adapter assigns `chainId`
    // after construction, so resolve it at record time.
    private readonly chainId: () => string,
  ) {}

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

  record(method: string, endpointSlot?: number): void {
    // Authoritative window/lifetime state first, OUTSIDE any try — pure map
    // arithmetic that cannot realistically throw, and it must never be
    // skipped because an OPTIONAL sink misbehaved.
    const raw = typeof method === 'string' && method.length > 0 && method.length <= 128 ? method : 'other';
    const key = this.window.has(raw) || this.window.size < RpcUsageTracker.MAX_WINDOW_METHODS ? raw : 'other';
    this.window.set(key, (this.window.get(key) ?? 0) + 1);
    if (raw !== 'eth_getLogs') {
      // Every non-log method is attributed, and an unlabelled call is recorded
      // as such rather than dropped. Before this, only eth_call carried a
      // consumer and an unlabelled eth_call vanished from the by-consumer
      // view - which is how the whole block/transaction tier (~20% of a
      // publish burst) became invisible to attribution.
      const consumer = activeRpcUsageConsumer() ?? RPC_USAGE_UNATTRIBUTED_CONSUMER;
      const rawKey = `${key}\0${consumer}`;
      const pairKey = this.methodConsumers.has(rawKey)
        || this.methodConsumers.size < RpcUsageTracker.MAX_WINDOW_CONSUMERS
        ? rawKey
        : `${key}\0other`;
      this.methodConsumers.set(pairKey, (this.methodConsumers.get(pairKey) ?? 0) + 1);
    }
    if (raw === 'eth_getLogs') {
      const consumer = activeRpcUsageConsumer() ?? RPC_USAGE_UNATTRIBUTED_CONSUMER;
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
    const methodAttributions: RpcUsageAttribution[] = [];
    for (const [pairKey, count] of this.methodConsumers) {
      const separator = pairKey.indexOf('\0');
      const method = pairKey.slice(0, separator);
      const consumer = pairKey.slice(separator + 1);
      methodAttributions.push({ method, consumer, count });
      // The legacy eth_call projection keeps its meaning: labelled consumers only.
      if (method === 'eth_call' && consumer !== RPC_USAGE_UNATTRIBUTED_CONSUMER) {
        ethCallByConsumer[consumer] = count;
      }
    }
    this.methodConsumers.clear();
    const attributions: RpcUsageAttribution[] = [
      ...methodAttributions,
      ...[...this.ethGetLogsAttributions.values()].map(
        ({ consumer, endpointSlot, count }): RpcUsageAttribution => ({
          method: 'eth_getLogs',
          consumer,
          endpointSlot: normalizeRpcEndpointSlotLabel(endpointSlot),
          count,
        }),
      ),
    ];
    this.ethGetLogsAttributions.clear();
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

export function createRpcUsageRecorder(chainId: () => string): RpcUsageRecorder {
  const tracker = new RpcUsageTracker(chainId);
  return Object.freeze({
    record: (method: string, endpointSlot?: number) => tracker.record(method, endpointSlot),
    drainRpcUsage: () => tracker.drainWindow(),
  });
}

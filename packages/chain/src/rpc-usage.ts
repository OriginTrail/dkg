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
import { JsonRpcProvider } from 'ethers';
import type {
  FetchRequest,
  Networkish,
  JsonRpcApiProviderOptions,
  JsonRpcPayload,
  JsonRpcResult,
} from 'ethers';
import { getMetrics } from '@origintrail-official/dkg-core';
import { boundedRetryFetchRequest } from './evm-adapter-rpc.js';

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

/**
 * Extract the JSON-RPC method name(s) from an encoded request body (single
 * payload or batch). Usage-accounting policy owned HERE, not by the transport
 * retry code — the retry hook just forwards the body. Best-effort: anything
 * unparseable yields ['other'] so a retry attempt is never lost from the count.
 */
export function jsonRpcMethodsFromBody(body: Uint8Array | null | undefined): string[] {
  try {
    if (!body || body.length === 0) return ['other'];
    const parsed = JSON.parse(new TextDecoder().decode(body));
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const methods = entries.map((e: { method?: unknown }) => String(e?.method ?? 'other'));
    return methods.length > 0 ? methods : ['other'];
  } catch {
    return ['other'];
  }
}

/** A fresh all-zero window — the identity element for merging and the value of "nothing to report". */
export function emptyRpcUsageWindow(): NormalizedRpcUsageWindow {
  return { byMethod: {}, ethCallByConsumer: {}, lifetimeTotal: 0 };
}

/** Normalize a public drain-window input into the concrete telemetry model. */
export function normalizeRpcUsageWindow(window: RpcUsageWindow): NormalizedRpcUsageWindow {
  return {
    byMethod: window.byMethod,
    ethCallByConsumer: window.ethCallByConsumer ?? {},
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
  const ethCallByConsumer: Record<string, number> = {};
  let lifetimeTotal = 0;
  for (const input of defined) {
    const w = normalizeRpcUsageWindow(input);
    for (const [m, c] of Object.entries(w.byMethod)) byMethod[m] = (byMethod[m] ?? 0) + c;
    for (const [consumer, c] of Object.entries(w.ethCallByConsumer)) {
      ethCallByConsumer[consumer] = (ethCallByConsumer[consumer] ?? 0) + c;
    }
    lifetimeTotal += w.lifetimeTotal;
  }
  return { byMethod, ethCallByConsumer, lifetimeTotal };
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
const rpcRequestAbortContext = new AsyncLocalStorage<AbortSignal>();

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

/** Bind one caller-owned cancellation signal to the raw ethers HTTP request. */
export function withRpcRequestAbortSignal<T>(signal: AbortSignal, fn: () => T): T {
  return rpcRequestAbortContext.run(signal, fn);
}

/** Current diagnostic consumer label, if a caller established one. */
function activeRpcUsageConsumer(): string | undefined {
  return rpcUsageConsumerContext.getStore();
}

function activeRpcRequestAbortSignal(): AbortSignal | undefined {
  return rpcRequestAbortContext.getStore();
}

function throwAbortReason(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'RPC request aborted');
  error.name = 'AbortError';
  throw error;
}

/**
 * In-process accumulator for raw JSON-RPC request counts. `record()` is on the
 * hot path of every RPC — it does one map increment and one counter add, never
 * throws, and never touches the network.
 */
export class RpcUsageTracker {
  private window = new Map<string, number>();
  private ethCallConsumers = new Map<string, number>();
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

  record(method: string): void {
    // Authoritative window/lifetime state first, OUTSIDE any try — pure map
    // arithmetic that cannot realistically throw, and it must never be
    // skipped because an OPTIONAL sink misbehaved.
    const raw = typeof method === 'string' && method.length > 0 && method.length <= 128 ? method : 'other';
    const key = this.window.has(raw) || this.window.size < RpcUsageTracker.MAX_WINDOW_METHODS ? raw : 'other';
    this.window.set(key, (this.window.get(key) ?? 0) + 1);
    if (raw === 'eth_call') {
      const normalizedConsumer = activeRpcUsageConsumer();
      if (normalizedConsumer) {
        const consumerKey = this.ethCallConsumers.has(normalizedConsumer) ||
          this.ethCallConsumers.size < RpcUsageTracker.MAX_WINDOW_CONSUMERS
          ? normalizedConsumer
          : 'other';
        this.ethCallConsumers.set(consumerKey, (this.ethCallConsumers.get(consumerKey) ?? 0) + 1);
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
  drainWindow(): NormalizedRpcUsageWindow {
    const byMethod: Record<string, number> = {};
    for (const [method, count] of this.window) byMethod[method] = count;
    this.window.clear();
    const ethCallByConsumer: Record<string, number> = {};
    for (const [consumer, count] of this.ethCallConsumers) ethCallByConsumer[consumer] = count;
    this.ethCallConsumers.clear();
    return { byMethod, ethCallByConsumer, lifetimeTotal: this.lifetime };
  }
}

/**
 * `JsonRpcProvider` that reports every outgoing JSON-RPC request to the
 * tracker before delegating. The hook is `_send(payload)` — the ACTUAL wire
 * dispatch in ethers v6 — not the higher-level `send()`, because ethers'
 * network detection (`_detectNetwork` → eth_chainId) deliberately bypasses
 * `send()` and would otherwise go uncounted. `_send` sees exactly what leaves
 * the process: every payload entry is one billable JSON-RPC request (and with
 * the adapter's `batchMaxCount: 1` a batch is a single-entry array anyway).
 */
export class CountingJsonRpcProvider extends JsonRpcProvider {
  constructor(
    url: string | FetchRequest,
    network: Networkish | undefined,
    options: JsonRpcApiProviderOptions | undefined,
    private readonly onRpcRequest: (method: string) => void,
  ) {
    super(url, network, options);
  }

  override async _send(
    payload: JsonRpcPayload | Array<JsonRpcPayload>,
  ): Promise<Array<JsonRpcResult>> {
    try {
      const entries = Array.isArray(payload) ? payload : [payload];
      for (const entry of entries) this.onRpcRequest(String(entry?.method ?? 'unknown'));
    } catch {
      /* accounting must never break an RPC call */
    }
    const signal = activeRpcRequestAbortSignal();
    if (!signal) return super._send(payload);
    if (signal.aborted) throwAbortReason(signal);

    // JsonRpcProvider._send creates one FetchRequest per dispatch. Reproduce
    // that small transport boundary here so caller abort can cancel the actual
    // request, instead of merely abandoning its promise while it keeps using an
    // RPC connection in the background.
    const request = this._getConnection();
    request.body = JSON.stringify(payload);
    request.setHeader('content-type', 'application/json');
    const pending = request.send();
    const onAbort = () => {
      try {
        request.cancel();
      } catch {
        // A response can settle concurrently with abort; its completed request
        // no longer needs cancellation.
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const response = await pending;
      response.assertOk();
      const body = response.bodyJson;
      return Array.isArray(body) ? body : [body];
    } catch (error) {
      if (signal.aborted) throwAbortReason(signal);
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * The ONE transport factory for a usage-counted provider: wires BOTH accounting
 * hooks (the `_send` first-attempt count and the FetchRequest retry-attempt
 * count) to the same tracker, so a construction site can never pair them
 * inconsistently — the pairing IS the billing-exactness invariant (first
 * attempt via `_send` + every ethers-internal retry attempt via the retry
 * hook). Keeps the adapter constructor free of accounting mechanics.
 */
export function createCountingJsonRpcProvider(
  url: string,
  maxRetries: number | undefined,
  tracker: RpcUsageTracker,
  options: JsonRpcApiProviderOptions,
  network?: Networkish,
): CountingJsonRpcProvider {
  // boundedRetryFetchRequest stays PURE retry policy; the accounting
  // composition lives HERE, with the rest of the accounting. Ethers' throttle
  // retries happen BELOW JsonRpcProvider._send (one dispatch can issue 1 + N
  // HTTP attempts under 429/5xx) and every attempt bills at the provider, so
  // the retryFunc is decorated to record each RE-attempt's methods; the first
  // attempt is counted at _send by CountingJsonRpcProvider.
  const fetchRequest = boundedRetryFetchRequest(url, maxRetries);
  const pureRetry = fetchRequest.retryFunc!;
  fetchRequest.retryFunc = async (attemptReq, response, attempt) => {
    const retry = await pureRetry(attemptReq, response, attempt);
    if (retry) {
      try {
        for (const method of jsonRpcMethodsFromBody(attemptReq?.body)) tracker.record(method);
      } catch { /* accounting must never break the retry path */ }
    }
    return retry;
  };
  const providerOptions = network == null
    ? options
    : {
        ...options,
        // `network` is supplied from static node config. Passing it here tells
        // ethers not to re-detect the same chain with eth_chainId on every
        // internal network check, while malformed/absent config keeps the old
        // dynamic detection behavior.
        staticNetwork: network as JsonRpcApiProviderOptions['staticNetwork'],
      };
  return new CountingJsonRpcProvider(
    fetchRequest,
    network,
    providerOptions,
    (method) => tracker.record(method),
  );
}

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

/**
 * THE drain contract — one name for one concept, wherever a usage window can
 * be drained from: a chain adapter (optional capability), an agent (delegates
 * to its adapter), a publisher runtime (merges its per-wallet adapters), or
 * the daemon's composite source. Deltas since the previous drain.
 */
export interface RpcUsageDrainable {
  drainRpcUsage(): RpcUsageWindow | undefined;
}

/**
 * Merge usage windows from multiple trackers into one (pure model operation:
 * per-method sums, summed totals, summed lifetimes). A process can own several
 * chain adapters with independent trackers — one per configured RPC consumer
 * (e.g. the agent's adapter plus one per publisher wallet); billing-exact
 * accounting is the SUM across all of them. Returns undefined when no input
 * window is defined (no capability anywhere).
 */
export function mergeRpcUsageWindows(
  ...windows: Array<RpcUsageWindow | undefined>
): RpcUsageWindow | undefined {
  const defined = windows.filter((w): w is RpcUsageWindow => w !== undefined);
  if (defined.length === 0) return undefined;
  const byMethod: Record<string, number> = {};
  let total = 0;
  let lifetimeTotal = 0;
  for (const w of defined) {
    for (const [m, c] of Object.entries(w.byMethod)) byMethod[m] = (byMethod[m] ?? 0) + c;
    total += w.total;
    lifetimeTotal += w.lifetimeTotal;
  }
  return { byMethod, total, lifetimeTotal };
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
  /** Sum of byMethod — raw requests since the previous drain. */
  total: number;
  /** Raw requests since process start (monotonic; NOT reset by drain). */
  lifetimeTotal: number;
}

/**
 * In-process accumulator for raw JSON-RPC request counts. `record()` is on the
 * hot path of every RPC — it does one map increment and one counter add, never
 * throws, and never touches the network.
 */
export class RpcUsageTracker {
  private window = new Map<string, number>();
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

  record(method: string): void {
    // Authoritative window/lifetime state first, OUTSIDE any try — pure map
    // arithmetic that cannot realistically throw, and it must never be
    // skipped because an OPTIONAL sink misbehaved.
    const raw = typeof method === 'string' && method.length > 0 && method.length <= 128 ? method : 'other';
    const key = this.window.has(raw) || this.window.size < RpcUsageTracker.MAX_WINDOW_METHODS ? raw : 'other';
    this.window.set(key, (this.window.get(key) ?? 0) + 1);
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
  drainWindow(): RpcUsageWindow {
    const byMethod: Record<string, number> = {};
    let total = 0;
    for (const [method, count] of this.window) {
      byMethod[method] = count;
      total += count;
    }
    this.window.clear();
    return { byMethod, total, lifetimeTotal: this.lifetime };
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

  override _send(payload: JsonRpcPayload | Array<JsonRpcPayload>): Promise<Array<JsonRpcResult>> {
    try {
      const entries = Array.isArray(payload) ? payload : [payload];
      for (const entry of entries) this.onRpcRequest(String(entry?.method ?? 'unknown'));
    } catch {
      /* accounting must never break an RPC call */
    }
    return super._send(payload);
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
  return new CountingJsonRpcProvider(fetchRequest, undefined, options, (method) => tracker.record(method));
}

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

/** Sanitize a method name for the rpc_usage LOG line (logfmt token safety). */
function safeLogMethod(method: string): string {
  return /^[A-Za-z0-9_]{1,64}$/.test(method) ? method : 'other';
}

export interface RpcUsageWindow {
  /** Raw requests since the previous drain, by (sanitized) method name. */
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

  /** Count one raw JSON-RPC request. Called from the provider's send(). */
  record(method: string): void {
    try {
      const key = safeLogMethod(method);
      this.window.set(key, (this.window.get(key) ?? 0) + 1);
      this.lifetime += 1;
      getMetrics().chainRpcRequestsTotal.add(1, {
        rpc_method: boundedRpcMethodLabel(method),
        chain_id: this.chainId(),
      });
    } catch {
      /* accounting must never break an RPC call */
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

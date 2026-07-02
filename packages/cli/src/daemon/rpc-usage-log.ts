/**
 * Formats the minutely `rpc_usage` telemetry log lines — the "RPC credit burn"
 * signal (incident: a node spent ~$200 of RPC credits in a day with nothing
 * measuring it). The chain adapter counts every RAW JSON-RPC request at the
 * transport choke-point (the provider-billing unit); the daemon drains that
 * window every minute and emits ONE logfmt line PER METHOD through the normal
 * Logger → redacted-OTLP → Alloy → Loki path, so Grafana can chart RPC usage
 * per node and per method with EXACT sums (each line carries the DELTA for its
 * window, so `sum_over_time` over any range is the true request count).
 *
 * Line shape (logfmt, parsed in LogQL via `| json | line_format "{{.body}}" | logfmt`):
 *   rpc_usage method=eth_call count=42 window_s=60 chain=base:8453
 *
 * Extracted from lifecycle.ts so the format contract the Grafana dashboards
 * depend on is unit-testable.
 */

import type { RpcUsageWindow } from '@origintrail-official/dkg-chain';

/** @deprecated alias kept for import stability — the ONE typed contract is chain's RpcUsageWindow. */
export type RpcUsageWindowLike = RpcUsageWindow;

/** logfmt-token safety: methods/chain ids are self-generated, but never emit a token that could break parsing. */
function safeToken(value: string, fallback: string): string {
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : fallback;
}

/**
 * One logfmt line per method with a nonzero count in the window. Returns [] when
 * the window is empty (the caller skips logging entirely — an idle node emits
 * nothing rather than a stream of zeros).
 */
export function formatRpcUsageLines(
  usage: RpcUsageWindowLike,
  windowSeconds: number,
  chainId?: string,
): string[] {
  if (!usage || usage.total <= 0) return [];
  const chain = chainId ? ` chain=${safeToken(chainId, 'unknown')}` : '';
  const lines: string[] = [];
  for (const [method, count] of Object.entries(usage.byMethod)) {
    if (!Number.isFinite(count) || count <= 0) continue;
    lines.push(`rpc_usage method=${safeToken(method, 'other')} count=${Math.floor(count)} window_s=${windowSeconds}${chain}`);
  }
  return lines;
}

/** The drain capability the daemon consumes (DKGAgent.drainChainRpcUsage). */
export interface RpcUsageSource {
  drainChainRpcUsage?: () => RpcUsageWindowLike | undefined;
}

/**
 * Drain the source's RPC-usage window and emit one `rpc_usage` line per method
 * through `emit`. The COMPLETE daemon emission step (drain → format → emit),
 * extracted so the lifecycle timer AND the shutdown final-drain share one
 * unit-tested implementation. Returns the number of lines emitted (0 for a
 * missing capability or an empty window). Never throws.
 */
export function emitRpcUsage(
  source: RpcUsageSource | undefined,
  emit: (line: string) => void,
  windowSeconds: number,
  chainId?: string,
): number {
  try {
    const usage = source?.drainChainRpcUsage?.();
    if (!usage || usage.total <= 0) return 0;
    const lines = formatRpcUsageLines(usage, windowSeconds, chainId);
    for (const line of lines) emit(line);
    return lines.length;
  } catch {
    return 0; // usage accounting must never break the node
  }
}

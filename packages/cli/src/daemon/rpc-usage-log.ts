/**
 * Formats + schedules the minutely `rpc_usage` telemetry log lines. Invariants
 * here: one logfmt line per method, DELTA counts (so `sum_over_time` over any
 * range is the true request count), logfmt-token safety, idle windows emit
 * nothing. WHY the accounting exists and how it counts lives in ONE place:
 * packages/chain/src/rpc-usage.ts (module overview).
 *
 * Line shape (parsed in LogQL with `| logfmt` on the log body):
 *   rpc_usage method=eth_call count=42 window_s=60 chain=base:8453
 *
 * Companion diagnostic line shape for `eth_call` attribution:
 *   rpc_usage_by_consumer method=eth_call consumer=pcaNFT.getAccountInfo count=7 window_s=60 chain=base:8453
 *
 * `eth_getLogs` additionally identifies the non-secret configured endpoint slot:
 *   rpc_usage_by_consumer method=eth_getLogs consumer=getContextGraphAuthoritySnapshot endpoint_slot=fallback_1 count=7 window_s=60 chain=base:8453
 *
 * The shared transport budget emits one state + delta line per window:
 *   rpc_request_governor max_rps=10 background_max_rps=2 foreground_queued=0 background_queued=4 ...
 */

import {
  normalizeRpcEndpointSlotLabel,
  normalizeRpcUsageWindow,
  rpcUsageWindowTotal,
  type RpcUsageDrainable,
  type RpcUsageWindow,
} from '@origintrail-official/dkg-chain';

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
  usage: RpcUsageWindow,
  windowSeconds: number,
  chainId?: string,
): string[] {
  if (!usage) return [];
  const normalized = normalizeRpcUsageWindow(usage);
  if (rpcUsageWindowTotal(normalized) <= 0 && normalized.requestGovernor === undefined) return [];
  const chain = chainId ? ` chain=${safeToken(chainId, 'unknown')}` : '';
  const lines: string[] = [];
  for (const [method, count] of Object.entries(normalized.byMethod)) {
    if (!Number.isFinite(count) || count <= 0) continue;
    lines.push(`rpc_usage method=${safeToken(method, 'other')} count=${Math.floor(count)} window_s=${windowSeconds}${chain}`);
  }
  const attributionLines = new Map<string, {
    method: 'eth_call' | 'eth_getLogs';
    consumer: string;
    endpointSlot?: string;
    count: number;
  }>();
  for (const attribution of normalized.attributions) {
    if (!Number.isFinite(attribution.count) || attribution.count <= 0) continue;
    const consumer = safeToken(attribution.consumer, 'other');
    const endpointSlot = attribution.method === 'eth_getLogs'
      ? normalizeRpcEndpointSlotLabel(attribution.endpointSlot)
      : undefined;
    const key = `${attribution.method}\0${consumer}\0${endpointSlot ?? ''}`;
    const existing = attributionLines.get(key);
    if (existing) existing.count += Math.floor(attribution.count);
    else {
      attributionLines.set(key, {
        method: attribution.method,
        consumer,
        ...(endpointSlot ? { endpointSlot } : {}),
        count: Math.floor(attribution.count),
      });
    }
  }
  for (const { method, consumer, endpointSlot, count } of attributionLines.values()) {
    lines.push(
      `rpc_usage_by_consumer method=${method} consumer=${consumer} ` +
      `${endpointSlot ? `endpoint_slot=${endpointSlot} ` : ''}` +
      `count=${count} window_s=${windowSeconds}${chain}`,
    );
  }
  const governor = normalized.requestGovernor;
  if (governor !== undefined) {
    const decimal = (value: number) => Number.isFinite(value)
      ? Math.max(0, value).toFixed(3).replace(/\.?0+$/u, '')
      : '0';
    const integer = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    lines.push(
      `rpc_request_governor max_rps=${decimal(governor.maxRequestsPerSecond)} `
      + `background_max_rps=${decimal(governor.backgroundMaxRequestsPerSecond)} `
      + `available=${decimal(governor.availableTokens)} `
      + `background_available=${decimal(governor.backgroundAvailableTokens)} `
      + `foreground_queued=${integer(governor.foregroundQueued)} `
      + `background_queued=${integer(governor.backgroundQueued)} `
      + `foreground_admitted=${integer(governor.foregroundAdmitted)} `
      + `background_admitted=${integer(governor.backgroundAdmitted)} `
      + `foreground_deferred=${integer(governor.foregroundDeferred)} `
      + `background_deferred=${integer(governor.backgroundDeferred)} `
      + `rejected=${integer(governor.rejected)} `
      + `cancelled=${integer(governor.cancelled)} `
      + `startup_delay_ms=${integer(governor.startupDelayRemainingMs)} `
      + `window_s=${windowSeconds}${chain}`,
    );
  }
  return lines;
}

/** What the daemon drains: anything (partially) implementing the shared contract. */
export type RpcUsageSource = Partial<RpcUsageDrainable>;

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
    const usage = source?.drainRpcUsage?.();
    if (!usage) return 0;
    const lines = formatRpcUsageLines(usage, windowSeconds, chainId);
    for (const line of lines) emit(line);
    return lines.length;
  } catch {
    return 0; // usage accounting must never break the node
  }
}

/** Handle returned by {@link startRpcUsageTelemetry}. */
export interface RpcUsageTelemetryHandle {
  /**
   * Clear the timer and perform ONE final best-effort drain+emit, so a partial
   * window (e.g. a publish burst right before a restart) still reaches the log
   * pipeline instead of dying in memory. Idempotent-safe to call once at
   * daemon teardown, BEFORE telemetry shuts down.
   */
  stop(): void;
}

/**
 * The COMPLETE RPC-usage telemetry lifecycle: schedules the minutely
 * drain→format→emit tick (unref'd — never keeps the process alive) and owns
 * the shutdown final-drain. `runDaemonInner` just wires source/emit and calls
 * `stop()` at teardown — no feature scheduling embedded in the daemon monolith.
 */
export function startRpcUsageTelemetry(opts: {
  source: RpcUsageSource;
  emit: (line: string) => void;
  chainId?: string;
  /** Window length in seconds (default 60). */
  windowSeconds?: number;
}): RpcUsageTelemetryHandle {
  const windowSeconds = opts.windowSeconds ?? 60;
  const tick = () => emitRpcUsage(opts.source, opts.emit, windowSeconds, opts.chainId);
  const timer = setInterval(tick, windowSeconds * 1000);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      tick(); // final best-effort drain — emitRpcUsage never throws
    },
  };
}

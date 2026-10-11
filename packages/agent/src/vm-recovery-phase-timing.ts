// SPDX-License-Identifier: Apache-2.0
import {
  diffRpcRequestTiming,
  snapshotProcessRpcUsage,
  snapshotRpcRequestTiming,
  type RpcRequestTimingSnapshot,
  type RpcTimingDistribution,
} from '@origintrail-official/dkg-chain';

/**
 * Observation-only attribution of where one exact VM recovery pass spends wall
 * clock and background RPC capacity. Nothing here is consulted by a recovery
 * decision: measuring or formatting must never change an outcome, so every
 * entry point is total and swallows its own errors.
 *
 * Background-class attempt counts are process-wide. They attribute reliably
 * only while recovery is the node's main background RPC consumer, and they also
 * include any speculative preparation that runs inside the same interval.
 */
export const VM_RECOVERY_PHASES = [
  /** Curator roster and preferred-peer resolution. */
  'roster',
  /** Advertised-protocol checks of the connected providers for the stream wire. */
  'transport',
  /** Registered-public authority read that gates the stream wire. */
  'authority',
  /** Connect, sync-protocol readiness and network admission of the provider. */
  'peer-ready',
  /** Chain sizing hints for packing (live reads or consumed preparations). */
  'sizing',
  /** Network exchange plus verified materialization of the requested assets. */
  'exchange',
  /** Per-ordinal chain revalidation that follows the exchange. */
  'post-fetch',
] as const;

export type VmRecoveryPhase = typeof VM_RECOVERY_PHASES[number];

/** What one phase consumed since the recorder was last drained. */
export interface VmRecoveryPhaseUsage {
  readonly ms: number;
  /** Background-class physical attempts admitted during the phase. */
  readonly backgroundAttempts: number;
  /** Local governor wait those attempts accumulated. */
  readonly backgroundAdmissionWaitMs: number;
  /** Endpoint round-trip time those attempts accumulated. */
  readonly backgroundEndpointMs: number;
}

export type VmRecoveryPhaseTotals = Readonly<Record<VmRecoveryPhase, VmRecoveryPhaseUsage>>;

const EMPTY_USAGE: VmRecoveryPhaseUsage = Object.freeze({
  ms: 0,
  backgroundAttempts: 0,
  backgroundAdmissionWaitMs: 0,
  backgroundEndpointMs: 0,
});

function emptyTotals(): Record<VmRecoveryPhase, VmRecoveryPhaseUsage> {
  return Object.fromEntries(
    VM_RECOVERY_PHASES.map((phase) => [phase, EMPTY_USAGE]),
  ) as Record<VmRecoveryPhase, VmRecoveryPhaseUsage>;
}

export interface VmRecoveryTimingSources {
  readonly clock: () => number;
  readonly timing: () => RpcRequestTimingSnapshot;
  readonly usage: () => ReturnType<typeof snapshotProcessRpcUsage>;
}

const DEFAULT_SOURCES: VmRecoveryTimingSources = {
  clock: () => performance.now(),
  timing: () => snapshotRpcRequestTiming(),
  usage: () => snapshotProcessRpcUsage(),
};

function safeTiming(sources: VmRecoveryTimingSources): RpcRequestTimingSnapshot | undefined {
  try {
    return sources.timing();
  } catch {
    return undefined;
  }
}

/**
 * Accumulates monotonic wall clock and background RPC usage per phase, twice over: per batch
 * (drained by {@link VmRecoveryPhaseRecorder.take}) and for the whole pass (never drained).
 */
export class VmRecoveryPhaseRecorder {
  /** Since the last `take()`: one batch. */
  #totals = emptyTotals();
  /** Since this recorder was created: the whole pass. */
  #cumulative = emptyTotals();

  constructor(private readonly sources: VmRecoveryTimingSources = DEFAULT_SOURCES) {}

  /** Time `run`, charging the elapsed time and background usage to `phase`. */
  async measure<T>(phase: VmRecoveryPhase, run: () => Promise<T>): Promise<T> {
    const startedAt = this.sources.clock();
    const before = safeTiming(this.sources);
    try {
      return await run();
    } finally {
      this.#charge(phase, startedAt, before);
    }
  }

  /** Charge the interval since `startedAt` for code that cannot be wrapped as a closure. */
  chargeSince(phase: VmRecoveryPhase, startedAt: number, before?: RpcRequestTimingSnapshot): void {
    this.#charge(phase, startedAt, before);
  }

  /** Capture the start of a manually bracketed interval. */
  begin(): { readonly startedAt: number; readonly before: RpcRequestTimingSnapshot | undefined } {
    return { startedAt: this.sources.clock(), before: safeTiming(this.sources) };
  }

  /** Read and reset the totals accumulated since the previous call (one batch). */
  take(): VmRecoveryPhaseTotals {
    const taken = this.#totals;
    this.#totals = emptyTotals();
    return Object.freeze(taken);
  }

  /** The totals accumulated since this recorder was created (the whole pass); never reset. */
  cumulative(): VmRecoveryPhaseTotals {
    return Object.freeze({ ...this.#cumulative });
  }

  #charge(
    phase: VmRecoveryPhase,
    startedAt: number,
    before: RpcRequestTimingSnapshot | undefined,
  ): void {
    try {
      const elapsed = this.sources.clock() - startedAt;
      let attempts = 0;
      let waitMs = 0;
      let endpointMs = 0;
      const after = before === undefined ? undefined : safeTiming(this.sources);
      if (before !== undefined && after !== undefined) {
        const delta = diffRpcRequestTiming(before, after).background;
        attempts = delta.admissionWait.count;
        waitMs = delta.admissionWait.totalMs;
        endpointMs = delta.endpointLatency.totalMs;
      }
      const ms = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
      for (const totals of [this.#totals, this.#cumulative]) {
        const previous = totals[phase];
        totals[phase] = Object.freeze({
          ms: previous.ms + ms,
          backgroundAttempts: previous.backgroundAttempts + attempts,
          backgroundAdmissionWaitMs: previous.backgroundAdmissionWaitMs + waitMs,
          backgroundEndpointMs: previous.backgroundEndpointMs + endpointMs,
        });
      }
    } catch { /* observation only */ }
  }
}

/** Run an observation callback; a failure to observe never changes recovery. */
export function observeVmRecoveryTiming(callback: () => void): void {
  try {
    callback();
  } catch { /* observation only */ }
}

/** A point in the process-cumulative physical RPC counters. */
export interface VmRecoveryRpcMark {
  readonly methods: Readonly<Record<string, number>>;
  readonly consumers: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly timing: RpcRequestTimingSnapshot;
}

/** Capture the cumulative counters; `undefined` when they cannot be read. */
export function markVmRecoveryRpc(
  sources: VmRecoveryTimingSources = DEFAULT_SOURCES,
): VmRecoveryRpcMark | undefined {
  try {
    const usage = sources.usage();
    return {
      methods: usage.cumulative.methods,
      consumers: usage.cumulative.consumers,
      timing: sources.timing(),
    };
  } catch {
    return undefined;
  }
}

const TOP_CONSUMERS = 8;

function distributionSummary(prefix: string, distribution: RpcTimingDistribution): string {
  if (distribution.count <= 0) return `${prefix}Count=0`;
  const meanMs = distribution.totalMs / distribution.count;
  const slow = distribution.buckets.slice(3).reduce((sum: number, value: number) => sum + value, 0);
  return `${prefix}Count=${distribution.count} ${prefix}TotalMs=${Math.round(distribution.totalMs)} `
    + `${prefix}MeanMs=${Math.round(meanMs)} ${prefix}Over1sCount=${slow}`;
}

/**
 * One logfmt-style fragment describing the physical RPC work between `mark`
 * and now: totals by method, the most used bounded consumer labels, and the
 * split between local admission wait and endpoint latency for background
 * attempts. Secret-free by construction.
 */
export function describeVmRecoveryRpcSince(
  mark: VmRecoveryRpcMark | undefined,
  sources: VmRecoveryTimingSources = DEFAULT_SOURCES,
): string {
  if (mark === undefined) return 'rpcTotal=unknown';
  try {
    const now = markVmRecoveryRpc(sources);
    if (now === undefined) return 'rpcTotal=unknown';
    let total = 0;
    const byMethod: string[] = [];
    for (const [method, count] of Object.entries(now.methods)) {
      const delta = count - (mark.methods[method] ?? 0);
      if (delta > 0) {
        total += delta;
        byMethod.push(`${method}:${delta}`);
      }
    }
    const consumers: Array<[string, number]> = [];
    for (const [method, byConsumer] of Object.entries(now.consumers)) {
      for (const [consumer, count] of Object.entries(byConsumer)) {
        const delta = count - (mark.consumers[method]?.[consumer] ?? 0);
        if (delta > 0) consumers.push([`${method}/${consumer}`, delta]);
      }
    }
    consumers.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const timing = diffRpcRequestTiming(mark.timing, now.timing);
    return [
      `rpcTotal=${total}`,
      `rpcByMethod=${byMethod.sort().join(',') || '-'}`,
      `rpcTop=${consumers.slice(0, TOP_CONSUMERS).map(([name, count]) => `${name}:${count}`).join(',') || '-'}`,
      distributionSummary('bgAdmission', timing.background.admissionWait),
      distributionSummary('bgEndpoint', timing.background.endpointLatency),
      `bgEndpointFailures=${timing.background.endpointFailures}`,
      distributionSummary('fgEndpoint', timing.foreground.endpointLatency),
    ].join(' ');
  } catch {
    return 'rpcTotal=unknown';
  }
}

/** Render phase totals as `phase{Ms,BgReq,BgWaitMs,BgEndpointMs}` pairs in a stable order. */
export function formatVmRecoveryPhases(totals: VmRecoveryPhaseTotals): string {
  return VM_RECOVERY_PHASES.map((phase) => {
    const usage = totals[phase];
    const label = phase.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    return `${label}Ms=${Math.round(usage.ms)} ${label}BgReq=${usage.backgroundAttempts} `
      + `${label}BgWaitMs=${Math.round(usage.backgroundAdmissionWaitMs)}`;
  }).join(' ');
}

const MAX_TRACKED_GRAPHS = 256;
const passEndedAt = new WeakMap<object, Map<string, number>>();

/** Milliseconds since this owner's previous reconcile pass for the graph ended. */
export function vmReconcilePassGapMs(
  owner: object,
  localCgId: string,
  startedAt: number,
): number | undefined {
  try {
    const endedAt = passEndedAt.get(owner)?.get(localCgId);
    return endedAt === undefined ? undefined : Math.max(0, startedAt - endedAt);
  } catch {
    return undefined;
  }
}

/** Remember when a reconcile pass for the graph ended (bounded, observation only). */
export function noteVmReconcilePassEnd(owner: object, localCgId: string, endedAt: number): void {
  try {
    let byGraph = passEndedAt.get(owner);
    if (!byGraph) {
      byGraph = new Map();
      passEndedAt.set(owner, byGraph);
    }
    byGraph.delete(localCgId);
    byGraph.set(localCgId, endedAt);
    while (byGraph.size > MAX_TRACKED_GRAPHS) {
      const oldest = byGraph.keys().next().value;
      if (oldest === undefined) break;
      byGraph.delete(oldest);
    }
  } catch { /* observation only */ }
}

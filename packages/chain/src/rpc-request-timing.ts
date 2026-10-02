// SPDX-License-Identifier: Apache-2.0

/**
 * Process-cumulative timing of physical JSON-RPC attempts, split into the two
 * waits a caller can experience: time spent waiting for local governor
 * admission, and time the endpoint took to answer once the request was sent.
 *
 * The data is observation only. It is bounded (two request classes, fixed
 * histogram buckets), secret-free (no URL, method parameter or endpoint
 * identity) and never feeds back into admission, ordering, retry or
 * cancellation. Consumers take non-draining snapshots and diff them, exactly
 * like the cumulative usage snapshot in `rpc-usage.ts`.
 */

export type RpcTimingRequestClass = 'foreground' | 'background';

/** Upper bounds (ms, inclusive) of the fixed histogram; the last bucket is open. */
export const RPC_TIMING_BUCKET_UPPER_MS: readonly number[] = Object.freeze([
  10, 100, 1_000, 5_000, 20_000,
]);

const BUCKET_COUNT = RPC_TIMING_BUCKET_UPPER_MS.length + 1;

export interface RpcTimingDistribution {
  readonly count: number;
  readonly totalMs: number;
  /** Counts per bucket: `<=10`, `<=100`, `<=1000`, `<=5000`, `<=20000`, `>20000` ms. */
  readonly buckets: readonly number[];
}

export interface RpcRequestTimingClassSnapshot {
  /** Time from asking the governor for a permit until the permit was granted. */
  readonly admissionWait: RpcTimingDistribution;
  /** Time from sending the HTTP attempt until its response (or failure). */
  readonly endpointLatency: RpcTimingDistribution;
  readonly endpointFailures: number;
}

export interface RpcRequestTimingSnapshot {
  readonly schemaVersion: 1;
  readonly foreground: RpcRequestTimingClassSnapshot;
  readonly background: RpcRequestTimingClassSnapshot;
}

interface MutableDistribution {
  count: number;
  totalMs: number;
  buckets: number[];
}

interface MutableClassTiming {
  admissionWait: MutableDistribution;
  endpointLatency: MutableDistribution;
  endpointFailures: number;
}

function emptyDistribution(): MutableDistribution {
  return { count: 0, totalMs: 0, buckets: Array.from({ length: BUCKET_COUNT }, () => 0) };
}

function emptyClassTiming(): MutableClassTiming {
  return {
    admissionWait: emptyDistribution(),
    endpointLatency: emptyDistribution(),
    endpointFailures: 0,
  };
}

function bucketIndex(ms: number): number {
  for (let index = 0; index < RPC_TIMING_BUCKET_UPPER_MS.length; index += 1) {
    if (ms <= RPC_TIMING_BUCKET_UPPER_MS[index]!) return index;
  }
  return RPC_TIMING_BUCKET_UPPER_MS.length;
}

function observe(distribution: MutableDistribution, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  distribution.count += 1;
  distribution.totalMs += ms;
  distribution.buckets[bucketIndex(ms)]! += 1;
}

const processTiming: Record<RpcTimingRequestClass, MutableClassTiming> = {
  foreground: emptyClassTiming(),
  background: emptyClassTiming(),
};

function freezeDistribution(distribution: MutableDistribution): RpcTimingDistribution {
  return Object.freeze({
    count: distribution.count,
    totalMs: distribution.totalMs,
    buckets: Object.freeze([...distribution.buckets]),
  });
}

function freezeClass(timing: MutableClassTiming): RpcRequestTimingClassSnapshot {
  return Object.freeze({
    admissionWait: freezeDistribution(timing.admissionWait),
    endpointLatency: freezeDistribution(timing.endpointLatency),
    endpointFailures: timing.endpointFailures,
  });
}

/** Record how long one physical attempt waited for local governor admission. */
export function recordRpcAdmissionWait(
  requestClass: RpcTimingRequestClass,
  waitMs: number,
): void {
  observe(processTiming[requestClass].admissionWait, waitMs);
}

/** Record one physical attempt's endpoint round trip; `ok=false` marks a failed attempt. */
export function recordRpcEndpointLatency(
  requestClass: RpcTimingRequestClass,
  latencyMs: number,
  ok: boolean,
): void {
  const timing = processTiming[requestClass];
  observe(timing.endpointLatency, latencyMs);
  if (!ok) timing.endpointFailures += 1;
}

/** Non-draining snapshot of the process-cumulative timing; performs no I/O. */
export function snapshotRpcRequestTiming(): RpcRequestTimingSnapshot {
  return Object.freeze({
    schemaVersion: 1 as const,
    foreground: freezeClass(processTiming.foreground),
    background: freezeClass(processTiming.background),
  });
}

function diffDistribution(
  before: RpcTimingDistribution,
  after: RpcTimingDistribution,
): RpcTimingDistribution {
  return Object.freeze({
    count: after.count - before.count,
    totalMs: after.totalMs - before.totalMs,
    buckets: Object.freeze(after.buckets.map((value, index) => value - (before.buckets[index] ?? 0))),
  });
}

function diffClass(
  before: RpcRequestTimingClassSnapshot,
  after: RpcRequestTimingClassSnapshot,
): RpcRequestTimingClassSnapshot {
  return Object.freeze({
    admissionWait: diffDistribution(before.admissionWait, after.admissionWait),
    endpointLatency: diffDistribution(before.endpointLatency, after.endpointLatency),
    endpointFailures: after.endpointFailures - before.endpointFailures,
  });
}

/** Timing accumulated between two snapshots of the same process. */
export function diffRpcRequestTiming(
  before: RpcRequestTimingSnapshot,
  after: RpcRequestTimingSnapshot,
): RpcRequestTimingSnapshot {
  return Object.freeze({
    schemaVersion: 1 as const,
    foreground: diffClass(before.foreground, after.foreground),
    background: diffClass(before.background, after.background),
  });
}

/** Test-only: forget all accumulated timing. */
export function resetRpcRequestTimingForTests(): void {
  processTiming.foreground = emptyClassTiming();
  processTiming.background = emptyClassTiming();
}

import { memoryUsage } from 'node:process';
import { getHeapStatistics } from 'node:v8';
import { getMetrics } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

export type SyncMemoryPhase =
  | 'durable_data'
  | 'durable_meta'
  | 'shared_memory'
  | 'public_snapshot';

export type SyncMemoryBoundary =
  | 'requester_phase_start'
  | 'requester_phase_completed'
  | 'requester_phase_error'
  | 'responder_snapshot_before_load'
  | 'responder_snapshot_after_load';

export type SyncRequesterPhaseOutcome = 'completed' | 'timed_out' | 'error';

export interface RequesterPhaseTelemetry {
  recordPage(): void;
  recordQuads(quads: readonly Quad[]): void;
  finish(outcome: SyncRequesterPhaseOutcome, retainedQuads: number): void;
}

/**
 * Record process memory at a small, fixed set of sync lifecycle boundaries.
 * Both attributes are closed enums: never add peer, context-graph, session, or
 * operation identifiers here because they would create unbounded time series.
 */
export function recordSyncMemoryCheckpoint(
  phase: SyncMemoryPhase,
  boundary: SyncMemoryBoundary,
): void {
  const usage = memoryUsage();
  const heapLimit = getHeapStatistics().heap_size_limit;
  const attributes = { phase, boundary };
  const metrics = getMetrics();
  metrics.processHeapUsedBytes.record(usage.heapUsed, attributes);
  metrics.processHeapTotalBytes.record(usage.heapTotal, attributes);
  metrics.processHeapLimitBytes.record(heapLimit, attributes);
  metrics.processRssBytes.record(usage.rss, attributes);
  metrics.processExternalBytes.record(usage.external, attributes);
  metrics.processArrayBuffersBytes.record(usage.arrayBuffers, attributes);
}

export function requesterSyncMemoryPhase(
  includeSharedMemory: boolean,
  phase: 'catalog' | 'snapshot' | 'meta' | 'data',
): SyncMemoryPhase {
  if (phase === 'snapshot') return 'public_snapshot';
  if (includeSharedMemory) return 'shared_memory';
  return phase === 'meta' ? 'durable_meta' : 'durable_data';
}

/** Keeps requester instrumentation out of the pagination/session state machine. */
export function createRequesterPhaseTelemetry(params: {
  includeSharedMemory: boolean;
  phase: 'catalog' | 'snapshot' | 'meta' | 'data';
}): RequesterPhaseTelemetry {
  const telemetryPhase = requesterSyncMemoryPhase(params.includeSharedMemory, params.phase);
  const startedAt = Date.now();
  let pageCount = 0;
  let accumulatedBytesEstimate = 0;
  let finished = false;
  recordSyncMemoryCheckpoint(telemetryPhase, 'requester_phase_start');

  return {
    recordPage() {
      pageCount += 1;
    },
    recordQuads(quads) {
      for (const quad of quads) accumulatedBytesEstimate += estimateQuadHeapBytes(quad);
    },
    finish(outcome, retainedQuads) {
      if (finished) return;
      finished = true;
      const attributes = { phase: telemetryPhase, outcome };
      const metrics = getMetrics();
      metrics.syncRequesterAccumulatedQuads.record(retainedQuads, attributes);
      metrics.syncRequesterAccumulatedBytes.record(accumulatedBytesEstimate, attributes);
      metrics.syncRequesterPageCount.record(pageCount, attributes);
      metrics.syncRequesterPhaseDurationMs.record(Date.now() - startedAt, attributes);
      recordSyncMemoryCheckpoint(
        telemetryPhase,
        outcome === 'error' ? 'requester_phase_error' : 'requester_phase_completed',
      );
    },
  };
}

// Approximate retained V8 heap: four flat strings plus the row object and array
// slot. Production RDF terms are overwhelmingly Latin-1/ASCII, which V8 keeps
// as one-byte strings. The fixed overhead remains deliberately conservative;
// charging two bytes per code unit made the hard cap fire ~1.7x too early for
// measured DKG rows and rendered the documented row cap unreachable.
const ROW_OBJECT_OVERHEAD_BYTES = 160;

export function estimateStringRowHeapBytes(
  subject: string,
  predicate: string,
  object: string,
  graph: string,
): number {
  return ROW_OBJECT_OVERHEAD_BYTES + (
    subject.length + predicate.length + object.length + graph.length
  );
}

export function estimateQuadHeapBytes(quad: Quad): number {
  return estimateStringRowHeapBytes(quad.subject, quad.predicate, quad.object, quad.graph);
}

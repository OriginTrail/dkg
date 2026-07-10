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

// Approximate retained V8 heap: four string fields plus the row object and
// array slot. V8 layout varies by release, so this is an admission estimate,
// not an accounting claim. Counting UTF-16 code units is deliberately
// conservative for the common ASCII-heavy RDF representation.
const ROW_OBJECT_OVERHEAD_BYTES = 160;

export function estimateStringRowHeapBytes(
  subject: string,
  predicate: string,
  object: string,
  graph: string,
): number {
  return ROW_OBJECT_OVERHEAD_BYTES + 2 * (
    subject.length + predicate.length + object.length + graph.length
  );
}

export function estimateQuadHeapBytes(quad: Quad): number {
  return estimateStringRowHeapBytes(quad.subject, quad.predicate, quad.object, quad.graph);
}

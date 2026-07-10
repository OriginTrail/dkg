/**
 * Thin call-site facade over the OpenTelemetry API. Used by agent / publisher /
 * chain / sync code to open spans and read the active trace context WITHOUT
 * importing the SDK or having a tracer threaded through constructors.
 *
 * It talks only to the ambient `@opentelemetry/api`, which resolves whatever
 * provider is globally registered. When telemetry is disabled, NO provider is
 * registered and the API returns its built-in no-op tracer: `withSpan` runs the
 * body inside a non-recording span (zero cost, no export, no context switch).
 * So instrumentation stays compiled-in but inert — there is never an
 * `if (enabled)` guard at a call site.
 *
 * The SDK that makes these spans real is registered once at daemon boot by
 * `initTelemetry()` in @origintrail-official/dkg-node-ui.
 */

import {
  trace,
  context,
  metrics,
  SpanStatusCode,
  type Span,
  type Tracer,
  type Attributes,
  type SpanContext,
  type Counter,
  type Histogram,
  type UpDownCounter,
} from '@opentelemetry/api';

const TRACER_NAME = '@origintrail-official/dkg';
const METER_NAME = '@origintrail-official/dkg';
const INVALID_TRACE_ID = '00000000000000000000000000000000';

export function getTracer(version?: string): Tracer {
  return trace.getTracer(TRACER_NAME, version);
}

export interface WithSpanOpts {
  /** Initial span attributes (low-cardinality keys only; never secrets). */
  attributes?: Attributes;
  /** Span links — e.g. the parent context of detached/queued work. */
  links?: SpanContext[];
}

/**
 * Run `fn` inside an active span. Records the exception and sets ERROR status
 * if `fn` throws, and always ends the span. Returns whatever `fn` returns.
 * Because the SDK registers an AsyncLocalStorage context manager at boot, the
 * span is active across awaits inside `fn`, so nested `withSpan` calls and the
 * Logger pick up its context automatically.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  opts?: WithSpanOpts,
): Promise<T> {
  return getTracer().startActiveSpan(
    name,
    { attributes: opts?.attributes, links: opts?.links?.map((c) => ({ context: c })) },
    async (span: Span): Promise<T> => {
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Start a span linked to a (synchronously-captured) parent context. Use for
 * detached/queued work whose parent span is no longer the active context
 * (e.g. a Promise.race that settles after the caller has suspended).
 */
export async function linkedSpan<T>(
  name: string,
  parent: SpanContext | undefined,
  fn: (span: Span) => Promise<T> | T,
  attributes?: Attributes,
): Promise<T> {
  return withSpan(name, fn, { attributes, links: parent ? [parent] : undefined });
}

/**
 * The active span's trace/span id (hex) for log correlation. Returns empty
 * fields when no recording span is active (telemetry off, or outside any span)
 * so logging behaviour is unchanged in that case.
 */
export function currentTraceIds(): { traceId?: string; spanId?: string } {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const sc = span.spanContext();
  if (!sc || !sc.traceId || sc.traceId === INVALID_TRACE_ID) return {};
  return { traceId: sc.traceId, spanId: sc.spanId };
}

/** Synchronously capture the active span context (to link detached work later). */
export function activeSpanContext(): SpanContext | undefined {
  return trace.getSpan(context.active())?.spanContext();
}

// ───────────────────────── metrics ─────────────────────────
//
// Low-cardinality invocation metrics. Instruments are created lazily from the
// global meter, so they bind to the real MeterProvider once the SDK registers
// it at boot (and to the API no-op meter — inert — when telemetry is off).
// Attributes are supplied at record time; keep them to the bounded keys
// documented per metric (never peer_id / cg_id / tx_hash / op_id as labels).

/** Duration buckets (ms) for operation-level histograms. */
const OP_DURATION_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000];
/** Duration buckets (ms) for chain RPC histograms (faster floor). */
const RPC_DURATION_BUCKETS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 120000];

export interface DkgMetrics {
  /** bytes; boundary and phase are bounded sync lifecycle enums */
  processHeapUsedBytes: Histogram;
  /** bytes; boundary and phase are bounded sync lifecycle enums */
  processHeapTotalBytes: Histogram;
  /** bytes; boundary and phase are bounded sync lifecycle enums */
  processHeapLimitBytes: Histogram;
  /** bytes; boundary and phase are bounded sync lifecycle enums */
  processRssBytes: Histogram;
  /** bytes; boundary and phase are bounded sync lifecycle enums */
  processExternalBytes: Histogram;
  /** bytes; boundary and phase are bounded sync lifecycle enums */
  processArrayBuffersBytes: Histogram;
  /** outcome={tentative|confirmed|failed|error}, source={direct|swm}, chain_id
   *  (`error` = the publish flow threw before producing a status). */
  publishTotal: Counter;
  /** ms; outcome, source, chain_id */
  publishDuration: Histogram;
  /** outcome={reached|timeout|impossible}, chain_id */
  ackQuorumTotal: Counter;
  /** result={ack|decline|rejected|transport_error}, decline_code? (fixed enum)
   *  — `ack` = validated; `rejected` = signature/merkle/identity check failed;
   *  `decline` = peer declined; `transport_error` = send threw. */
  ackPeerTotal: Counter;
  /** result={valid|key-not-registered|not-in-sharding-table|rpc-error} */
  ackVerifyTotal: Counter;
  /** outcome={ack|decline|reset}, decline_code?, chain_id */
  ackHandlerTotal: Counter;
  /** reason={fixed enum/known label} */
  storageAckDeclinesTotal: Counter;
  /** ms; operation={query|insert|dropGraph|flush|...} */
  storageAckQueueWaitMs: Histogram;
  /** ms; operation, outcome={ok|error} */
  storageAckStoreOpDurationMs: Histogram;
  /** queue_depth sample for ACK-priority store work */
  storageAckPriorityQueueDepth: Histogram;
  /** inflight sample for ACK-priority store work */
  storageAckInflight: Histogram;
  /** queue_depth sample for background/normal store work competing with ACK */
  syncBackgroundQueueDepth: Histogram;
  /** process-local sync inflight sample */
  syncGlobalInflight: Histogram;
  /** currently retained responder snapshots; phase is a bounded enum */
  syncResponderSnapshots: UpDownCounter;
  /** currently retained responder snapshot rows; phase is a bounded enum */
  syncResponderSnapshotRows: UpDownCounter;
  /** estimated bytes retained by responder snapshots; phase is a bounded enum */
  syncResponderSnapshotBytesEstimate: UpDownCounter;
  /** phase, reason={lru|expired|limit_rejected} */
  syncResponderSnapshotEvictionsTotal: Counter;
  /** ms; phase, outcome={completed|error} */
  syncResponderSnapshotLoadDurationMs: Histogram;
  /** rows copied by avoidable whole-snapshot copies; phase is a bounded enum */
  syncResponderSnapshotCopyRowsTotal: Counter;
  /** quads retained at requester phase completion; phase and outcome are bounded enums */
  syncRequesterAccumulatedQuads: Histogram;
  /** estimated bytes retained at requester phase completion; phase and outcome are bounded enums */
  syncRequesterAccumulatedBytes: Histogram;
  /** response pages consumed by a requester phase; phase and outcome are bounded enums */
  syncRequesterPageCount: Histogram;
  /** ms; phase and outcome are bounded enums */
  syncRequesterPhaseDurationMs: Histogram;
  /** rpc_method, outcome={ok|error|timeout}, retryable, chain_id */
  chainRpcTotal: Counter;
  /** rpc_method (bounded known JSON-RPC set, else 'other'), chain_id — RAW
   *  transport-level JSON-RPC client requests, i.e. the PROVIDER-BILLING unit.
   *  Distinct from chainRpcTotal (logical chain operations): one logical op can
   *  issue several raw requests (populate = estimateGas + getTransactionCount
   *  + chainId + …), and raw request volume is what burns RPC credits. */
  chainRpcRequestsTotal: Counter;
  /** ms; rpc_method, chain_id */
  chainRpcDuration: Histogram;
  /** rpc_method, chain_id, reason={exhausted|recovered} */
  chainRpcFailoverTotal: Counter;
  /** outcome={ok|error}, protocol_id */
  syncRequestTotal: Counter;
  /** outcome={ok|busy|limit|error|invalid} — `invalid` = malformed request
   *  (e.g. missing contextGraphId) short-circuited before serving. */
  syncResponseTotal: Counter;
  /** outcome={ok|error}, protocol_id — outbound P2P protocol send */
  protocolSendTotal: Counter;
  /** ms; protocol_id — P2P protocol send duration */
  protocolSendDuration: Histogram;
  /** kind={oversize|vm-quarantine|store-reject} — synced quads refused for
   *  exceeding the RDF-literal size invariant (OT-RFC-56; poison visibility). */
  oversizeTombstonesTotal: Counter;
}

function buildMetrics(): DkgMetrics {
  const meter = metrics.getMeter(METER_NAME);
  return {
    processHeapUsedBytes: meter.createHistogram('process.heap_used_bytes', {
      unit: 'By', description: 'V8 heap bytes currently used at bounded sync lifecycle checkpoints',
    }),
    processHeapTotalBytes: meter.createHistogram('process.heap_total_bytes', {
      unit: 'By', description: 'V8 heap bytes currently allocated at bounded sync lifecycle checkpoints',
    }),
    processHeapLimitBytes: meter.createHistogram('process.heap_limit_bytes', {
      unit: 'By', description: 'V8 heap size limit at bounded sync lifecycle checkpoints',
    }),
    processRssBytes: meter.createHistogram('process.rss_bytes', {
      unit: 'By', description: 'Process resident set size at bounded sync lifecycle checkpoints',
    }),
    processExternalBytes: meter.createHistogram('process.external_bytes', {
      unit: 'By', description: 'V8 external memory at bounded sync lifecycle checkpoints',
    }),
    processArrayBuffersBytes: meter.createHistogram('process.array_buffers_bytes', {
      unit: 'By', description: 'V8 ArrayBuffer memory at bounded sync lifecycle checkpoints',
    }),
    publishTotal: meter.createCounter('dkg.publish.total', { description: 'Publish operations by outcome/source' }),
    publishDuration: meter.createHistogram('dkg.publish.duration', {
      unit: 'ms', description: 'Publish wall-time', advice: { explicitBucketBoundaries: OP_DURATION_BUCKETS },
    }),
    ackQuorumTotal: meter.createCounter('dkg.ack.quorum.total', { description: 'ACK quorum outcomes' }),
    ackPeerTotal: meter.createCounter('dkg.ack.peer.total', { description: 'Per-peer ACK request results' }),
    ackVerifyTotal: meter.createCounter('dkg.ack.verify.total', { description: 'ACK identity verification results' }),
    ackHandlerTotal: meter.createCounter('dkg.ack.handler.total', { description: 'Inbound storage-ACK handler outcomes' }),
    storageAckDeclinesTotal: meter.createCounter('dkg.storage_ack.declines_total', {
      description: 'Inbound StorageACK declines by bounded reason',
    }),
    storageAckQueueWaitMs: meter.createHistogram('dkg.storage_ack.queue_wait_ms', {
      unit: 'ms',
      description: 'StorageACK priority-store queue wait',
      advice: { explicitBucketBoundaries: OP_DURATION_BUCKETS },
    }),
    storageAckStoreOpDurationMs: meter.createHistogram('dkg.storage_ack.store_op_duration_ms', {
      unit: 'ms',
      description: 'StorageACK priority-store operation wall-time',
      advice: { explicitBucketBoundaries: OP_DURATION_BUCKETS },
    }),
    storageAckPriorityQueueDepth: meter.createHistogram('dkg.storage_ack.priority_queue_depth', {
      description: 'Sampled ACK-priority store queue depth',
    }),
    storageAckInflight: meter.createHistogram('dkg.storage_ack.inflight', {
      description: 'Sampled ACK-priority store inflight count',
    }),
    syncBackgroundQueueDepth: meter.createHistogram('dkg.sync.background_queue_depth', {
      description: 'Sampled non-ACK store queue depth',
    }),
    syncGlobalInflight: meter.createHistogram('dkg.sync.global_inflight', {
      description: 'Sampled process-local sync inflight count',
    }),
    syncResponderSnapshots: meter.createUpDownCounter('dkg.sync.responder.snapshots', {
      description: 'Currently retained sync responder snapshots',
    }),
    syncResponderSnapshotRows: meter.createUpDownCounter('dkg.sync.responder.snapshot_rows', {
      description: 'Currently retained rows in sync responder snapshots',
    }),
    syncResponderSnapshotBytesEstimate: meter.createUpDownCounter('dkg.sync.responder.snapshot_bytes_estimate', {
      unit: 'By', description: 'Estimated bytes retained by sync responder snapshots',
    }),
    syncResponderSnapshotEvictionsTotal: meter.createCounter('dkg.sync.responder.snapshot_evictions_total', {
      description: 'Sync responder snapshot removals caused by pressure, expiry, or admission limits',
    }),
    syncResponderSnapshotLoadDurationMs: meter.createHistogram('dkg.sync.responder.snapshot_load_duration_ms', {
      unit: 'ms',
      description: 'Sync responder full-snapshot materialization duration',
      advice: { explicitBucketBoundaries: OP_DURATION_BUCKETS },
    }),
    syncResponderSnapshotCopyRowsTotal: meter.createCounter('dkg.sync.responder.snapshot_copy_rows_total', {
      description: 'Rows copied by avoidable whole-snapshot copies while serving sync pages',
    }),
    syncRequesterAccumulatedQuads: meter.createHistogram('dkg.sync.requester.accumulated_quads', {
      description: 'Requester quads retained at sync phase completion',
    }),
    syncRequesterAccumulatedBytes: meter.createHistogram('dkg.sync.requester.accumulated_bytes', {
      unit: 'By', description: 'Estimated requester quad bytes retained at sync phase completion',
    }),
    syncRequesterPageCount: meter.createHistogram('dkg.sync.requester.page_count', {
      description: 'Pages consumed by a requester sync phase',
    }),
    syncRequesterPhaseDurationMs: meter.createHistogram('dkg.sync.requester.phase_duration_ms', {
      unit: 'ms',
      description: 'Requester sync phase wall-time',
      advice: { explicitBucketBoundaries: OP_DURATION_BUCKETS },
    }),
    chainRpcTotal: meter.createCounter('dkg.chain.rpc.total', { description: 'Chain RPC calls by method/outcome' }),
    chainRpcRequestsTotal: meter.createCounter('dkg.chain.rpc.requests.total', {
      description: 'Raw JSON-RPC client requests by method (provider billing unit)',
    }),
    chainRpcDuration: meter.createHistogram('dkg.chain.rpc.duration', {
      unit: 'ms', description: 'Chain RPC wall-time', advice: { explicitBucketBoundaries: RPC_DURATION_BUCKETS },
    }),
    chainRpcFailoverTotal: meter.createCounter('dkg.chain.rpc.failover.total', { description: 'Chain RPC endpoint failover events' }),
    syncRequestTotal: meter.createCounter('dkg.sync.request.total', { description: 'Outbound sync requests' }),
    syncResponseTotal: meter.createCounter('dkg.sync.response.total', { description: 'Inbound sync responses' }),
    protocolSendTotal: meter.createCounter('dkg.protocol_router.send.total', { description: 'Outbound P2P protocol sends' }),
    oversizeTombstonesTotal: meter.createCounter('dkg.sync.oversize_tombstones.total', {
      description: 'Synced quads refused for exceeding the RDF-literal size invariant (OT-RFC-56)',
    }),
    protocolSendDuration: meter.createHistogram('dkg.protocol_router.send.duration', {
      unit: 'ms', description: 'P2P protocol send wall-time', advice: { explicitBucketBoundaries: RPC_DURATION_BUCKETS },
    }),
  };
}

let metricsCache: DkgMetrics | undefined;

/** Lazily-bound metric instruments (call this at every record site). */
export function getMetrics(): DkgMetrics {
  if (!metricsCache) metricsCache = buildMetrics();
  return metricsCache;
}

/**
 * Rebuild instruments against the currently-registered global meter. Called by
 * `initTelemetry()` right after `metrics.setGlobalMeterProvider()` so the cache
 * (which may have been created against the no-op meter) binds to the real one.
 */
export function rebuildMetrics(): void {
  metricsCache = buildMetrics();
}

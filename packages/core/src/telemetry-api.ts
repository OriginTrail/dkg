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
  type Gauge,
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
/** Retained/process bytes from 1 MiB through 4 GiB. */
const BYTE_BUCKETS = [
  1024 * 1024,
  4 * 1024 * 1024,
  16 * 1024 * 1024,
  32 * 1024 * 1024,
  64 * 1024 * 1024,
  128 * 1024 * 1024,
  256 * 1024 * 1024,
  512 * 1024 * 1024,
  1024 * 1024 * 1024,
  2 * 1024 * 1024 * 1024,
  4 * 1024 * 1024 * 1024,
];
const QUAD_COUNT_BUCKETS = [100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];
const PAGE_COUNT_BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000];
/**
 * Duration buckets (ms) for a whole context-graph catch-up job, out to ~30 min.
 *
 * `OP_DURATION_BUCKETS` stops at 120 s, but observed foreground catch-up jobs ran
 * 305 s and 382 s — both would land in the `+Inf` overflow and become unresolvable.
 * Every measured job must fall in a *finite* bucket.
 */
const CATCHUP_DURATION_BUCKETS = [
  1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 240_000,
  300_000, 420_000, 600_000, 900_000, 1_800_000,
];
/**
 * Duration buckets (ms) for a single logical sync operation's *active* occupancy
 * (peer wait + decode + verification + store commit). Floor is finer than
 * `OP_DURATION_BUCKETS` because cheap cache-warm operations cluster below 50 ms.
 */
const SYNC_OPERATION_DURATION_BUCKETS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000,
  10_000, 30_000, 60_000, 120_000, 300_000,
];

export interface DkgMetrics {
  /** bytes; boundary and phase are bounded sync lifecycle enums */
  processHeapUsedBytes: Gauge;
  /** bytes; boundary and phase are bounded sync lifecycle enums */
  processHeapTotalBytes: Gauge;
  /** bytes; boundary and phase are bounded sync lifecycle enums */
  processHeapLimitBytes: Gauge;
  /** bytes; boundary and phase are bounded sync lifecycle enums */
  processRssBytes: Gauge;
  /** bytes; boundary and phase are bounded sync lifecycle enums */
  processExternalBytes: Gauge;
  /** bytes; boundary and phase are bounded sync lifecycle enums */
  processArrayBuffersBytes: Gauge;
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
  /** priority={ack|health|normal|background}, reason={queue_full|queue_wait_timeout} */
  storeSchedulerRejectionsTotal: Counter;
  /** ms; priority and operation identify the bounded admission lane and static caller */
  storeSchedulerQueueWaitMs: Histogram;
  /** active admitted operations by priority and operation */
  storeSchedulerActive: UpDownCounter;
  /** current queued work; scheduler and lane are bounded static labels */
  backpressureQueueDepth: Gauge;
  /**
   * depth the lane's pressure state was classified against — the numerator that
   * pairs with `backpressureQueueLimit`. Equals queue depth on a lane holding a
   * private allocation, and the pool's depth on a lane drawing from a shared
   * one; scheduler and lane are bounded static labels
   */
  backpressurePressureDepth: Gauge;
  /** configured queue capacity; scheduler and lane are bounded static labels */
  backpressureQueueLimit: Gauge;
  /** current admitted work; scheduler and lane are bounded static labels */
  backpressureInflight: Gauge;
  /** configured concurrent-work capacity; scheduler and lane are bounded static labels */
  backpressureInflightLimit: Gauge;
  /** age of the oldest queued item; scheduler and lane are bounded static labels */
  backpressureOldestQueuedAgeMs: Gauge;
  /** age of the oldest admitted item; scheduler and lane are bounded static labels */
  backpressureOldestActiveAgeMs: Gauge;
  /** scheduler, lane, event, and optional reason are bounded labels */
  backpressureEventsTotal: Counter;
  /** queue wait by bounded scheduler and lane */
  backpressureQueueWaitMs: Histogram;
  /** admitted-work duration by bounded scheduler, lane, and outcome */
  backpressureActiveDurationMs: Histogram;
  /** scope={finalization|reconcile} */
  storeScanSingleFlightJoinsTotal: Counter;
  /** active unique scans by scope */
  storeScanSingleFlightActive: UpDownCounter;
  /** bounded materialized result rows by static source */
  storeQueryResultRows: Histogram;
  /** conservative bounded materialized bytes by static source */
  storeQueryResultBytesEstimate: Histogram;
  /** operation and source are bounded adapter/static caller labels */
  storeCancellationCompletedTotal: Counter;
  /** scope and reason identify the bounded retry loop; attempt is capped */
  storeRetryAttemptsTotal: Counter;
  /** current durable finalization entries whose retry gate is open */
  finalizationRecoveryDueEntries: Gauge;
  /** milliseconds since the oldest currently due finalization was received */
  finalizationRecoveryOldestDueAgeMs: Gauge;
  /** outcome={recovered|invalidated|retry-pending|none} */
  finalizationRecoveryAttemptsTotal: Counter;
  /** process-local sync inflight sample */
  syncGlobalInflight: Histogram;
  /** ms; lane and priority_class are bounded sync scheduler enums */
  syncSchedulerQueueWaitMs: Histogram;
  /** lane, priority_class, outcome={started|rejected|displaced|aged|aborted} */
  syncSchedulerDecisionsTotal: Counter;
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

  // ── W1 sync measurement contract (I1–I9) ────────────────────────────────
  // Attributes are closed vocabularies clamped at the record site; an unknown
  // value becomes `unspecified` and never throws. No cg_id / peer_id, ever.

  /** I1 — one point per *physically invoked* send.
   *  transport={legacy|changelog}, plane={durable|shared-memory},
   *  phase={data|meta|snapshot|catalog|delta}, source=<admission source>,
   *  outcome={response|validation_rejected|cancelled|transport_error}.
   *  There is deliberately no `timeout`: no causal deadline predicate exists. */
  syncAttemptTotal: Counter;
  /** I2 — bytes; encoded application-protocol request payload at the router
   *  boundary (excludes libp2p framing). Recorded once, immediately before
   *  `send()`, so attempts that never receive a response still count.
   *  transport, plane, phase, source. */
  syncAttemptRequestBytes: Counter;
  /** I3 — bytes; encoded response payload. Exists only if `send()` resolved,
   *  including validation rejection. transport, plane, phase, source, outcome. */
  syncAttemptResponseBytes: Counter;
  /** I4 — ms; source-attributed *active* occupancy of one completed logical sync
   *  operation, excluding admission queue wait. Its `count` is the operation
   *  denominator. lane={durable|changelog|shared_memory|swm_recovery},
   *  source, outcome={resolved|error|cancelled}. */
  syncOperationDurationMs: Histogram;
  /** I5 — operations rejected *before starting*, so they are never a 0 ms I4
   *  sample. lane, source, reason={queue_full|displaced|aborted_before_start}. */
  syncOperationRejectedTotal: Counter;
  /** I6 — single-flight/coalescing joins, recorded at map-hit time (before any
   *  bytes move). scope={context-graph|durable|shared-memory|page},
   *  owner_source, joiner_source. A cross-*family* join invalidates the window. */
  syncSingleflightJoinsTotal: Counter;
  /** I7 — catch-up subscribe requests, one per route return.
   *  result={bad_request|forbidden|deduped|ready_replay|ready_synthetic|queued|
   *  shutting_down}, include_shared_memory. Requests ≠ jobs (N:1). */
  contextGraphCatchupRequestsTotal: Counter;
  /** I8 — exactly one point per unique jobId. status=<terminal CatchupJobState>,
   *  admission={walk|synthetic}. */
  contextGraphCatchupJobsTotal: Counter;
  /** I9 — ms; walk jobs only, monotonic clock. admission={walk}. */
  contextGraphCatchupJobDurationMs: Histogram;
}

function buildMetrics(): DkgMetrics {
  const meter = metrics.getMeter(METER_NAME);
  return {
    processHeapUsedBytes: meter.createGauge('process.heap_used_bytes', {
      unit: 'By', description: 'Current V8 heap bytes sampled at bounded sync lifecycle checkpoints',
    }),
    processHeapTotalBytes: meter.createGauge('process.heap_total_bytes', {
      unit: 'By', description: 'Current V8 allocated heap bytes sampled at bounded sync lifecycle checkpoints',
    }),
    processHeapLimitBytes: meter.createGauge('process.heap_limit_bytes', {
      unit: 'By', description: 'Current V8 heap size limit sampled at bounded sync lifecycle checkpoints',
    }),
    processRssBytes: meter.createGauge('process.rss_bytes', {
      unit: 'By', description: 'Current process resident set size sampled at bounded sync lifecycle checkpoints',
    }),
    processExternalBytes: meter.createGauge('process.external_bytes', {
      unit: 'By', description: 'Current V8 external memory sampled at bounded sync lifecycle checkpoints',
    }),
    processArrayBuffersBytes: meter.createGauge('process.array_buffers_bytes', {
      unit: 'By', description: 'Current V8 ArrayBuffer memory sampled at bounded sync lifecycle checkpoints',
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
    storeSchedulerRejectionsTotal: meter.createCounter('dkg.store.scheduler_rejections_total', {
      description: 'External-store work rejected before dispatch by bounded priority and reason',
    }),
    storeSchedulerQueueWaitMs: meter.createHistogram('dkg.store.scheduler_queue_wait_ms', {
      unit: 'ms',
      description: 'External-store admission queue wait by lane and static caller',
      advice: { explicitBucketBoundaries: OP_DURATION_BUCKETS },
    }),
    storeSchedulerActive: meter.createUpDownCounter('dkg.store.scheduler_active', {
      description: 'Currently admitted external-store operations by lane and static caller',
    }),
    backpressureQueueDepth: meter.createGauge('dkg.backpressure.queue_depth', {
      description: 'Current scheduler queue depth by bounded scheduler and lane',
    }),
    backpressurePressureDepth: meter.createGauge('dkg.backpressure.pressure_depth', {
      description:
        'Queue depth a lane\'s pressure state was classified against, by bounded scheduler and lane',
    }),
    backpressureQueueLimit: meter.createGauge('dkg.backpressure.queue_limit', {
      description: 'Configured scheduler queue capacity by bounded scheduler and lane',
    }),
    backpressureInflight: meter.createGauge('dkg.backpressure.inflight', {
      description: 'Current admitted scheduler work by bounded scheduler and lane',
    }),
    backpressureInflightLimit: meter.createGauge('dkg.backpressure.inflight_limit', {
      description: 'Configured scheduler concurrent-work capacity by bounded scheduler and lane',
    }),
    backpressureOldestQueuedAgeMs: meter.createGauge('dkg.backpressure.oldest_queued_age_ms', {
      unit: 'ms',
      description: 'Current age of the oldest queued scheduler item',
    }),
    backpressureOldestActiveAgeMs: meter.createGauge('dkg.backpressure.oldest_active_age_ms', {
      unit: 'ms',
      description: 'Current age of the oldest admitted scheduler item',
    }),
    backpressureEventsTotal: meter.createCounter('dkg.backpressure.events_total', {
      description: 'Scheduler lifecycle events and admission rejections',
    }),
    backpressureQueueWaitMs: meter.createHistogram('dkg.backpressure.queue_wait_ms', {
      unit: 'ms',
      description: 'Scheduler queue wait by bounded scheduler and lane',
      advice: { explicitBucketBoundaries: OP_DURATION_BUCKETS },
    }),
    backpressureActiveDurationMs: meter.createHistogram('dkg.backpressure.active_duration_ms', {
      unit: 'ms',
      description: 'Scheduler admitted-work duration by bounded scheduler, lane, and outcome',
      advice: { explicitBucketBoundaries: OP_DURATION_BUCKETS },
    }),
    storeScanSingleFlightJoinsTotal: meter.createCounter('dkg.store.scan_singleflight_joins_total', {
      description: 'Equivalent expensive scans joined to an already running promise',
    }),
    storeScanSingleFlightActive: meter.createUpDownCounter('dkg.store.scan_singleflight_active', {
      description: 'Currently running unique expensive scans',
    }),
    storeQueryResultRows: meter.createHistogram('dkg.store.query_result_rows', {
      description: 'Rows retained by bounded expensive store reads',
      advice: { explicitBucketBoundaries: QUAD_COUNT_BUCKETS },
    }),
    storeQueryResultBytesEstimate: meter.createHistogram('dkg.store.query_result_bytes_estimate', {
      unit: 'By',
      description: 'Estimated bytes retained by bounded expensive store reads',
      advice: { explicitBucketBoundaries: BYTE_BUCKETS },
    }),
    storeCancellationCompletedTotal: meter.createCounter('dkg.store.cancellation_completed_total', {
      description: 'Store attempts whose adapter cancellation completed before returning control',
    }),
    storeRetryAttemptsTotal: meter.createCounter('dkg.store.retry_attempts_total', {
      description: 'Bounded expensive-work retry attempts',
    }),
    finalizationRecoveryDueEntries: meter.createGauge(
      'dkg.finalization_recovery.due_entries',
      { description: 'Durable finalization inbox entries currently eligible for retry' },
    ),
    finalizationRecoveryOldestDueAgeMs: meter.createGauge(
      'dkg.finalization_recovery.oldest_due_age_ms',
      {
        unit: 'ms',
        description: 'Age of the oldest durable finalization inbox entry eligible for retry',
      },
    ),
    finalizationRecoveryAttemptsTotal: meter.createCounter(
      'dkg.finalization_recovery.attempts_total',
      { description: 'Autonomous finalization replay attempts by bounded outcome' },
    ),
    syncGlobalInflight: meter.createHistogram('dkg.sync.global_inflight', {
      description: 'Sampled process-local sync inflight count',
    }),
    syncSchedulerQueueWaitMs: meter.createHistogram('dkg.sync.scheduler.queue_wait_ms', {
      unit: 'ms',
      description: 'Process-local sync scheduler queue wait by bounded lane and priority class',
      advice: { explicitBucketBoundaries: OP_DURATION_BUCKETS },
    }),
    syncSchedulerDecisionsTotal: meter.createCounter('dkg.sync.scheduler.decisions_total', {
      description: 'Process-local sync scheduler outcomes by bounded lane and priority class',
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
    syncRequesterAccumulatedQuads: meter.createHistogram('dkg.sync.requester.accumulated_quads', {
      description: 'Requester quads retained at sync phase completion',
      advice: { explicitBucketBoundaries: QUAD_COUNT_BUCKETS },
    }),
    syncRequesterAccumulatedBytes: meter.createHistogram('dkg.sync.requester.accumulated_bytes', {
      unit: 'By', description: 'Estimated requester quad bytes retained at sync phase completion',
      advice: { explicitBucketBoundaries: BYTE_BUCKETS },
    }),
    syncRequesterPageCount: meter.createHistogram('dkg.sync.requester.page_count', {
      description: 'Pages consumed by a requester sync phase',
      advice: { explicitBucketBoundaries: PAGE_COUNT_BUCKETS },
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

    // ── W1 sync measurement contract (I1–I9) ──────────────────────────────
    syncAttemptTotal: meter.createCounter('dkg.sync.attempt.total', {
      description: 'Physically invoked sync sends by transport/plane/phase/source and terminal outcome',
    }),
    syncAttemptRequestBytes: meter.createCounter('dkg.sync.attempt.request_bytes', {
      unit: 'By',
      description: 'Encoded sync request payload bytes at the router boundary (excludes libp2p framing)',
    }),
    syncAttemptResponseBytes: meter.createCounter('dkg.sync.attempt.response_bytes', {
      unit: 'By',
      description: 'Encoded sync response payload bytes at the router boundary (excludes libp2p framing)',
    }),
    syncOperationDurationMs: meter.createHistogram('dkg.sync.operation.duration_ms', {
      unit: 'ms',
      description: 'Active occupancy of one completed logical sync operation, excluding admission queue wait',
      advice: { explicitBucketBoundaries: SYNC_OPERATION_DURATION_BUCKETS },
    }),
    syncOperationRejectedTotal: meter.createCounter('dkg.sync.operation.rejected_total', {
      description: 'Sync operations rejected before starting (never a 0 ms duration sample)',
    }),
    syncSingleflightJoinsTotal: meter.createCounter('dkg.sync.singleflight.joins_total', {
      description: 'Single-flight/coalescing joins by scope, owner source and joiner source',
    }),
    contextGraphCatchupRequestsTotal: meter.createCounter('dkg.context_graph.catchup.requests_total', {
      description: 'Catch-up subscribe requests by route result (N:1 with jobs)',
    }),
    contextGraphCatchupJobsTotal: meter.createCounter('dkg.context_graph.catchup.jobs_total', {
      description: 'Catch-up jobs by terminal status and admission path (exactly once per jobId)',
    }),
    contextGraphCatchupJobDurationMs: meter.createHistogram('dkg.context_graph.catchup.job_duration_ms', {
      unit: 'ms',
      description: 'Walk catch-up job wall-time, monotonic clock',
      advice: { explicitBucketBoundaries: CATCHUP_DURATION_BUCKETS },
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

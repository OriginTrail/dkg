// Shared LogQL query contract for DKG node logs — the ONE place that knows
// how DKG telemetry looks in Loki. Dashboards (lib/dashboards.mjs) and alerts
// (lib/alerts.mjs) compose these building blocks instead of carrying parallel
// raw query strings, so a telemetry-shape change (stream selector, severity
// metadata key, rpc_usage pipeline) is applied in one file and every surface
// regenerates consistently — it can no longer be applied halfway.
// (The PROMETHEUS node-identity contract lives in profile.mjs; this module
// owns the Loki side, whose labels are fixed by our own collector pipeline.)

/** Loki stream selector for DKG node logs, with optional extra matchers:
 *  dkgLogStream() -> {service_name="dkg-node"}
 *  dkgLogStream('deployment_environment=~"${env:regex}"') -> {service_name="dkg-node", deployment_environment=~"${env:regex}"} */
export const dkgLogStream = (extraMatchers = '') =>
  `{service_name="dkg-node"${extraMatchers ? `, ${extraMatchers}` : ''}}`;

/** Severity pipeline stage against Loki structured metadata (native-OTLP
 *  shape: `severity_text`, NOT a `level` label — Loki 3.x ingest). */
export const severityIs = (level) => ` | severity_text=\`${level}\``;
export const severityMatches = (regex) => ` | severity_text=~\`${regex}\``;

/** The rpc_usage extraction pipeline (post-#1409 node builds): pick the
 *  rpc_usage lines, parse logfmt, keep real methods, unwrap the count for
 *  range aggregation. Trailing/leading spaces are part of the contract —
 *  callers append the range selector directly: `...${RPC_USAGE_PIPELINE}[1h]`. */
export const RPC_USAGE_PIPELINE = ' |= `rpc_usage` | logfmt | method != `` | unwrap count ';

// Loki 3 internally splits long-lookback instant metric queries and can spend
// tens of seconds of aggregate queue time on this fixed-slot expansion even
// for a handful of records. The flamegraph is therefore an explicitly recent
// pressure snapshot. Selected-range history remains available in the range-
// query heatmaps below; do not replace this with Grafana's `$__range` without
// a measured query/transform redesign.
export const BACKPRESSURE_FLAME_LOOKBACK = '1h';

/**
 * Build a Loki expression for the peak sampled age of every bounded
 * backpressure operation in a phase. PR #2003 keeps at most eight operation
 * summaries per lane, so the query expands those fixed indexes and collapses
 * them back by source. `slot` prevents LogQL's `or` from dropping an operation
 * that moved between array positions during the fixed recent lookback.
 *
 * The returned value is an elapsed age in milliseconds from the diagnostic
 * sample. It is not CPU time, request count, or a completed-job duration.
 */
export const backpressurePeakAgeByOperation = (stream, phase) => {
  if (phase !== 'active' && phase !== 'queued') {
    throw new Error(`backpressure phase must be active or queued, got ${phase}`);
  }
  const field = phase === 'active' ? 'activeOperations' : 'queuedOperations';
  const entries = Array.from({ length: 8 }, (_, index) => `max_over_time(${stream}`
    + ' |= `[backpressure]`'
    + ' | regexp `\\[backpressure\\] (?P<payload>\\{.*\\})`'
    + ' | line_format `{{.payload}}`'
    + ` | json scheduler, lane, operation="${field}[${index}].operation", age="${field}[${index}].oldestAgeMs"`
    + ' | operation != ``'
    + ` | label_format phase=\`${phase}\`, slot=\`${index}\``
    + ` | unwrap age | __error__ = \`\` [${BACKPRESSURE_FLAME_LOOKBACK}])`);
  return `max by (scheduler, lane, phase, operation) (${entries.map((entry) => `(${entry})`).join(' or ')})`;
};

/**
 * Build a Loki range expression for the peak sampled scheduler/lane age in
 * each Grafana resolution bucket. The heatmap uses these time-series samples
 * to calculate its distribution client-side. `max_over_time` is deliberate:
 * backpressure records are sparse transition/summary/recovery samples, so the
 * most severe observed age in a bucket is the honest value to retain.
 *
 * The returned value is sampled elapsed age in milliseconds. It is not CPU
 * time, request share, or an exact completed-job duration.
 */
export const backpressurePeakAgeOverTime = (stream, phase) => {
  if (phase !== 'active' && phase !== 'queued') {
    throw new Error(`backpressure phase must be active or queued, got ${phase}`);
  }
  const field = phase === 'active' ? 'oldestActiveAgeMs' : 'oldestQueuedAgeMs';
  return `max by (scheduler, lane) (max_over_time(${stream}`
    + ' |= `[backpressure]`'
    + ' | regexp `\\[backpressure\\] (?P<payload>\\{.*\\})`'
    + ' | line_format `{{.payload}}`'
    + ` | json scheduler, lane, age="${field}"`
    + ' | unwrap age | __error__ = `` [$__auto]))';
};

/** Loki-side node identity: the label pair every per-node log aggregation
 *  groups by (Tempo's equivalent is resource.service.instance.id). */
export const LOKI_NODE_GROUP = 'service_instance_id, deployment_environment';
export const sumByLokiNode = (inner) => `sum by (${LOKI_NODE_GROUP}) (${inner})`;
export const countByLokiNode = (inner) => `count by (${LOKI_NODE_GROUP}) (${inner})`;

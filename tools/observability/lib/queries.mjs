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

/** Loki-side node identity: the label pair every per-node log aggregation
 *  groups by (Tempo's equivalent is resource.service.instance.id). */
export const LOKI_NODE_GROUP = 'service_instance_id, deployment_environment';
export const sumByLokiNode = (inner) => `sum by (${LOKI_NODE_GROUP}) (${inner})`;
export const countByLokiNode = (inner) => `count by (${LOKI_NODE_GROUP}) (${inner})`;

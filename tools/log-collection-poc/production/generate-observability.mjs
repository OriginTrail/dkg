#!/usr/bin/env node
// Source of truth for the DKG observability Grafana artifacts.
//
// Emits the four dashboard JSONs and alert-rules.provisioning.json in this
// directory. Edit THIS file (compact helpers below), regenerate, commit both —
// never hand-edit the rendered JSON.
//
//   node generate-observability.mjs [outDir] [--vm-uid <uid>] [--loki-uid <uid>]
//                                   [--prom-node-label <label>] [--check]
//
// Dashboards bind datasources through template variables (loki/vm/tempo), so
// they import anywhere unchanged. Alert rules must reference concrete
// datasource UIDs; the committed artifact keeps the <VM_DATASOURCE_UID>
// placeholder (that UID is instance-specific) — pass --vm-uid to render an
// importable payload for a real instance. The Loki UID defaults to "loki",
// the deliberate stable name on the production server. --check verifies the
// committed artifacts match the generator (used by CI); --prom-node-label
// switches the metrics node-identity profile (see below).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Strict CLI boundary: one optional positional (outDir) + two value flags.
// Fail loudly on unknown flags, missing flag values, or flag values that look
// like flags — a typoed command must not silently render a malformed payload.
const usage = 'usage: node generate-observability.mjs [outDir] [--vm-uid <uid>] [--loki-uid <uid>] [--prom-node-label <label>] [--check]';
const VALUE_FLAGS = ['--vm-uid', '--loki-uid', '--prom-node-label'];
const opts = { outDir: null, '--check': false };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_FLAGS.includes(a)) {
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) { console.error(`${a} requires a value\n${usage}`); process.exit(1); }
    opts[a] = v;
  } else if (a === '--check') {
    opts['--check'] = true;
  } else if (a.startsWith('--')) {
    console.error(`unknown flag ${a}\n${usage}`); process.exit(1);
  } else if (opts.outDir === null) {
    opts.outDir = a;
  } else {
    console.error(`unexpected extra argument ${a}\n${usage}`); process.exit(1);
  }
}
const outDir = opts.outDir ?? path.dirname(fileURLToPath(import.meta.url));
const VM_UID = opts['--vm-uid'] ?? '<VM_DATASOURCE_UID>';
const LOKI_UID = opts['--loki-uid'] ?? 'loki';
// Node-identity profile for the PROMETHEUS backend: which label carries the
// node name (service.instance.id). 'instance' is the canonical OTLP mapping
// (VictoriaMetrics native OTLP ingest and prometheusremotewrite both use it);
// collectors configured with resource_to_telemetry_conversion emit
// 'service_instance_id' instead — switch with ONE flag, every metrics query,
// legend, group-by, alert expression and summary derives from this constant.
// (Loki's node label is service_instance_id and Tempo's is
// resource.service.instance.id — fixed by our own pipeline, not profiled.)
const PROM_NODE_LABEL = opts['--prom-node-label'] ?? 'instance';
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(PROM_NODE_LABEL)) {
  console.error(`--prom-node-label must be a valid Prometheus label name, got: ${PROM_NODE_LABEL}\n${usage}`); process.exit(1);
}

// ---------------------------------------------------------------- dashboards
const LOKI = { type: 'loki', uid: '${loki}' };
const VM = { type: 'prometheus', uid: '${vm}' };
const TEMPO = { type: 'tempo', uid: '${tempo}' };
const dashLinks = [{ type: 'dashboards', tags: ['dkg'], asDropdown: true, title: 'DKG dashboards', includeVars: false, keepTime: true }];
const lokiVarVisible = { name: 'loki', type: 'datasource', query: 'loki', label: 'Loki', current: {} };
const lokiVarHidden = { ...lokiVarVisible, hide: 2 };
const nodeVarMulti = { name: 'node', label: 'Node', type: 'query', datasource: LOKI, query: 'label_values(service_instance_id)', refresh: 2, includeAll: true, multi: true, allValue: '.+', current: { text: ['All'], value: ['$__all'] } };

// Layout: dashboards are defined as ROWS of sized panels; x/y are computed
// (x accumulates widths within a row, y advances by the tallest panel of the
// row), so inserting or resizing a panel never requires recalculating any
// other panel's coordinates. Builders take (w, h) and carry a gridPos
// placeholder so the stamped key keeps its position in the rendered JSON.
const layout = (rows) => {
  const panels = [];
  let y = 0;
  for (const row of rows) {
    let x = 0, rowH = 0;
    for (const item of row) {
      item.def.gridPos = { h: item.h, w: item.w, x, y };
      panels.push(item.def);
      x += item.w;
      rowH = Math.max(rowH, item.h);
    }
    y += rowH;
  }
  return panels;
};

const TS = (w, h, ds, title, targets, unit) => ({ w, h, def: { datasource: ds, type: 'timeseries', title, gridPos: undefined,
  fieldConfig: { defaults: { unit: unit ?? 'short' }, overrides: [] },
  targets: targets.map((t, i) => ({ datasource: ds, refId: String.fromCharCode(65 + i), expr: t.expr, legendFormat: t.legend })) } });
const LOGSP = (w, h, title, expr) => ({ w, h, def: { datasource: LOKI, type: 'logs', title, gridPos: undefined,
  options: { showTime: true, sortOrder: 'Descending', wrapLogMessage: true, enableLogDetails: true },
  targets: [{ datasource: LOKI, refId: 'A', expr }] } });
const TEXT = (content) => ({ w: 24, h: 3, def: { type: 'text', title: '', gridPos: undefined, options: { mode: 'markdown', content }, transparent: true } });
const ROW = (title) => ({ w: 24, h: 1, def: { type: 'row', title, gridPos: undefined, collapsed: false } });

const FE = '{service_name="dkg-node", deployment_environment=~"${env:regex}"}';
const RPCPIPE = ' |= `rpc_usage` | logfmt | method != `` | unwrap count ';

const fleet = {
  uid: 'dkg-fleet-logs', title: 'DKG Fleet — Logs Overview', timezone: 'browser', refresh: '1m',
  time: { from: 'now-6h', to: 'now' }, tags: ['dkg', 'logs'], links: dashLinks,
  templating: { list: [ lokiVarVisible,
    { name: 'env', label: 'Environment', type: 'query', datasource: LOKI, query: 'label_values(deployment_environment)', includeAll: true, multi: true, refresh: 2, current: { text: ['All'], value: ['$__all'] }, allValue: '.+' },
  ]},
  panels: layout([
    [
      { w: 6, h: 5, def: { datasource: LOKI, type: 'stat', title: 'Nodes reporting (last 10m)', gridPos: undefined,
        fieldConfig: { defaults: { unit: 'none' }, overrides: [] },
        targets: [{ datasource: LOKI, refId: 'A', instant: true, queryType: 'instant',
          expr: `count(count by (service_instance_id) (count_over_time(${FE} [10m])))` }] } },
      TS(18, 9, LOKI, 'Log volume per node', [{ expr: `sum by (service_instance_id) (count_over_time(${FE} [$__auto]))`, legend: '{{service_instance_id}}' }]),
    ],
    [ TS(24, 8, LOKI, 'Errors per node', [{ expr: `sum by (service_instance_id) (count_over_time(${FE} | severity_text=\`ERROR\` [$__auto]))`, legend: '{{service_instance_id}}' }]) ],
    [ LOGSP(24, 10, 'Recent errors (all nodes)', `${FE} | severity_text=\`ERROR\``) ],
    [
      TS(12, 9, LOKI, 'RPC requests per node', [{ expr: `sum by (service_instance_id) (sum_over_time(${FE}${RPCPIPE}[$__auto]))`, legend: '{{service_instance_id}}' }]),
      TS(12, 9, LOKI, 'RPC requests by method (fleet)', [{ expr: `sum by (method) (sum_over_time(${FE}${RPCPIPE}[$__auto]))`, legend: '{{method}}' }]),
    ],
    [
      { w: 6, h: 7, def: { datasource: LOKI, type: 'stat', title: 'Total RPC requests (selected range)', gridPos: undefined,
        fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
        options: { reduceOptions: { calcs: ['sum'], fields: '', values: false } },
        targets: [{ datasource: LOKI, refId: 'A', expr: `sum(sum_over_time(${FE}${RPCPIPE}[$__auto]))` }] } },
      { w: 18, h: 7, def: { datasource: LOKI, type: 'bargauge', title: 'Top nodes by RPC requests (selected range) — credit burners', gridPos: undefined,
        options: { displayMode: 'gradient', orientation: 'horizontal', reduceOptions: { calcs: ['sum'], fields: '', values: false } },
        transformations: [ { id: 'reduce', options: { reducers: ['sum'] } }, { id: 'sortBy', options: { sort: [{ field: 'Total', desc: true }] } } ],
        targets: [{ datasource: LOKI, refId: 'A', legendFormat: '{{service_instance_id}}', expr: `sum by (service_instance_id) (sum_over_time(${FE}${RPCPIPE}[$__auto]))` }] } },
    ],
  ]),
};

const NB = '{service_instance_id="$node"}';
const nodeLogs = {
  uid: 'dkg-node-logs', title: 'DKG Node — Logs', timezone: 'browser', refresh: '30s',
  time: { from: 'now-1h', to: 'now' }, tags: ['dkg', 'logs'], links: dashLinks,
  templating: { list: [ lokiVarVisible,
    { name: 'node', label: 'Node', type: 'query', datasource: LOKI, query: 'label_values(service_instance_id)', refresh: 2, current: {} },
    { name: 'level', label: 'Level', type: 'custom', query: 'DEBUG,INFO,WARN,ERROR', includeAll: true, multi: true, allValue: '.+', current: { text: ['All'], value: ['$__all'] } },
    { name: 'search', label: 'Filter (regex)', type: 'textbox', query: '', current: { text: '', value: '' } },
  ]},
  panels: layout([
    [ LOGSP(24, 20, 'Logs — $node', `${NB} | severity_text=~\`\${level:regex}\` |~ \`(?i)$search\``) ],
    [ TS(24, 6, LOKI, 'Log volume by level — $node', [{ expr: `sum by (severity_text) (count_over_time(${NB} | severity_text=~\`\${level:regex}\` |~ \`(?i)$search\` [$__auto]))`, legend: '{{severity_text}}' }]) ],
    [
      TS(18, 8, LOKI, 'RPC requests by method — $node', [{ expr: `sum by (method) (sum_over_time(${NB}${RPCPIPE}[$__auto]))`, legend: '{{method}}' }]),
      { w: 6, h: 8, def: { datasource: LOKI, type: 'stat', title: 'RPC requests — $node (selected range)', gridPos: undefined,
        fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
        options: { reduceOptions: { calcs: ['sum'], fields: '', values: false } },
        targets: [{ datasource: LOKI, refId: 'A', expr: `sum(sum_over_time(${NB}${RPCPIPE}[$__auto]))` }] } },
    ],
  ]),
};

const SEL = `${PROM_NODE_LABEL}=~"\${node:regex}"`;
const R = '[$__rate_interval]';
const metrics = {
  uid: 'dkg-node-metrics', title: 'DKG Nodes — Metrics', timezone: 'browser', refresh: '1m',
  time: { from: 'now-6h', to: 'now' }, tags: ['dkg', 'metrics'], links: dashLinks,
  description: `OTel metrics from dkg-node (meter @origintrail-official/dkg). Node label profile: ${PROM_NODE_LABEL} (= service.instance.id under the canonical OTLP mapping). If the collector emits a different node label (e.g. resource_to_telemetry_conversion -> service_instance_id), regenerate with --prom-node-label.`,
  templating: { list: [ { name: 'vm', type: 'datasource', query: 'prometheus', label: 'Metrics DS', hide: 2, current: {} }, lokiVarHidden, nodeVarMulti ] },
  panels: layout([
    [ TEXT('**Requires node metric export.** These panels read OTel metrics from dkg-node; a node ships them when it resolves a metrics endpoint (env `OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4318` or config `telemetry.metrics.endpoint`) and the collector routes metrics → VictoriaMetrics. Empty panels mean no node currently exports metrics — see RUNBOOK.md for rollout state and enablement steps. The **Pipeline health** row reads the collector\'s self-monitoring and works independently of node export.') ],
    [ ROW('Publishing') ],
    [
      TS(12, 8, VM, 'Publish rate by outcome', [{ expr: `sum by (outcome) (rate(dkg_publish_total{${SEL}}${R}))`, legend: '{{outcome}}' }], 'ops'),
      TS(12, 8, VM, 'Publish duration p50/p95', [
        { expr: `histogram_quantile(0.95, sum by (le) (rate({__name__=~"dkg_publish_duration(_milliseconds)?_bucket", ${SEL}}${R})))`, legend: 'p95' },
        { expr: `histogram_quantile(0.50, sum by (le) (rate({__name__=~"dkg_publish_duration(_milliseconds)?_bucket", ${SEL}}${R})))`, legend: 'p50' },
      ], 'ms'),
    ],
    [
      TS(8, 8, VM, 'ACK quorum outcomes', [{ expr: `sum by (outcome) (rate(dkg_ack_quorum_total{${SEL}}${R}))`, legend: '{{outcome}}' }], 'ops'),
      TS(8, 8, VM, 'ACK peer results (publisher side)', [{ expr: `sum by (result) (rate(dkg_ack_peer_total{${SEL}}${R}))`, legend: '{{result}}' }], 'ops'),
      TS(8, 8, VM, 'ACK declines by code + handler outcomes', [
        { expr: `sum by (decline_code) (rate(dkg_ack_peer_total{result="decline", ${SEL}}${R}))`, legend: 'sent-to-us: {{decline_code}}' },
        { expr: `sum by (outcome) (rate(dkg_ack_handler_total{${SEL}}${R}))`, legend: 'handler: {{outcome}}' },
      ], 'ops'),
    ],
    [ ROW('Chain / RPC') ],
    [
      TS(12, 8, VM, 'Raw RPC requests by method (billing unit)', [{ expr: `sum by (rpc_method) (rate(dkg_chain_rpc_requests_total{${SEL}}${R}))`, legend: '{{rpc_method}}' }], 'reqps'),
      TS(12, 8, VM, 'Raw RPC requests per node', [{ expr: `sum by (${PROM_NODE_LABEL}) (rate(dkg_chain_rpc_requests_total{${SEL}}${R}))`, legend: `{{${PROM_NODE_LABEL}}}` }], 'reqps'),
    ],
    [
      TS(8, 8, VM, 'Logical chain ops by method/outcome', [{ expr: `sum by (rpc_method, outcome) (rate(dkg_chain_rpc_total{${SEL}}${R}))`, legend: '{{rpc_method}} {{outcome}}' }], 'ops'),
      TS(8, 8, VM, 'Chain RPC p95 latency by method', [{ expr: `histogram_quantile(0.95, sum by (le, rpc_method) (rate({__name__=~"dkg_chain_rpc_duration(_milliseconds)?_bucket", ${SEL}}${R})))`, legend: '{{rpc_method}}' }], 'ms'),
      TS(8, 8, VM, 'RPC endpoint failover exhaustion', [{ expr: `sum by (${PROM_NODE_LABEL}) (rate(dkg_chain_rpc_failover_total{reason="exhausted", ${SEL}}${R}))`, legend: `{{${PROM_NODE_LABEL}}}` }], 'ops'),
    ],
    [ ROW('P2P / Sync') ],
    [
      TS(12, 8, VM, 'Sync requests & responses by outcome', [
        { expr: `sum by (outcome) (rate(dkg_sync_request_total{${SEL}}${R}))`, legend: 'request: {{outcome}}' },
        { expr: `sum by (outcome) (rate(dkg_sync_response_total{${SEL}}${R}))`, legend: 'response: {{outcome}}' },
      ], 'ops'),
      TS(12, 8, VM, 'Protocol send rate + p95 by protocol', [
        { expr: `sum by (outcome) (rate(dkg_protocol_router_send_total{${SEL}}${R}))`, legend: 'send: {{outcome}}' },
        { expr: `histogram_quantile(0.95, sum by (le, protocol_id) (rate({__name__=~"dkg_protocol_router_send_duration(_milliseconds)?_bucket", ${SEL}}${R})))`, legend: 'p95 {{protocol_id}}' },
      ]),
    ],
    [ ROW('Pipeline health (collector — live now)') ],
    [
      TS(8, 8, VM, 'Collector log records/s: accepted vs exported', [
        { expr: `sum(rate(otelcol_receiver_accepted_log_records${R}))`, legend: 'accepted (in)' },
        { expr: `sum(rate(otelcol_exporter_sent_log_records${R}))`, legend: 'sent (out)' },
        { expr: `sum(rate(otelcol_exporter_send_failed_log_records${R}))`, legend: 'send FAILED' },
      ], 'ops'),
      TS(8, 8, VM, 'Collector exporter queue', [
        { expr: `sum(otelcol_exporter_queue_size)`, legend: 'queue size' },
        { expr: `sum(otelcol_exporter_queue_capacity)`, legend: 'capacity' },
      ]),
      TS(8, 8, VM, 'Collector CPU / memory', [
        { expr: `sum(rate(otelcol_process_cpu_seconds${R}))`, legend: 'CPU cores' },
        { expr: `sum(otelcol_process_memory_rss)`, legend: 'RSS bytes' },
      ]),
    ],
  ]),
};

const TQ = (w, h, title, q, limit) => ({ w, h, def: { datasource: TEMPO, type: 'table', title, gridPos: undefined,
  targets: [{ datasource: TEMPO, refId: 'A', queryType: 'traceql', query: q, limit: limit ?? 20, tableType: 'traces', filters: [] }] } });
const NODEQ = 'resource.service.name="dkg-node" && resource.service.instance.id=~"${node:regex}"';
const traces = {
  uid: 'dkg-node-traces', title: 'DKG Nodes — Traces', timezone: 'browser', refresh: '1m',
  time: { from: 'now-3h', to: 'now' }, tags: ['dkg', 'traces'], links: dashLinks,
  description: 'Tempo traces from dkg-node (tracer @origintrail-official/dkg). 14 span types: agent.publish, publisher.ack_collect/ack_peer_request, chain.tx_send/tx_submit/tx_wait/eth_call/eth_getLogs, sync.request/response, protocol_router.send…',
  templating: { list: [ { name: 'tempo', type: 'datasource', query: 'tempo', label: 'Traces DS', hide: 2, current: {} }, lokiVarHidden, nodeVarMulti ] },
  panels: layout([
    [ TEXT('**Requires node trace export.** These panels read Tempo traces from dkg-node; a node ships them when it resolves a traces endpoint (env `OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4318` or config `telemetry.traces.endpoint`) and the collector routes traces → Tempo. Empty panels mean no node currently exports traces — see RUNBOOK.md for rollout state and enablement steps. One trace per publish / ACK round / chain transaction / sync; click any Trace ID for the full timeline.') ],
    [ TQ(24, 9, 'Recent traces', `{${NODEQ}}`, 50) ],
    [
      TQ(12, 9, 'Errored operations', `{${NODEQ} && status=error}`, 50),
      TQ(12, 9, 'Slow publishes (>5s)', `{${NODEQ} && name="agent.publish" && duration>5s}`, 50),
    ],
    [
      TQ(12, 9, 'Slow chain ops (>2s)', `{${NODEQ} && name=~"chain\\\\..*" && duration>2s}`, 50),
      TQ(12, 9, 'ACK collection rounds', `{${NODEQ} && name="publisher.ack_collect"}`, 50),
    ],
  ]),
};

// -------------------------------------------------------------- alert rules
// Declarative spec layer: each entry below is the SINGLE definition of one
// alert. The Grafana provisioning payload (data blocks, condition, labels) AND
// the markdown summary table in example-alerts.md are both derived from it —
// change a threshold here and both stay in sync by regenerating.
const ALERT_SPECS = [
  { title: 'Node silent — seen in last 3h, quiet 15m (per node)', signal: 'logs',
    ds: 'loki', windowSec: 600, maxDataPoints: 50,
    expr: 'count by (service_instance_id) (count_over_time({service_name="dkg-node"}[3h] offset 15m)) unless count by (service_instance_id) (count_over_time({service_name="dkg-node"}[15m]))',
    condition: { op: '>', value: 0 }, forDur: '5m', noData: 'OK',
    summary: 'Node {{ $labels.service_instance_id }} was shipping logs (seen in the 3h window) but has been silent for 15m. Fires per node — unaffected by other nodes joining or leaving.' },
  { title: 'Fleet blackout — NO node logs reaching Loki', signal: 'logs',
    ds: 'loki', windowSec: 600, maxDataPoints: 50,
    expr: 'count(sum by (service_instance_id) (count_over_time({service_name="dkg-node"}[15m])))',
    condition: { op: '<', value: 1 }, forDur: '5m', noData: 'Alerting',
    summary: 'Zero nodes have shipped any logs in 15m — the whole fleet or the ingest pipeline (collector/Loki) is down.' },
  { title: 'Error spike on a node (>10 ERROR / 10m)', signal: 'logs',
    ds: 'loki', windowSec: 600,
    expr: 'sum by (service_instance_id) (count_over_time({service_name="dkg-node"} | severity_text=`ERROR` [10m]))',
    condition: { op: '>', value: 10 }, forDur: '5m', noData: 'OK',
    summary: 'Node {{ $labels.service_instance_id }} logged {{ $values.B }} ERRORs in 10m.' },
  { title: 'Warn spike on a node (>150 WARN / 10m)', signal: 'logs',
    ds: 'loki', windowSec: 600,
    expr: 'sum by (service_instance_id) (count_over_time({service_name="dkg-node"} | severity_text=`WARN` [10m]))',
    condition: { op: '>', value: 150 }, forDur: '10m', noData: 'OK',
    summary: 'Node {{ $labels.service_instance_id }} logged {{ $values.B }} WARNs in 10m — something is degraded (sync retries, RPC trouble, store issues).' },
  { title: 'RPC credit burn spike (>6000 raw RPC requests/h on a node)', signal: 'metrics',
    ds: 'loki', windowSec: 3600,
    expr: 'sum by (service_instance_id) (sum_over_time({service_name="dkg-node"} |= `rpc_usage` | logfmt | method != `` | unwrap count [1h]))',
    condition: { op: '>', value: 6000 }, forDur: '5m', noData: 'OK',
    summary: 'Node {{ $labels.service_instance_id }} made {{ $values.B }} raw RPC requests in the last hour — provider credits are burning (the $200/day scenario). Requires nodes on a post-#1409 build.' },
  { title: 'Log pipeline export failing (collector cannot ship to Loki)', signal: 'metrics',
    ds: 'vm', windowSec: 900,
    expr: 'sum(rate(otelcol_exporter_send_failed_log_records[10m]))',
    condition: { op: '>', value: 0 }, forDur: '10m', noData: 'OK',
    summary: 'The otel collector is failing to export log records ({{ $values.B }}/s) — logs are being dropped or queued.' },
  { title: 'Collector exporter queue near capacity (>80%)', signal: 'metrics',
    ds: 'vm', windowSec: 900,
    expr: 'max(otelcol_exporter_queue_size / otelcol_exporter_queue_capacity)',
    condition: { op: '>', value: 0.8 }, forDur: '10m', noData: 'OK',
    summary: 'Collector export queue at {{ $values.B }} of capacity — backpressure building, log loss imminent.' },
  { title: 'Publish failures on a node (armed — needs node metrics enabled)', signal: 'metrics',
    ds: 'vm', windowSec: 900,
    expr: `sum by (${PROM_NODE_LABEL}) (rate(dkg_publish_total{outcome=~"failed|error"}[15m]))`,
    condition: { op: '>', value: 0.02 }, forDur: '5m', noData: 'OK',
    summary: `Node {{ $labels.${PROM_NODE_LABEL} }} publish failure rate {{ $values.B }}/s over 15m. (Silent until nodes export OTel metrics.)` },
  { title: 'Chain RPC failover exhausted on a node (armed — needs node metrics enabled)', signal: 'metrics',
    ds: 'vm', windowSec: 900,
    expr: `sum by (${PROM_NODE_LABEL}) (rate(dkg_chain_rpc_failover_total{reason="exhausted"}[15m]))`,
    condition: { op: '>', value: 0 }, forDur: '5m', noData: 'OK',
    summary: `ALL configured RPC endpoints failed for node {{ $labels.${PROM_NODE_LABEL} }} — chain connectivity is down for it. (The metric contract also documents reason="recovered"; the filter keeps recovery events from ever paging as outages. Silent until nodes export OTel metrics.)` },
  { title: 'Errored spans rate (armed — needs traces + spanmetrics enabled)', signal: 'traces',
    ds: 'vm', windowSec: 900,
    expr: 'sum(rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[15m]))',
    condition: { op: '>', value: 0.05 }, forDur: '5m', noData: 'OK',
    summary: 'DKG operations are producing errored trace spans at {{ $values.B }}/s. (Silent until traces + Tempo metrics-generator are enabled.)' },
];

const EXPR = '__expr__';
const specToRule = (s) => {
  const dsUid = s.ds === 'loki' ? LOKI_UID : VM_UID;
  const queryModel = s.ds === 'loki'
    ? { refId: 'A', expr: s.expr, queryType: 'range', intervalMs: 60000, maxDataPoints: s.maxDataPoints ?? 100, datasource: { type: 'loki', uid: dsUid } }
    : { refId: 'A', expr: s.expr, range: true, instant: false, intervalMs: 60000, maxDataPoints: 100, datasource: { type: 'prometheus', uid: dsUid } };
  return {
    orgID: 1, folderUID: 'dkg-observability', ruleGroup: 'dkg-node-telemetry', title: s.title,
    condition: 'C',
    data: [
      { refId: 'A', relativeTimeRange: { from: s.windowSec, to: 0 }, datasourceUid: dsUid, model: queryModel },
      { refId: 'B', relativeTimeRange: { from: 0, to: 0 }, datasourceUid: EXPR,
        model: { refId: 'B', type: 'reduce', expression: 'A', reducer: 'last', datasource: { type: '__expr__', uid: EXPR } } },
      { refId: 'C', relativeTimeRange: { from: 0, to: 0 }, datasourceUid: EXPR,
        model: { refId: 'C', type: 'math', expression: `$B ${s.condition.op} ${s.condition.value}`, datasource: { type: '__expr__', uid: EXPR } } },
    ],
    noDataState: s.noData, execErrState: 'Error', for: s.forDur,
    labels: { team: 'dkg', signal: s.signal }, annotations: { summary: s.summary },
  };
};

// GFM table cells: pipes must be \-escaped (the ONLY escape GFM processes
// Docs rendering is deliberately decoupled from query content: the summary
// table carries only plain-text fields (no query cells, so GFM table escaping
// can never constrain which LogQL/PromQL expressions an alert may use), and
// each query is emitted as its own FENCED code block below the table. Fence
// length adapts to the longest backtick run in the expression, so any valid
// query renders verbatim.
const fenced = (t) => {
  const runs = t.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map(r => r.length + 1)));
  return `${fence}\n${t}\n${fence}`;
};
const rulesTableMd = [
  '| # | Alert | Channel | Datasource | Fires when | for | noData |',
  '|---|---|---|---|---|---|---|',
  ...ALERT_SPECS.map((s, i) =>
    `| ${i + 1} | ${s.title} | #node-${s.signal} | ${s.ds === 'loki' ? 'Loki' : 'VictoriaMetrics'} | \`${s.condition.op} ${s.condition.value}\` | ${s.forDur} | ${s.noData} |`),
  '',
  '**Queries** (range queries, reduced with `last`, evaluated against the condition above):',
  '',
  ...ALERT_SPECS.flatMap((s, i) => [`${i + 1}. ${s.title}`, '', fenced(s.expr), '']),
].join('\n').replace(/\n+$/, '');

const alerts = {
  _readme: [
    'Secret-free mirror of the alerting on the DKG observability Grafana. GENERATED by generate-observability.mjs (from ALERT_SPECS) - edit that script, not this file.',
    'The committed artifact keeps <VM_DATASOURCE_UID> as a placeholder (instance-specific UID). Render an importable payload for your instance with:',
    '  node generate-observability.mjs /tmp/render --vm-uid <your-vm-uid> [--loki-uid <your-loki-uid>]',
    'Import with an admin session and header X-Disable-Provenance: true (keeps everything UI-editable):',
    '  1. For each entry in contactPoints: POST /api/v1/provisioning/contact-points  (fill url from your password manager first)',
    '  2. GET /api/v1/provisioning/policies, APPEND policyRoutes to .routes, PUT the tree back (a PUT replaces the WHOLE tree - never PUT without GET+append)',
    '  3. For each entry in rules: POST /api/v1/provisioning/alert-rules',
    'Verified: this exact payload (rendered with the production UIDs) was imported into the production Grafana 11.4.0 on 2026-07-02; all 10 rules evaluate health=ok on the scheduler and route to the three Slack channels.',
  ],
  contactPoints: ['logs', 'metrics', 'traces'].map(sig => ({
    name: `DKG node ${sig} (Slack)`, type: 'slack',
    settings: { url: `<SLACK_WEBHOOK_NODE_${sig.toUpperCase()}>` }, disableResolveMessage: false,
  })),
  policyRoutes: ['logs', 'metrics', 'traces'].map(sig => ({
    receiver: `DKG node ${sig} (Slack)`,
    object_matchers: [['team', '=', 'dkg'], ['signal', '=', sig]],
    group_by: ['alertname', 'service_instance_id'], group_wait: '30s', group_interval: '5m', repeat_interval: '4h', continue: false,
  })),
  rules: ALERT_SPECS.map(specToRule),
};

// -------------------------------------------------------- write / --check
// Everything renders in memory first; --check then diffs against the files on
// disk and exits 1 on any mismatch, so CI can prove the committed artifacts
// were produced by this generator (no stale or hand-edited JSON can ship).
const START = '<!-- GENERATED:RULES-TABLE:START (by generate-observability.mjs — do not edit between markers) -->';
const END = '<!-- GENERATED:RULES-TABLE:END -->';
const rendered = new Map([
  ['grafana-dashboard-dkg-fleet-logs.json', JSON.stringify(fleet, null, 2) + '\n'],
  ['grafana-dashboard-dkg-node-logs.json', JSON.stringify(nodeLogs, null, 2) + '\n'],
  ['grafana-dashboard-dkg-node-metrics.json', JSON.stringify(metrics, null, 2) + '\n'],
  ['grafana-dashboard-dkg-node-traces.json', JSON.stringify(traces, null, 2) + '\n'],
  ['alert-rules.provisioning.json', JSON.stringify(alerts, null, 2) + '\n'],
]);
const mdPath = path.join(outDir, 'example-alerts.md');
const injectMd = (md) => {
  const si = md.indexOf(START), ei = md.indexOf(END);
  if (si < 0 || ei <= si) return null;
  return md.slice(0, si + START.length) + '\n' + rulesTableMd + '\n' + md.slice(ei);
};

if (opts['--check']) {
  const stale = [];
  for (const [file, want] of rendered) {
    const p = path.join(outDir, file);
    const have = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '<missing>';
    if (have !== want) stale.push(file);
  }
  if (fs.existsSync(mdPath)) {
    const md = fs.readFileSync(mdPath, 'utf8');
    const want = injectMd(md);
    if (want === null) stale.push('example-alerts.md (markers missing)');
    else if (want !== md) stale.push('example-alerts.md (generated section)');
  } else {
    stale.push('example-alerts.md (missing)');
  }
  if (stale.length) {
    console.error('STALE generated artifacts (regenerate with: node generate-observability.mjs):');
    for (const f of stale) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('check OK: all generated artifacts match the generator output');
} else {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [file, content] of rendered) {
    fs.writeFileSync(path.join(outDir, file), content);
    console.log('wrote', path.join(outDir, file));
  }
  if (fs.existsSync(mdPath)) {
    const next = injectMd(fs.readFileSync(mdPath, 'utf8'));
    if (next === null) console.warn('markers not found in example-alerts.md — table not injected');
    else { fs.writeFileSync(mdPath, next); console.log('updated rules table in', mdPath); }
  }
}

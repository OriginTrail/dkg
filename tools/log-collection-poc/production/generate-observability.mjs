#!/usr/bin/env node
// Source of truth for the DKG observability Grafana artifacts.
//
// Emits the four dashboard JSONs and alert-rules.provisioning.json in this
// directory. Edit THIS file (compact helpers below), regenerate, commit both —
// never hand-edit the rendered JSON.
//
//   node generate-observability.mjs [outDir] [--vm-uid <uid>] [--loki-uid <uid>]
//
// Dashboards bind datasources through template variables (loki/vm/tempo), so
// they import anywhere unchanged. Alert rules must reference concrete
// datasource UIDs; the committed artifact keeps the <VM_DATASOURCE_UID>
// placeholder (that UID is instance-specific) — pass --vm-uid to render an
// importable payload for a real instance. The Loki UID defaults to "loki",
// the deliberate stable name on the production server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const outDir = args[0] && !args[0].startsWith('--') ? args[0] : path.dirname(fileURLToPath(import.meta.url));
const VM_UID = flag('--vm-uid', '<VM_DATASOURCE_UID>');
const LOKI_UID = flag('--loki-uid', 'loki');

// ---------------------------------------------------------------- dashboards
const LOKI = { type: 'loki', uid: '${loki}' };
const VM = { type: 'prometheus', uid: '${vm}' };
const TEMPO = { type: 'tempo', uid: '${tempo}' };
const dashLinks = [{ type: 'dashboards', tags: ['dkg'], asDropdown: true, title: 'DKG dashboards', includeVars: false, keepTime: true }];
const lokiVarVisible = { name: 'loki', type: 'datasource', query: 'loki', label: 'Loki', current: {} };
const lokiVarHidden = { ...lokiVarVisible, hide: 2 };
const nodeVarMulti = { name: 'node', label: 'Node', type: 'query', datasource: LOKI, query: 'label_values(service_instance_id)', refresh: 2, includeAll: true, multi: true, allValue: '.+', current: { text: ['All'], value: ['$__all'] } };

const TS = (ds, title, targets, gp, unit) => ({ datasource: ds, type: 'timeseries', title, gridPos: gp,
  fieldConfig: { defaults: { unit: unit ?? 'short' }, overrides: [] },
  targets: targets.map((t, i) => ({ datasource: ds, refId: String.fromCharCode(65 + i), expr: t.expr, legendFormat: t.legend })) });
const LOGSP = (title, expr, gp) => ({ datasource: LOKI, type: 'logs', title, gridPos: gp,
  options: { showTime: true, sortOrder: 'Descending', wrapLogMessage: true, enableLogDetails: true },
  targets: [{ datasource: LOKI, refId: 'A', expr }] });
const TEXT = (content, gp) => ({ type: 'text', title: '', gridPos: gp, options: { mode: 'markdown', content }, transparent: true });
const ROW = (title, y) => ({ type: 'row', title, gridPos: { h: 1, w: 24, x: 0, y }, collapsed: false });

const FE = '{service_name="dkg-node", deployment_environment=~"${env:regex}"}';
const RPCPIPE = ' |= `rpc_usage` | logfmt | method != `` | unwrap count ';

const fleet = {
  uid: 'dkg-fleet-logs', title: 'DKG Fleet — Logs Overview', timezone: 'browser', refresh: '1m',
  time: { from: 'now-6h', to: 'now' }, tags: ['dkg', 'logs'], links: dashLinks,
  templating: { list: [ lokiVarVisible,
    { name: 'env', label: 'Environment', type: 'query', datasource: LOKI, query: 'label_values(deployment_environment)', includeAll: true, multi: true, refresh: 2, current: { text: ['All'], value: ['$__all'] }, allValue: '.+' },
  ]},
  panels: [
    { datasource: LOKI, type: 'stat', title: 'Nodes reporting (last 10m)', gridPos: {h:5,w:6,x:0,y:0},
      fieldConfig: { defaults: { unit: 'none' }, overrides: [] },
      targets: [{ datasource: LOKI, refId: 'A', instant: true, queryType: 'instant',
        expr: `count(count by (service_instance_id) (count_over_time(${FE} [10m])))` }] },
    TS(LOKI, 'Log volume per node', [{ expr: `sum by (service_instance_id) (count_over_time(${FE} [$__auto]))`, legend: '{{service_instance_id}}' }], {h:9,w:18,x:6,y:0}),
    TS(LOKI, 'Errors per node', [{ expr: `sum by (service_instance_id) (count_over_time(${FE} | severity_text=\`ERROR\` [$__auto]))`, legend: '{{service_instance_id}}' }], {h:8,w:24,x:0,y:9}),
    LOGSP('Recent errors (all nodes)', `${FE} | severity_text=\`ERROR\``, {h:10,w:24,x:0,y:17}),
    TS(LOKI, 'RPC requests per node', [{ expr: `sum by (service_instance_id) (sum_over_time(${FE}${RPCPIPE}[$__auto]))`, legend: '{{service_instance_id}}' }], {h:9,w:12,x:0,y:27}),
    TS(LOKI, 'RPC requests by method (fleet)', [{ expr: `sum by (method) (sum_over_time(${FE}${RPCPIPE}[$__auto]))`, legend: '{{method}}' }], {h:9,w:12,x:12,y:27}),
    { datasource: LOKI, type: 'stat', title: 'Total RPC requests (selected range)', gridPos: {h:7,w:6,x:0,y:36},
      fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
      options: { reduceOptions: { calcs: ['sum'], fields: '', values: false } },
      targets: [{ datasource: LOKI, refId: 'A', expr: `sum(sum_over_time(${FE}${RPCPIPE}[$__auto]))` }] },
    { datasource: LOKI, type: 'bargauge', title: 'Top nodes by RPC requests (selected range) — credit burners', gridPos: {h:7,w:18,x:6,y:36},
      options: { displayMode: 'gradient', orientation: 'horizontal', reduceOptions: { calcs: ['sum'], fields: '', values: false } },
      transformations: [ { id: 'reduce', options: { reducers: ['sum'] } }, { id: 'sortBy', options: { sort: [{ field: 'Total', desc: true }] } } ],
      targets: [{ datasource: LOKI, refId: 'A', legendFormat: '{{service_instance_id}}', expr: `sum by (service_instance_id) (sum_over_time(${FE}${RPCPIPE}[$__auto]))` }] },
  ],
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
  panels: [
    LOGSP('Logs — $node', `${NB} | severity_text=~\`\${level:regex}\` |~ \`(?i)$search\``, {h:20,w:24,x:0,y:0}),
    TS(LOKI, 'Log volume by level — $node', [{ expr: `sum by (severity_text) (count_over_time(${NB} | severity_text=~\`\${level:regex}\` |~ \`(?i)$search\` [$__auto]))`, legend: '{{severity_text}}' }], {h:6,w:24,x:0,y:20}),
    TS(LOKI, 'RPC requests by method — $node', [{ expr: `sum by (method) (sum_over_time(${NB}${RPCPIPE}[$__auto]))`, legend: '{{method}}' }], {h:8,w:18,x:0,y:26}),
    { datasource: LOKI, type: 'stat', title: 'RPC requests — $node (selected range)', gridPos: {h:8,w:6,x:18,y:26},
      fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
      options: { reduceOptions: { calcs: ['sum'], fields: '', values: false } },
      targets: [{ datasource: LOKI, refId: 'A', expr: `sum(sum_over_time(${NB}${RPCPIPE}[$__auto]))` }] },
  ],
};

const SEL = 'instance=~"${node:regex}"';
const R = '[$__rate_interval]';
const metrics = {
  uid: 'dkg-node-metrics', title: 'DKG Nodes — Metrics', timezone: 'browser', refresh: '1m',
  time: { from: 'now-6h', to: 'now' }, tags: ['dkg', 'metrics'], links: dashLinks,
  description: 'OTel metrics from dkg-node (meter @origintrail-official/dkg). Node filter uses the canonical OTLP mapping (instance = service.instance.id, used by both VictoriaMetrics native OTLP ingest and prometheusremotewrite). If the collector is configured with resource_to_telemetry_conversion instead, swap instance= for service_instance_id= in the panel queries.',
  templating: { list: [ { name: 'vm', type: 'datasource', query: 'prometheus', label: 'Metrics DS', hide: 2, current: {} }, lokiVarHidden, nodeVarMulti ] },
  panels: [
    TEXT('**Node metrics are not flowing yet.** Nodes currently export **logs only** — each node also needs a metrics endpoint: env `OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4318` (enables metrics+traces+logs in one) **or** config `telemetry.metrics.endpoint`, then a daemon restart; the collector must route metrics → VictoriaMetrics. The **Pipeline health** row at the bottom is live already (collector self-monitoring). Panels light up automatically once metrics arrive (30s export interval).', {h:3,w:24,x:0,y:0}),
    ROW('Publishing', 3),
    TS(VM, 'Publish rate by outcome', [{ expr: `sum by (outcome) (rate(dkg_publish_total{${SEL}}${R}))`, legend: '{{outcome}}' }], {h:8,w:12,x:0,y:4}, 'ops'),
    TS(VM, 'Publish duration p50/p95', [
      { expr: `histogram_quantile(0.95, sum by (le) (rate({__name__=~"dkg_publish_duration(_milliseconds)?_bucket", ${SEL}}${R})))`, legend: 'p95' },
      { expr: `histogram_quantile(0.50, sum by (le) (rate({__name__=~"dkg_publish_duration(_milliseconds)?_bucket", ${SEL}}${R})))`, legend: 'p50' },
    ], {h:8,w:12,x:12,y:4}, 'ms'),
    TS(VM, 'ACK quorum outcomes', [{ expr: `sum by (outcome) (rate(dkg_ack_quorum_total{${SEL}}${R}))`, legend: '{{outcome}}' }], {h:8,w:8,x:0,y:12}, 'ops'),
    TS(VM, 'ACK peer results (publisher side)', [{ expr: `sum by (result) (rate(dkg_ack_peer_total{${SEL}}${R}))`, legend: '{{result}}' }], {h:8,w:8,x:8,y:12}, 'ops'),
    TS(VM, 'ACK declines by code + handler outcomes', [
      { expr: `sum by (decline_code) (rate(dkg_ack_peer_total{result="decline", ${SEL}}${R}))`, legend: 'sent-to-us: {{decline_code}}' },
      { expr: `sum by (outcome) (rate(dkg_ack_handler_total{${SEL}}${R}))`, legend: 'handler: {{outcome}}' },
    ], {h:8,w:8,x:16,y:12}, 'ops'),
    ROW('Chain / RPC', 20),
    TS(VM, 'Raw RPC requests by method (billing unit)', [{ expr: `sum by (rpc_method) (rate(dkg_chain_rpc_requests_total{${SEL}}${R}))`, legend: '{{rpc_method}}' }], {h:8,w:12,x:0,y:21}, 'reqps'),
    TS(VM, 'Raw RPC requests per node', [{ expr: `sum by (instance, service_instance_id) (rate(dkg_chain_rpc_requests_total{${SEL}}${R}))`, legend: '{{instance}}{{service_instance_id}}' }], {h:8,w:12,x:12,y:21}, 'reqps'),
    TS(VM, 'Logical chain ops by method/outcome', [{ expr: `sum by (rpc_method, outcome) (rate(dkg_chain_rpc_total{${SEL}}${R}))`, legend: '{{rpc_method}} {{outcome}}' }], {h:8,w:8,x:0,y:29}, 'ops'),
    TS(VM, 'Chain RPC p95 latency by method', [{ expr: `histogram_quantile(0.95, sum by (le, rpc_method) (rate({__name__=~"dkg_chain_rpc_duration(_milliseconds)?_bucket", ${SEL}}${R})))`, legend: '{{rpc_method}}' }], {h:8,w:8,x:8,y:29}, 'ms'),
    TS(VM, 'RPC endpoint failover exhaustion', [{ expr: `sum by (instance, service_instance_id) (rate(dkg_chain_rpc_failover_total{${SEL}}${R}))`, legend: '{{instance}}{{service_instance_id}}' }], {h:8,w:8,x:16,y:29}, 'ops'),
    ROW('P2P / Sync', 37),
    TS(VM, 'Sync requests & responses by outcome', [
      { expr: `sum by (outcome) (rate(dkg_sync_request_total{${SEL}}${R}))`, legend: 'request: {{outcome}}' },
      { expr: `sum by (outcome) (rate(dkg_sync_response_total{${SEL}}${R}))`, legend: 'response: {{outcome}}' },
    ], {h:8,w:12,x:0,y:38}, 'ops'),
    TS(VM, 'Protocol send rate + p95 by protocol', [
      { expr: `sum by (outcome) (rate(dkg_protocol_router_send_total{${SEL}}${R}))`, legend: 'send: {{outcome}}' },
      { expr: `histogram_quantile(0.95, sum by (le, protocol_id) (rate({__name__=~"dkg_protocol_router_send_duration(_milliseconds)?_bucket", ${SEL}}${R})))`, legend: 'p95 {{protocol_id}}' },
    ], {h:8,w:12,x:12,y:38}),
    ROW('Pipeline health (collector — live now)', 46),
    TS(VM, 'Collector log records/s: accepted vs exported', [
      { expr: `sum(rate(otelcol_receiver_accepted_log_records${R}))`, legend: 'accepted (in)' },
      { expr: `sum(rate(otelcol_exporter_sent_log_records${R}))`, legend: 'sent (out)' },
      { expr: `sum(rate(otelcol_exporter_send_failed_log_records${R}))`, legend: 'send FAILED' },
    ], {h:8,w:8,x:0,y:47}, 'ops'),
    TS(VM, 'Collector exporter queue', [
      { expr: `sum(otelcol_exporter_queue_size)`, legend: 'queue size' },
      { expr: `sum(otelcol_exporter_queue_capacity)`, legend: 'capacity' },
    ], {h:8,w:8,x:8,y:47}),
    TS(VM, 'Collector CPU / memory', [
      { expr: `sum(rate(otelcol_process_cpu_seconds${R}))`, legend: 'CPU cores' },
      { expr: `sum(otelcol_process_memory_rss)`, legend: 'RSS bytes' },
    ], {h:8,w:8,x:16,y:47}),
  ],
};

const TQ = (title, q, gp, limit) => ({ datasource: TEMPO, type: 'table', title, gridPos: gp,
  targets: [{ datasource: TEMPO, refId: 'A', queryType: 'traceql', query: q, limit: limit ?? 20, tableType: 'traces', filters: [] }] });
const NODEQ = 'resource.service.name="dkg-node" && resource.service.instance.id=~"${node:regex}"';
const traces = {
  uid: 'dkg-node-traces', title: 'DKG Nodes — Traces', timezone: 'browser', refresh: '1m',
  time: { from: 'now-3h', to: 'now' }, tags: ['dkg', 'traces'], links: dashLinks,
  description: 'Tempo traces from dkg-node (tracer @origintrail-official/dkg). 14 span types: agent.publish, publisher.ack_collect/ack_peer_request, chain.tx_send/tx_submit/tx_wait/eth_call/eth_getLogs, sync.request/response, protocol_router.send…',
  templating: { list: [ { name: 'tempo', type: 'datasource', query: 'tempo', label: 'Traces DS', hide: 2, current: {} }, lokiVarHidden, nodeVarMulti ] },
  panels: [
    TEXT('**Node traces are not flowing yet.** Nodes currently export **logs only** — each node also needs a traces endpoint: env `OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4318` **or** config `telemetry.traces.endpoint`, then a daemon restart; the collector must route traces → Tempo. Once flowing you get one trace per publish / ACK round / chain transaction / sync — click any Trace ID to open the full timeline.', {h:3,w:24,x:0,y:0}),
    TQ('Recent traces', `{${NODEQ}}`, {h:9,w:24,x:0,y:3}, 50),
    TQ('Errored operations', `{${NODEQ} && status=error}`, {h:9,w:12,x:0,y:12}, 50),
    TQ('Slow publishes (>5s)', `{${NODEQ} && name="agent.publish" && duration>5s}`, {h:9,w:12,x:12,y:12}, 50),
    TQ('Slow chain ops (>2s)', `{${NODEQ} && name=~"chain\\\\..*" && duration>2s}`, {h:9,w:12,x:0,y:21}, 50),
    TQ('ACK collection rounds', `{${NODEQ} && name="publisher.ack_collect"}`, {h:9,w:12,x:12,y:21}, 50),
  ],
};

// -------------------------------------------------------------- alert rules
const EXPR = '__expr__';
const lokiQ = (refId, fromSec, expr, opts = {}) => ({ refId, relativeTimeRange: { from: fromSec, to: 0 }, datasourceUid: LOKI_UID,
  model: { refId, expr, queryType: 'range', intervalMs: opts.intervalMs ?? 60000, maxDataPoints: opts.maxDataPoints ?? 100, datasource: { type: 'loki', uid: LOKI_UID } } });
const vmQ = (refId, fromSec, expr) => ({ refId, relativeTimeRange: { from: fromSec, to: 0 }, datasourceUid: VM_UID,
  model: { refId, expr, range: true, instant: false, intervalMs: 60000, maxDataPoints: 100, datasource: { type: 'prometheus', uid: VM_UID } } });
const reduce = (refId, input, reducer) => ({ refId, relativeTimeRange: { from: 0, to: 0 }, datasourceUid: EXPR,
  model: { refId, type: 'reduce', expression: input, reducer, datasource: { type: '__expr__', uid: EXPR } } });
const math = (refId, expression) => ({ refId, relativeTimeRange: { from: 0, to: 0 }, datasourceUid: EXPR,
  model: { refId, type: 'math', expression, datasource: { type: '__expr__', uid: EXPR } } });
const rule = (title, data, sig, forDur, noData, summary) => ({
  orgID: 1, folderUID: 'dkg-observability', ruleGroup: 'dkg-node-telemetry', title,
  condition: 'C', data, noDataState: noData, execErrState: 'Error', for: forDur,
  labels: { team: 'dkg', signal: sig }, annotations: { summary },
});

const alerts = {
  _readme: [
    'Secret-free mirror of the alerting on the DKG observability Grafana. GENERATED by generate-observability.mjs - edit that script, not this file.',
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
  rules: [
    rule('Node silent — seen in last 3h, quiet 15m (per node)',
      [ lokiQ('A', 600, 'count by (service_instance_id) (count_over_time({service_name="dkg-node"}[3h] offset 15m)) unless count by (service_instance_id) (count_over_time({service_name="dkg-node"}[15m]))', { maxDataPoints: 50 }),
        reduce('B', 'A', 'last'), math('C', '$B > 0') ],
      'logs', '5m', 'OK',
      'Node {{ $labels.service_instance_id }} was shipping logs (seen in the 3h window) but has been silent for 15m. Fires per node — unaffected by other nodes joining or leaving.'),
    rule('Fleet blackout — NO node logs reaching Loki',
      [ lokiQ('A', 600, 'count(sum by (service_instance_id) (count_over_time({service_name="dkg-node"}[15m])))', { maxDataPoints: 50 }),
        reduce('B', 'A', 'last'), math('C', '$B < 1') ],
      'logs', '5m', 'Alerting',
      'Zero nodes have shipped any logs in 15m — the whole fleet or the ingest pipeline (collector/Loki) is down.'),
    rule('Error spike on a node (>10 ERROR / 10m)',
      [ lokiQ('A', 600, 'sum by (service_instance_id) (count_over_time({service_name="dkg-node"} | severity_text=`ERROR` [10m]))'),
        reduce('B', 'A', 'last'), math('C', '$B > 10') ],
      'logs', '5m', 'OK', 'Node {{ $labels.service_instance_id }} logged {{ $values.B }} ERRORs in 10m.'),
    rule('Warn spike on a node (>150 WARN / 10m)',
      [ lokiQ('A', 600, 'sum by (service_instance_id) (count_over_time({service_name="dkg-node"} | severity_text=`WARN` [10m]))'),
        reduce('B', 'A', 'last'), math('C', '$B > 150') ],
      'logs', '10m', 'OK', 'Node {{ $labels.service_instance_id }} logged {{ $values.B }} WARNs in 10m — something is degraded (sync retries, RPC trouble, store issues).'),
    rule('RPC credit burn spike (>6000 raw RPC requests/h on a node)',
      [ lokiQ('A', 3600, 'sum by (service_instance_id) (sum_over_time({service_name="dkg-node"} |= `rpc_usage` | logfmt | method != `` | unwrap count [1h]))'),
        reduce('B', 'A', 'last'), math('C', '$B > 6000') ],
      'metrics', '5m', 'OK', 'Node {{ $labels.service_instance_id }} made {{ $values.B }} raw RPC requests in the last hour — provider credits are burning (the $200/day scenario). Requires nodes on a post-#1409 build.'),
    rule('Log pipeline export failing (collector cannot ship to Loki)',
      [ vmQ('A', 900, 'sum(rate(otelcol_exporter_send_failed_log_records[10m]))'),
        reduce('B', 'A', 'last'), math('C', '$B > 0') ],
      'metrics', '10m', 'OK', 'The otel collector is failing to export log records ({{ $values.B }}/s) — logs are being dropped or queued.'),
    rule('Collector exporter queue near capacity (>80%)',
      [ vmQ('A', 900, 'max(otelcol_exporter_queue_size / otelcol_exporter_queue_capacity)'),
        reduce('B', 'A', 'last'), math('C', '$B > 0.8') ],
      'metrics', '10m', 'OK', 'Collector export queue at {{ $values.B }} of capacity — backpressure building, log loss imminent.'),
    rule('Publish failures on a node (armed — needs node metrics enabled)',
      [ vmQ('A', 900, 'sum by (instance, service_instance_id) (rate(dkg_publish_total{outcome=~"failed|error"}[15m]))'),
        reduce('B', 'A', 'last'), math('C', '$B > 0.02') ],
      'metrics', '5m', 'OK', 'Node {{ $labels.instance }}{{ $labels.service_instance_id }} publish failure rate {{ $values.B }}/s over 15m. (Silent until nodes export OTel metrics.)'),
    rule('Chain RPC failover exhausted on a node (armed — needs node metrics enabled)',
      [ vmQ('A', 900, 'sum by (instance, service_instance_id) (rate(dkg_chain_rpc_failover_total[15m]))'),
        reduce('B', 'A', 'last'), math('C', '$B > 0') ],
      'metrics', '5m', 'OK', 'ALL configured RPC endpoints failed for node {{ $labels.instance }}{{ $labels.service_instance_id }} — chain connectivity is down for it. (Silent until nodes export OTel metrics.)'),
    rule('Errored spans rate (armed — needs traces + spanmetrics enabled)',
      [ vmQ('A', 900, 'sum(rate(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[15m]))'),
        reduce('B', 'A', 'last'), math('C', '$B > 0.05') ],
      'traces', '5m', 'OK', 'DKG operations are producing errored trace spans at {{ $values.B }}/s. (Silent until traces + Tempo metrics-generator are enabled.)'),
  ],
};

// -------------------------------------------------------------------- write
const files = [
  ['grafana-dashboard-dkg-fleet-logs.json', fleet],
  ['grafana-dashboard-dkg-node-logs.json', nodeLogs],
  ['grafana-dashboard-dkg-node-metrics.json', metrics],
  ['grafana-dashboard-dkg-node-traces.json', traces],
  ['alert-rules.provisioning.json', alerts],
];
fs.mkdirSync(outDir, { recursive: true });
for (const [file, doc] of files) {
  fs.writeFileSync(path.join(outDir, file), JSON.stringify(doc, null, 2) + '\n');
  console.log('wrote', path.join(outDir, file));
}

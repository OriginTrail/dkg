// Dashboard catalog for the DKG observability Grafana — DATA ONLY, composed
// from one named builder per dashboard so each dashboard's panel catalog,
// query language and variable model stays a self-contained unit. Shared
// helpers (row layout, panel constructors, node-identity discovery model)
// live at module scope. Rendering, CLI handling and --check live in
// ../generate-observability.mjs.
import { dkgLogStream, severityIs, severityMatches, RPC_USAGE_PIPELINE } from './queries.mjs';

const LOKI = { type: 'loki', uid: '${loki}' };
const VM = { type: 'prometheus', uid: '${vm}' };
const TEMPO = { type: 'tempo', uid: '${tempo}' };
const dashLinks = [{ type: 'dashboards', tags: ['dkg'], asDropdown: true, title: 'DKG dashboards', includeVars: false, keepTime: true }];
const lokiVarVisible = { name: 'loki', type: 'datasource', query: 'loki', label: 'Loki', current: {} };

// Stable dashboard/panel identity used by Grafana alert rules. Grafana turns
// these into alert-specific PanelURL values; the notification template adds
// the actual firing/recovery time window and available filters. Keep the title
// assertions in alerting-contract.test.mjs in sync if a dashboard is
// reorganized.
export const INCIDENT_PANELS = Object.freeze({
  fleetPresence: { dashboardUid: 'dkg-fleet-logs', panelId: 1 },
  nodeLogs: { dashboardUid: 'dkg-node-logs', panelId: 1 },
  nodeRpcUsage: { dashboardUid: 'dkg-node-logs', panelId: 3 },
  publishOutcomes: { dashboardUid: 'dkg-node-metrics', panelId: 3 },
  ackQuorum: { dashboardUid: 'dkg-node-metrics', panelId: 5 },
  rpcFailover: { dashboardUid: 'dkg-node-metrics', panelId: 13 },
  collectorExport: { dashboardUid: 'dkg-node-metrics', panelId: 18 },
  collectorQueue: { dashboardUid: 'dkg-node-metrics', panelId: 19 },
  traceErrors: { dashboardUid: 'dkg-node-traces', panelId: 3 },
});
// Node-identity discovery model: each dashboard's $node dropdown is sourced
// from ITS OWN datasource, so the selector reflects exactly the nodes that
// signal has data for (a node shipping metrics but not logs still appears on
// the metrics dashboard, and vice versa). allowCustomValue is the escape
// hatch while a signal has no data yet.
const nodeIdentity = (nodeProfile) => ({
  logs: { datasource: LOKI, query: 'label_values({service_name="dkg-node"}, service_instance_id)' },
  metrics: { datasource: VM, query: nodeProfile.labelValuesQuery },
  traces: { datasource: TEMPO, query: { refId: 'TempoDatasourceVariableQuery', type: 1, label: 'resource.service.instance.id' } },
});
const nodeVarMulti = (identity) => ({ name: 'node', label: 'Node', type: 'query', datasource: identity.datasource, query: identity.query, refresh: 2, includeAll: true, multi: true, allValue: '.+', allowCustomValue: true, current: { text: ['All'], value: ['$__all'] } });

// Layout: dashboards are defined as ROWS of sized panels; x/y are computed
// (x accumulates widths within a row, y advances by the tallest panel of the
// row), so inserting or resizing a panel never requires recalculating any
// other panel's coordinates.
// The layout item shape is explicit — { w, h, def } where def is a plain,
// complete panel object — and layout() is the ONLY owner of gridPos: it
// VALIDATES each item at the layout boundary (a def that already carries
// gridPos, or lacks a string title, fails generation loudly instead of
// silently rendering a panel without coordinates) and constructs the output
// object explicitly as { title, gridPos, ...rest }; nothing depends on source
// key order or on finding a magic key while copying arbitrary objects.
const layout = (rows) => {
  const panels = [];
  let y = 0;
  for (const row of rows) {
    let x = 0, rowH = 0;
    for (const item of row) {
      const { w, h, def } = item;
      if (!Number.isFinite(w) || !Number.isFinite(h) || !def || typeof def !== 'object') {
        throw new Error(`layout: item must be { w, h, def } with numeric sizes — got ${JSON.stringify(item)?.slice(0, 120)}`);
      }
      if ('gridPos' in def) {
        throw new Error(`layout: panel "${def.title}" already carries gridPos — layout() is the only owner of coordinates`);
      }
      if (typeof def.title !== 'string') {
        throw new Error(`layout: panel def (type ${def.type}) needs a string title (may be empty) — a missing title must fail here, not silently drop from the rendered JSON`);
      }
      const { title, ...rest } = def;
      // Explicit deterministic IDs are required for alert-to-panel links.
      // They also prevent an import/save round trip from rewriting IDs.
      panels.push({
        id: panels.length + 1,
        title,
        gridPos: { h, w, x, y },
        ...rest,
      });
      x += w;
      rowH = Math.max(rowH, h);
    }
    y += rowH;
  }
  return panels;
};

const TS = (w, h, ds, title, targets, unit) => ({ w, h, def: { datasource: ds, type: 'timeseries', title,
  fieldConfig: { defaults: { unit: unit ?? 'short' }, overrides: [] },
  targets: targets.map((t, i) => ({ datasource: ds, refId: String.fromCharCode(65 + i), expr: t.expr, legendFormat: t.legend })) } });
const LOGSP = (w, h, title, expr) => ({ w, h, def: { datasource: LOKI, type: 'logs', title,
  options: { showTime: true, sortOrder: 'Descending', wrapLogMessage: true, enableLogDetails: true },
  targets: [{ datasource: LOKI, refId: 'A', expr }] } });
const TEXT = (content) => ({ w: 24, h: 3, def: { type: 'text', title: '', options: { mode: 'markdown', content }, transparent: true } });
const ROW = (title) => ({ w: 24, h: 1, def: { type: 'row', title, collapsed: false } });

// Loki query building blocks come from the shared contract (lib/queries.mjs)
// — the same module alerts.mjs composes from, so the stream selector,
// severity filter shape and rpc_usage pipeline cannot drift between the
// dashboards and the alert rules.
const FE = dkgLogStream('deployment_environment=~"${env:regex}"');
const RPCPIPE = RPC_USAGE_PIPELINE;

const buildFleetLogsDashboard = () => ({
  uid: 'dkg-fleet-logs', title: 'DKG Fleet — Logs Overview', timezone: 'browser', refresh: '1m',
  time: { from: 'now-6h', to: 'now' }, tags: ['dkg', 'logs'], links: dashLinks,
  templating: { list: [ lokiVarVisible,
    { name: 'env', label: 'Environment', type: 'query', datasource: LOKI, query: 'label_values(deployment_environment)', includeAll: true, multi: true, refresh: 2, current: { text: ['All'], value: ['$__all'] }, allValue: '.+' },
  ]},
  panels: layout([
    [
      { w: 6, h: 5, def: { datasource: LOKI, type: 'stat', title: 'Nodes reporting (last 10m)',
        fieldConfig: { defaults: { unit: 'none' }, overrides: [] },
        targets: [{ datasource: LOKI, refId: 'A', instant: true, queryType: 'instant',
          expr: `count(count by (service_instance_id) (count_over_time(${FE} [10m])))` }] } },
      TS(18, 9, LOKI, 'Log volume per node', [{ expr: `sum by (service_instance_id) (count_over_time(${FE} [$__auto]))`, legend: '{{service_instance_id}}' }]),
    ],
    [ TS(24, 8, LOKI, 'Errors per node', [{ expr: `sum by (service_instance_id) (count_over_time(${FE}${severityIs('ERROR')} [$__auto]))`, legend: '{{service_instance_id}}' }]) ],
    [ LOGSP(24, 10, 'Recent errors (all nodes)', `${FE}${severityIs('ERROR')}`) ],
    [
      TS(12, 9, LOKI, 'RPC requests per node', [{ expr: `sum by (service_instance_id) (sum_over_time(${FE}${RPCPIPE}[$__auto]))`, legend: '{{service_instance_id}}' }]),
      TS(12, 9, LOKI, 'RPC requests by method (fleet)', [{ expr: `sum by (method) (sum_over_time(${FE}${RPCPIPE}[$__auto]))`, legend: '{{method}}' }]),
    ],
    [
      { w: 6, h: 7, def: { datasource: LOKI, type: 'stat', title: 'Total RPC requests (selected range)',
        fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
        options: { reduceOptions: { calcs: ['sum'], fields: '', values: false } },
        targets: [{ datasource: LOKI, refId: 'A', expr: `sum(sum_over_time(${FE}${RPCPIPE}[$__auto]))` }] } },
      { w: 18, h: 7, def: { datasource: LOKI, type: 'bargauge', title: 'Top nodes by RPC requests (selected range) — credit burners',
        options: { displayMode: 'gradient', orientation: 'horizontal', reduceOptions: { calcs: ['sum'], fields: '', values: false } },
        transformations: [ { id: 'reduce', options: { reducers: ['sum'] } }, { id: 'sortBy', options: { sort: [{ field: 'Total', desc: true }] } } ],
        targets: [{ datasource: LOKI, refId: 'A', legendFormat: '{{service_instance_id}}', expr: `sum by (service_instance_id) (sum_over_time(${FE}${RPCPIPE}[$__auto]))` }] } },
    ],
  ]),
});

// Per-node selector scoped to DKG node streams: service_instance_id is a
// resource identity, not a service guarantee — on a shared Loki another
// service could reuse the same instance id.
const NB = '{service_name="dkg-node", service_instance_id="$node"}';
const buildNodeLogsDashboard = (NODE_IDENTITY) => ({
  uid: 'dkg-node-logs', title: 'DKG Node — Logs', timezone: 'browser', refresh: '30s',
  time: { from: 'now-1h', to: 'now' }, tags: ['dkg', 'logs'], links: dashLinks,
  templating: { list: [ lokiVarVisible,
    { name: 'node', label: 'Node', type: 'query', datasource: NODE_IDENTITY.logs.datasource, query: NODE_IDENTITY.logs.query, refresh: 2, current: {} },
    { name: 'level', label: 'Level', type: 'custom', query: 'DEBUG,INFO,WARN,ERROR', includeAll: true, multi: true, allValue: '.+', current: { text: ['All'], value: ['$__all'] } },
    { name: 'search', label: 'Filter (regex)', type: 'textbox', query: '', current: { text: '', value: '' } },
  ]},
  panels: layout([
    [ LOGSP(24, 20, 'Logs — $node', `${NB}${severityMatches('${level:regex}')} |~ \`(?i)$search\``) ],
    [ TS(24, 6, LOKI, 'Log volume by level — $node', [{ expr: `sum by (severity_text) (count_over_time(${NB}${severityMatches('${level:regex}')} |~ \`(?i)$search\` [$__auto]))`, legend: '{{severity_text}}' }]) ],
    [
      TS(18, 8, LOKI, 'RPC requests by method — $node', [{ expr: `sum by (method) (sum_over_time(${NB}${RPCPIPE}[$__auto]))`, legend: '{{method}}' }]),
      { w: 6, h: 8, def: { datasource: LOKI, type: 'stat', title: 'RPC requests — $node (selected range)',
        fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
        options: { reduceOptions: { calcs: ['sum'], fields: '', values: false } },
        targets: [{ datasource: LOKI, refId: 'A', expr: `sum(sum_over_time(${NB}${RPCPIPE}[$__auto]))` }] } },
    ],
  ]),
});

const R = '[$__rate_interval]';
const buildMetricsDashboard = (nodeProfile, NODE_IDENTITY) => {
  // Every profile-sensitive convention a per-node panel needs comes from the
  // profile model (lib/profile.mjs) — panels compose these, never splice the
  // raw label into query strings.
  const SEL = nodeProfile.selector;
  const BY_NODE = nodeProfile.by;
  const NODE_LEGEND = nodeProfile.legend;
  return {
  uid: 'dkg-node-metrics', title: 'DKG Nodes — Metrics', timezone: 'browser', refresh: '1m',
  time: { from: 'now-6h', to: 'now' }, tags: ['dkg', 'metrics'], links: dashLinks,
  description: `OTel metrics from dkg-node (meter @origintrail-official/dkg). Node label profile: ${nodeProfile.label} (= service.instance.id under the canonical OTLP mapping). If the collector emits a different node label (e.g. resource_to_telemetry_conversion -> service_instance_id), regenerate with --prom-node-label.`,
  templating: { list: [ { name: 'vm', type: 'datasource', query: 'prometheus', label: 'Metrics DS', hide: 2, current: {} }, nodeVarMulti(NODE_IDENTITY.metrics) ] },
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
      TS(12, 8, VM, 'Raw RPC requests by method (billing unit — post-#1409 node builds)', [{ expr: `sum by (rpc_method) (rate(dkg_chain_rpc_requests_total{${SEL}}${R}))`, legend: '{{rpc_method}}' }], 'reqps'),
      TS(12, 8, VM, 'Raw RPC requests per node (post-#1409 node builds)', [{ expr: BY_NODE(`rate(dkg_chain_rpc_requests_total{${SEL}}${R})`), legend: NODE_LEGEND }], 'reqps'),
    ],
    [
      TS(8, 8, VM, 'Logical chain ops by method/outcome', [{ expr: `sum by (rpc_method, outcome) (rate(dkg_chain_rpc_total{${SEL}}${R}))`, legend: '{{rpc_method}} {{outcome}}' }], 'ops'),
      TS(8, 8, VM, 'Chain RPC p95 latency by method', [{ expr: `histogram_quantile(0.95, sum by (le, rpc_method) (rate({__name__=~"dkg_chain_rpc_duration(_milliseconds)?_bucket", ${SEL}}${R})))`, legend: '{{rpc_method}}' }], 'ms'),
      TS(8, 8, VM, 'RPC endpoint failover exhaustion', [{ expr: BY_NODE(`rate(dkg_chain_rpc_failover_total{reason="exhausted", ${SEL}}${R})`), legend: NODE_LEGEND }], 'ops'),
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
};

const TQ = (w, h, title, q, limit) => ({ w, h, def: { datasource: TEMPO, type: 'table', title,
  targets: [{ datasource: TEMPO, refId: 'A', queryType: 'traceql', query: q, limit: limit ?? 20, tableType: 'traces', filters: [] }] } });
const NODEQ = 'resource.service.name="dkg-node" && resource.service.instance.id=~"${node:regex}"';
const buildTracesDashboard = (NODE_IDENTITY) => ({
  uid: 'dkg-node-traces', title: 'DKG Nodes — Traces', timezone: 'browser', refresh: '1m',
  time: { from: 'now-3h', to: 'now' }, tags: ['dkg', 'traces'], links: dashLinks,
  description: 'Tempo traces from dkg-node (tracer @origintrail-official/dkg). 14 span types: agent.publish, publisher.ack_collect/ack_peer_request, chain.tx_send/tx_submit/tx_wait/eth_call/eth_getLogs, sync.request/response, protocol_router.send…',
  templating: { list: [ { name: 'tempo', type: 'datasource', query: 'tempo', label: 'Traces DS', hide: 2, current: {} }, nodeVarMulti(NODE_IDENTITY.traces) ] },
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
});

export const buildDashboards = ({ nodeProfile }) => {
  const NODE_IDENTITY = nodeIdentity(nodeProfile);
  return {
    fleet: buildFleetLogsDashboard(),
    nodeLogs: buildNodeLogsDashboard(NODE_IDENTITY),
    metrics: buildMetricsDashboard(nodeProfile, NODE_IDENTITY),
    traces: buildTracesDashboard(NODE_IDENTITY),
  };
};

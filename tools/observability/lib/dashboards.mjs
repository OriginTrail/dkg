// Dashboard catalog for the DKG observability Grafana — DATA ONLY, composed
// from one named builder per dashboard so each dashboard's panel catalog,
// query language and variable model stays a self-contained unit. Shared
// helpers (row layout, panel constructors, node-identity discovery model)
// live at module scope. Rendering, CLI handling and --check live in
// ../generate-observability.mjs.
import {
  backpressurePeakAgeOverTime,
  backpressurePeakAgeByOperation,
  dkgLogStream,
  severityIs,
  severityMatches,
  RPC_USAGE_PIPELINE,
} from './queries.mjs';
import { buildW1GrafanaModel } from './w1.mjs';

const LOKI = { type: 'loki', uid: '${loki}' };
const VM = { type: 'prometheus', uid: '${vm}' };
const TEMPO = { type: 'tempo', uid: '${tempo}' };
const dashLinks = [{ type: 'dashboards', tags: ['dkg'], asDropdown: true, title: 'DKG dashboards', includeVars: false, keepTime: true }];
const lokiVarVisible = { name: 'loki', type: 'datasource', query: 'loki', label: 'Loki', current: {} };
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
      panels.push({ title, gridPos: { h, w, x, y }, ...rest });
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
const INSTANT_LOKI_TARGET = (refId, expr, legendFormat) => ({
  datasource: LOKI,
  refId,
  expr,
  legendFormat,
  instant: true,
  queryType: 'instant',
});

const INSTANT_PROM_TARGET = (refId, expr, legendFormat) => ({
  datasource: VM,
  refId,
  expr,
  legendFormat,
  instant: true,
  range: false,
  queryType: 'instant',
  editorMode: 'code',
});

const BACKPRESSURE_FLAME = (stream) => {
  const active = backpressurePeakAgeByOperation(stream, 'active');
  const queued = backpressurePeakAgeByOperation(stream, 'queued');
  return {
    w: 24,
    h: 14,
    def: {
      datasource: LOKI,
      type: 'flamegraph',
      title: 'Worker queue pressure flame graph — $node',
      description: 'Each leaf is a PR #2003 worker source. Width is its peak sampled oldest elapsed age in the selected range (milliseconds), split between admitted/active work and queued work. This is pressure age, not CPU utilization, request share, or exact completed-job runtime.',
      options: { showFlameGraphOnly: false },
      fieldConfig: { defaults: { unit: 'ms' }, overrides: [] },
      targets: [
        INSTANT_LOKI_TARGET('A', `sum((${active}) or (${queued}))`, '0|0|all sampled worker pressure'),
        INSTANT_LOKI_TARGET('B', `sum(${active})`, '1|0|active / admitted'),
        INSTANT_LOKI_TARGET('C', active, '2|1|{{scheduler}}/{{lane}}/{{operation}}'),
        INSTANT_LOKI_TARGET('D', `sum(${queued})`, '1|0|queued / waiting'),
        INSTANT_LOKI_TARGET('E', queued, '2|1|{{scheduler}}/{{lane}}/{{operation}}'),
      ],
      transformations: [
        { id: 'seriesToRows', options: {} },
        {
          id: 'extractFields',
          options: {
            source: 'Metric',
            format: 'regexp',
            regexp: '(?<level>\\d+)\\|(?<leaf>[01])\\|(?<label>.*)',
            replace: false,
          },
        },
        {
          id: 'convertFieldType',
          options: {
            conversions: [
              { targetField: 'level', destinationType: 'number' },
              { targetField: 'leaf', destinationType: 'number' },
            ],
          },
        },
        {
          id: 'calculateField',
          options: {
            mode: 'binary',
            binary: {
              left: { matcher: { id: 'byName', options: 'Value' } },
              operator: '*',
              right: { matcher: { id: 'byName', options: 'leaf' } },
            },
            alias: 'self',
            replaceFields: false,
          },
        },
        {
          id: 'organize',
          options: {
            excludeByName: { Time: true, Metric: true, leaf: true },
            indexByName: { level: 0, label: 1, Value: 2, self: 3 },
            renameByName: { Value: 'value' },
          },
        },
      ],
    },
  };
};

const BACKPRESSURE_HEATMAP = (stream, phase) => {
  if (phase !== 'active' && phase !== 'queued') {
    throw new Error(`backpressure heatmap phase must be active or queued, got ${phase}`);
  }
  const active = phase === 'active';
  const label = active ? 'Active / admitted' : 'Queued / waiting';
  const meaning = active ? 'oldest work occupying a worker slot' : 'oldest work waiting for admission';
  return {
    w: 12,
    h: 12,
    def: {
      datasource: LOKI,
      type: 'heatmap',
      title: `${label} pressure age heatmap — $node`,
      description: `Distribution over time of the peak sampled age of the ${meaning}, grouped by scheduler/lane. Values come from sparse PR #2003 transition and summary records; they are sampled pressure age in milliseconds, not CPU time or exact job duration.`,
      fieldConfig: { defaults: { unit: 'ms' }, overrides: [] },
      options: {
        calculate: true,
        calculation: {
          xBuckets: { mode: 'count', value: '60' },
          yBuckets: { mode: 'count', value: '20', scale: { type: 'linear' } },
        },
        cellGap: 1,
        cellValues: {},
        color: {
          mode: 'scheme',
          scheme: active ? 'Reds' : 'Oranges',
          steps: 64,
          reverse: false,
          scale: 'exponential',
          exponent: 0.5,
        },
        filterValues: { le: 0 },
        legend: { show: true },
        rowsFrame: { layout: 'auto' },
        tooltip: { mode: 'single', showColorScale: true, yHistogram: false },
        yAxis: { axisPlacement: 'left', reverse: false, unit: 'ms' },
      },
      targets: [{
        datasource: LOKI,
        refId: 'A',
        expr: backpressurePeakAgeOverTime(stream, phase),
        legendFormat: '{{scheduler}}/{{lane}}',
        queryType: 'range',
      }],
    },
  };
};

const W1_FLAMEGRAPH = (targets) => ({
  w: 24,
  h: 14,
  def: {
    datasource: VM,
    type: 'flamegraph',
    title: 'Source-attributed sync active occupancy — $node',
    description: 'Hierarchy is source → requester lane → terminal outcome. Width is completed logical-sync active wall-clock occupancy accumulated over the selected Grafana range. It is admitted occupancy, not CPU time, and excludes rejected-before-start operations (shown separately).',
    options: { showFlameGraphOnly: false },
    fieldConfig: { defaults: { unit: 'ms' }, overrides: [] },
    targets: [
      INSTANT_PROM_TARGET('A', targets.flame_root, '0|0|all selected sync occupancy'),
      INSTANT_PROM_TARGET('B', targets.flame_source, '1|0|{{source}}'),
      INSTANT_PROM_TARGET('C', targets.flame_source_lane, '2|0|{{source}}/{{lane}}'),
      INSTANT_PROM_TARGET('D', targets.flame_source_lane_outcome, '3|1|{{source}}/{{lane}}/{{outcome}}'),
    ],
    transformations: [
      { id: 'seriesToRows', options: {} },
      {
        id: 'extractFields',
        options: {
          source: 'Metric',
          format: 'regexp',
          regexp: '(?<level>\\d+)\\|(?<leaf>[01])\\|(?<label>.*)',
          replace: false,
        },
      },
      {
        id: 'convertFieldType',
        options: {
          conversions: [
            { targetField: 'level', destinationType: 'number' },
            { targetField: 'leaf', destinationType: 'number' },
          ],
        },
      },
      {
        id: 'calculateField',
        options: {
          mode: 'binary',
          binary: {
            left: { matcher: { id: 'byName', options: 'Value' } },
            operator: '*',
            right: { matcher: { id: 'byName', options: 'leaf' } },
          },
          alias: 'self',
          replaceFields: false,
        },
      },
      {
        id: 'organize',
        options: {
          excludeByName: { Time: true, Metric: true, leaf: true },
          indexByName: { level: 0, label: 1, Value: 2, self: 3 },
          renameByName: { Value: 'value' },
        },
      },
    ],
  },
});

const PROM_HISTOGRAM_HEATMAP = (w, title, description, expr, scheme = 'Oranges') => ({
  w,
  h: 12,
  def: {
    datasource: VM,
    type: 'heatmap',
    title,
    description,
    fieldConfig: { defaults: { unit: 'ms' }, overrides: [] },
    options: {
      calculate: false,
      cellGap: 1,
      cellValues: {},
      color: { mode: 'scheme', scheme, steps: 64, reverse: false, scale: 'exponential', exponent: 0.5 },
      filterValues: { le: 0 },
      legend: { show: true },
      rowsFrame: { layout: 'auto' },
      tooltip: { mode: 'single', showColorScale: true, yHistogram: true },
      yAxis: { axisPlacement: 'left', reverse: false, unit: 'ms' },
    },
    targets: [{
      datasource: VM,
      refId: 'A',
      expr,
      format: 'heatmap',
      legendFormat: '{{le}}',
      queryType: 'range',
      editorMode: 'code',
    }],
  },
});

const STAT = (w, title, description, expr, unit = 'short', thresholds) => ({
  w,
  h: 6,
  def: {
    datasource: VM,
    type: 'stat',
    title,
    description,
    fieldConfig: {
      defaults: {
        unit,
        ...(thresholds ? { color: { mode: 'thresholds' }, thresholds } : {}),
      },
      overrides: [],
    },
    options: {
      colorMode: thresholds ? 'value' : 'none',
      graphMode: 'area',
      justifyMode: 'auto',
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      textMode: 'auto',
    },
    targets: [INSTANT_PROM_TARGET('A', expr, '')],
  },
});

const MIN_GATE = (minimum) => ({ mode: 'absolute', steps: [
  { color: 'red', value: null },
  { color: 'green', value: minimum },
] });
const ZERO_GATE = { mode: 'absolute', steps: [
  { color: 'green', value: null },
  { color: 'red', value: 1 },
] };

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
    [ ROW('Scheduler pressure') ],
    [ TEXT('**Worker queue diagnostics (PR #2003).** The flame graph answers **which scheduler/lane/operation produced the pressure**; the two heatmaps show **when active and queued pressure accumulated and how old it became**. All three views read the same bounded structured `[backpressure]` records from Loki. These sparse transition/summary samples describe elapsed pressure age; they are not CPU profiles, invocation counts, or exact end-to-end job durations.') ],
    [ BACKPRESSURE_FLAME(NB) ],
    [ BACKPRESSURE_HEATMAP(NB, 'active'), BACKPRESSURE_HEATMAP(NB, 'queued') ],
    [ LOGSP(24, 10, 'Backpressure transitions and summaries — $node', `${NB} |= \`[backpressure]\``) ],
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

const buildSyncCostDashboard = (nodeProfile, NODE_IDENTITY) => {
  const model = buildW1GrafanaModel({ nodeProfile });
  const Q = model.targets;
  const multiCustom = (name, label, values) => ({
    name,
    label,
    type: 'custom',
    query: values.join(','),
    includeAll: true,
    multi: true,
    allValue: '.+',
    current: { text: ['All'], value: ['$__all'] },
  });
  return {
    uid: 'dkg-sync-cost',
    title: 'DKG Nodes — Sync Cost',
    timezone: 'browser',
    refresh: '1m',
    time: { from: 'now-6h', to: 'now' },
    tags: ['dkg', 'metrics', 'sync'],
    links: dashLinks,
    description: `PR #2033 W1 source-attributed sync telemetry (I1–I9). Node label profile: ${nodeProfile.label}. The dashboard is an interactive operational view; the generated w1/w1-queries.md remains the fixed 1 h / 2 h decision contract.`,
    templating: { list: [
      { name: 'vm', type: 'datasource', query: 'prometheus', label: 'Metrics DS', hide: 2, current: {} },
      nodeVarMulti(NODE_IDENTITY.metrics),
      multiCustom('sync_source', 'Sync source', model.variables.sources),
      multiCustom('sync_lane', 'Operation lane', model.variables.lanes),
      multiCustom('sync_outcome', 'Operation outcome', model.variables.outcomes),
    ] },
    panels: layout([
      [ TEXT('**Requires the extended sync diagnostics from PR #2033 and node metric export.** The flame graph and duration heatmaps use real OpenTelemetry counters/histograms, while the existing **DKG Node — Logs** pressure views continue to use Loki transition/summary records. Filter the interactive operation views with the source/lane/outcome controls above. The evidence and materiality panels intentionally retain W1\'s fixed durable filters and source-family rules; a failed gate means **inconclusive**, not healthy.') ],
      [ ROW('Source-attributed sync cost (I1–I4)') ],
      [ W1_FLAMEGRAPH(Q) ],
      [
        TS(8, 9, VM, 'Physical sync attempts by source/outcome (I1)', [
          { expr: Q.attempts_rate, legend: '{{source}} · {{outcome}} · {{transport}}/{{plane}}/{{phase}}' },
        ], 'ops'),
        TS(8, 9, VM, 'Encoded payload throughput by source (I2 + I3)', [
          { expr: Q.request_bytes_rate, legend: 'request · {{source}}' },
          { expr: Q.response_bytes_rate, legend: 'response · {{source}} · {{outcome}}' },
        ], 'Bps'),
        TS(8, 9, VM, 'Average active worker equivalents (I4 sum)', [
          { expr: Q.active_worker_equivalents, legend: '{{source}} · {{lane}} · {{outcome}}' },
        ], 'short'),
      ],
      [
        PROM_HISTOGRAM_HEATMAP(12, 'Logical sync operation duration heatmap (I4)', 'Completed logical-sync duration distribution for the selected source/lane/outcome filters. Rejected-before-start work is excluded by contract and appears in I5.', Q.sync_operation_duration_buckets, 'Reds'),
        PROM_HISTOGRAM_HEATMAP(12, 'Sync scheduler queue-wait heatmap (corroborating P1)', 'Queue-wait distribution for the sync-global scheduler and selected operation lanes. This corroborates W1 cost; it is not one of I1–I9.', Q.queue_wait_buckets, 'Oranges'),
      ],
      [ TS(24, 7, VM, 'Oldest queued sync item age by lane (corroborating P2)', [
        { expr: Q.oldest_queued_age, legend: '{{lane}}' },
      ], 'ms') ],

      [ ROW('Admission and coalescing (I5–I6)') ],
      [
        TS(12, 9, VM, 'Operations rejected before starting (I5)', [
          { expr: Q.rejected_rate, legend: '{{source}} · {{lane}} · {{reason}}' },
        ], 'ops'),
        TS(12, 9, VM, 'Single-flight joins (I6)', [
          { expr: Q.singleflight_joins_rate, legend: '{{scope}} · {{owner_source}} ← {{joiner_source}}' },
        ], 'ops'),
      ],

      [ ROW('Catch-up request and job accounting (I7–I9)') ],
      [
        TS(8, 9, VM, 'Catch-up requests by route result (I7)', [
          { expr: Q.catchup_requests_rate, legend: '{{result}} · swm={{include_shared_memory}}' },
        ], 'ops'),
        TS(8, 9, VM, 'Catch-up jobs by terminal state (I8)', [
          { expr: Q.catchup_jobs_rate, legend: '{{status}} · {{admission}}' },
        ], 'ops'),
        TS(8, 9, VM, 'Walk catch-up duration p95 (I9)', [
          { expr: Q.catchup_duration_p95, legend: 'walk p95' },
        ], 'ms'),
      ],
      [ PROM_HISTOGRAM_HEATMAP(24, 'Walk catch-up job duration heatmap (I9)', 'Wall-clock duration distribution for real walk jobs. Synthetic already-ready jobs deliberately produce no zero-duration sample.', Q.catchup_duration_buckets, 'Blues') ],

      [ ROW('W1 evidence gates — selected Grafana range') ],
      [ TEXT('These six panels are the same gate expressions as the generated W1 decision packet, evaluated over the selected Grafana range. Threshold colors encode the fixed contract where a numeric threshold exists. **All gates must pass** before interpreting the source-family shares; low export coverage must be compared with selected-range length ÷ scrape interval.') ],
      [
        STAT(4, 'Completed durable operations', 'I4 count; must be at least 200.', Q.gate_completed_operations, 'short', MIN_GATE(200)),
        STAT(4, 'Attributed durable payload', 'I2 + I3; must be at least 50 MB.', Q.gate_payload_bytes, 'bytes', MIN_GATE(50_000_000)),
        STAT(4, 'Cross-family joins', 'I6; must remain zero.', Q.gate_cross_family_joins, 'short', ZERO_GATE),
        STAT(4, 'Unclassified source samples', 'I1/I4/I5; must remain zero.', Q.gate_invalidating_sources, 'short', ZERO_GATE),
        STAT(4, 'Counter resets', 'Must remain zero inside the selected range.', Q.gate_counter_resets, 'short', ZERO_GATE),
        STAT(4, 'Minimum export samples', 'Compare with selected-range length divided by scrape interval.', Q.gate_export_samples),
      ],

      [ ROW('W1 materiality and source-family decision') ],
      [
        STAT(6, 'All-source durable active ms/hour', 'I4 strain denominator; occupancy, not CPU.', Q.all_source_active_ms_per_hour, 'ms'),
        STAT(6, 'All-source durable bytes/hour', 'I2 + I3 volume denominator.', Q.all_source_bytes_per_hour, 'bytes'),
        STAT(6, 'Excluded-family bytes/hour', 'Background, VM/SWM recovery, and control-plane traffic.', Q.excluded_bytes_per_hour, 'bytes'),
        STAT(6, 'Excluded-family active ms/hour', 'Reported separately; never eligible for the shadow decision.', Q.excluded_active_ms_per_hour, 'ms'),
      ],
      [
        STAT(4, 'Eligible active share', 'Foreground + recurring share of all-source active occupancy; must reach 30%.', Q.eligible_active_share, 'percentunit', MIN_GATE(0.30)),
        STAT(5, 'Foreground share — bytes', 'A candidate family must reach 60% on both axes.', Q.foreground_bytes_share, 'percentunit'),
        STAT(5, 'Foreground share — active ms', 'A candidate family must reach 60% on both axes.', Q.foreground_active_share, 'percentunit'),
        STAT(5, 'Recurring share — bytes', 'A candidate family must reach 60% on both axes.', Q.recurring_bytes_share, 'percentunit'),
        STAT(5, 'Recurring share — active ms', 'A candidate family must reach 60% on both axes.', Q.recurring_active_share, 'percentunit'),
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
    syncCost: buildSyncCostDashboard(nodeProfile, NODE_IDENTITY),
    traces: buildTracesDashboard(NODE_IDENTITY),
  };
};

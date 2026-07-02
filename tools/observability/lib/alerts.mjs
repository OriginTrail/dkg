// Alert catalog for the DKG observability Grafana — the declarative
// ALERT_SPECS model plus its ONE derivation: Grafana provisioning payloads.
// The markdown documentation rendering of the same specs lives in docs.mjs;
// CLI handling and --check live in ../generate-observability.mjs.
// The datasource enum for alert specs as an explicit, validated registry —
// a typoed `ds:` value fails generation loudly instead of silently rendering
// a Prometheus-shaped rule against the VM UID. docs.mjs shares this registry
// for display names.
export const ALERT_DATASOURCES = {
  loki: { name: 'Loki' },
  vm: { name: 'VictoriaMetrics' },
};
export const alertDatasource = (spec) => {
  const d = ALERT_DATASOURCES[spec.ds];
  if (!d) throw new Error(`unknown datasource '${spec.ds}' in alert spec "${spec.title}" — known: ${Object.keys(ALERT_DATASOURCES).join(', ')}`);
  return d;
};

export const buildAlerts = ({ nodeProfile, VM_UID, LOKI_UID }) => {
  const PROM_NODE_LABEL = nodeProfile.label;
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
    { title: 'RPC credit burn spike (armed — needs nodes on a post-#1409 build)', signal: 'metrics',
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
      expr: nodeProfile.by('rate(dkg_publish_total{outcome=~"failed|error"}[15m])'),
      condition: { op: '>', value: 0.02 }, forDur: '5m', noData: 'OK',
      summary: `Node {{ $labels.${PROM_NODE_LABEL} }} publish failure rate {{ $values.B }}/s over 15m. (Silent until nodes export OTel metrics.)` },
    { title: 'Chain RPC failover exhausted on a node (armed — needs node metrics enabled)', signal: 'metrics',
      ds: 'vm', windowSec: 900,
      expr: nodeProfile.by('rate(dkg_chain_rpc_failover_total{reason="exhausted"}[15m])'),
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
    alertDatasource(s); // loud failure on a typoed enum before any rendering
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

  // The routing model in ONE place: signal -> Slack channel, contact-point
  // name, and per-signal grouping. Both the Grafana payload (contactPoints +
  // policyRoutes below) and the generated docs table (docs.mjs) derive from
  // this — a routing change cannot desynchronize payload from runbook.
  const SIGNAL_ROUTES = ['logs', 'metrics', 'traces'].map(sig => ({
    signal: sig,
    channel: `#node-${sig}`,
    contactPoint: `DKG node ${sig} (Slack)`,
    matchers: [['team', '=', 'dkg'], ['signal', '=', sig]],
    groupBy: sig === 'logs' ? ['alertname', 'service_instance_id']
      : sig === 'metrics' ? ['alertname', ...new Set(['service_instance_id', PROM_NODE_LABEL])]
      : ['alertname'],
  }));

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
    contactPoints: SIGNAL_ROUTES.map(r => ({
      name: r.contactPoint, type: 'slack',
      settings: { url: `<SLACK_WEBHOOK_NODE_${r.signal.toUpperCase()}>` }, disableResolveMessage: false,
    })),
    policyRoutes: SIGNAL_ROUTES.map(r => ({
      receiver: r.contactPoint,
      object_matchers: r.matchers,
      group_by: r.groupBy,
      group_wait: '30s', group_interval: '5m', repeat_interval: '4h', continue: false,
    })),
    rules: ALERT_SPECS.map(specToRule),
  };

  return { alerts, specs: ALERT_SPECS, routes: SIGNAL_ROUTES };
};

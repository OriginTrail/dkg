// Alert catalog for the DKG observability Grafana — one declarative model for
// rules, human Slack content, notification templates, contact points and
// policy routing. Generated JSON and operator docs derive from this file.
import {
  dkgLogStream,
  RPC_USAGE_PIPELINE,
  sumByLokiNode,
} from './queries.mjs';
import {
  DKG_NOTIFICATION_TEMPLATE,
  DKG_NOTIFICATION_TEMPLATE_NAME,
} from './notification-template.mjs';
import { INCIDENT_PANELS } from './dashboards.mjs';

export const ALERT_EVALUATION_GROUPS = [
  { name: 'dkg-node-telemetry', interval: 60 },
  { name: 'dkg-node-health', interval: 300 },
  { name: 'dkg-capacity-watch', interval: 3600 },
];

// Production roster used by the lightweight node-silence rule. Exact label
// matchers let Loki answer each 15-minute absence check from only that node's
// chunks; the previous "discover nodes from three hours of all logs" query
// exhausted the single-binary Loki process. Update this reviewed list when a
// production node is added, renamed or intentionally retired.
export const EXPECTED_LOG_NODES = [
  'Anacreon',
  'Cinna',
  'DMaaST',
  'Decentralized Science',
  'EG - Luigi',
  'Helicon',
  'Oliwav',
  'Rhodia',
  'SBB',
  'Terminus',
  'Trace Labs Node 7',
  'cosmo_cluster',
  'luna_lander',
  'saturn_station',
  'umanitek',
].map((node) => ({ node, environment: 'mainnet' }));

// The datasource registry owns each backend's complete Grafana query model.
export const ALERT_DATASOURCES = {
  loki: {
    name: 'Loki',
    uid: ({ LOKI_UID }) => LOKI_UID,
    model: (s, uid) => ({
      refId: 'A',
      expr: s.expr,
      queryType: 'range',
      intervalMs: Math.max(60000, s.windowSec * 1000),
      // Every rule immediately reduces to the latest point. Asking Loki for
      // dozens/hundreds of overlapping range-window evaluations is wasteful
      // and can time out after a cold restart; one range point is sufficient.
      maxDataPoints: s.maxDataPoints ?? 1,
      datasource: { type: 'loki', uid },
    }),
  },
  vm: {
    name: 'VictoriaMetrics',
    uid: ({ VM_UID }) => VM_UID,
    model: (s, uid) => ({
      refId: 'A',
      expr: s.expr,
      range: true,
      instant: false,
      intervalMs: Math.max(60000, s.windowSec * 1000),
      maxDataPoints: s.maxDataPoints ?? 1,
      datasource: { type: 'prometheus', uid },
    }),
  },
};

export const alertDatasource = (spec) => {
  const datasource = ALERT_DATASOURCES[spec.ds];
  if (!datasource) {
    throw new Error(
      `unknown datasource '${spec.ds}' in alert spec "${spec.title}" — known: ${Object.keys(ALERT_DATASOURCES).join(', ')}`,
    );
  }
  return datasource;
};

const humanAnnotations = ({
  title,
  what,
  affected,
  react,
  check,
  evidence,
  incident,
}) => ({
  summary: title,
  slack_title: title,
  what_happened: what,
  affected,
  react,
  check_first: check,
  evidence,
  __dashboardUid__: incident.dashboardUid,
  __panelId__: String(incident.panelId),
  ...(incident.nodeLabel
    ? { incident_node_label: incident.nodeLabel }
    : {}),
  ...(incident.level ? { incident_level: incident.level } : {}),
  ...(incident.search ? { incident_search: incident.search } : {}),
});

export const buildAlerts = ({ nodeProfile, VM_UID, LOKI_UID }) => {
  const PROM_NODE_LABEL = nodeProfile.label;
  const PROM_NODE_GROUP = `${PROM_NODE_LABEL}, deployment_environment`;
  const promByNode = (inner) => `sum by (${PROM_NODE_GROUP}) (${inner})`;

  const currentFleetCount =
    `count(sum by (service_instance_id, deployment_environment) (` +
    `count_over_time(${dkgLogStream()}[15m])))`;
  const silentNodes = EXPECTED_LOG_NODES.map(({ node, environment }) =>
    `absent_over_time(${dkgLogStream(
      `deployment_environment=${JSON.stringify(environment)}, ` +
      `service_instance_id=${JSON.stringify(node)}`,
    )}[15m])`).join(' or ');

  const storageOverloadRegex =
    'Store scheduler (queue wait timeout|queue full).*blazegraph\\.(query|update)' +
    '|Blazegraph operation exceeded its [0-9]+ms deadline';

  const rpcOneHour = sumByLokiNode(
    `sum_over_time(${dkgLogStream()}${RPC_USAGE_PIPELINE}[1h])`,
  );
  const rpcRecent = sumByLokiNode(
    `sum_over_time(${dkgLogStream()}${RPC_USAGE_PIPELINE}[15m])`,
  );

  const publishFailures = promByNode(
    'increase(dkg_publish_total{outcome=~"failed|error"}[15m])',
  );
  const publishTotal = promByNode('increase(dkg_publish_total[15m])');
  const traceFailures =
    'sum by (service_instance_id, deployment_environment) ' +
    '(increase(traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}[15m]))';
  const traceTotal =
    'sum by (service_instance_id, deployment_environment) ' +
    '(increase(traces_spanmetrics_calls_total[15m]))';

  /**
   * Priority contract:
   * P1 — immediate action, confirmed service/fleet impact or data-loss risk.
   * P2 — sustained node/component degradation that needs investigation.
   * P3 — watch item; held for the daily grouped Slack digest.
   */
  const ALERT_SPECS = [
    {
      id: 'node-silent',
      ruleGroup: 'dkg-node-health',
      title: 'Node stopped reporting',
      signal: 'logs',
      priority: 'P2',
      component: 'node',
      entityKind: 'node',
      ds: 'loki',
      windowSec: 10800,
      maxDataPoints: 1,
      // The reviewed roster makes a missing node observable without scanning
      // hours of logs. The fleet-presence guard suppresses one P2 per node
      // during a total ingest/fleet blackout; the P1 fleet rule owns that case.
      expr: `(${silentNodes}) and on() (${currentFleetCount} > 0)`,
      condition: { op: '>', value: 0 },
      forDur: '5m',
      noData: 'OK',
      annotations: humanAnnotations({
        title: 'Node {{ $labels.service_instance_id }} stopped reporting',
        what: 'No logs or health signals have been received from this node.',
        affected: 'We cannot confirm whether this node is working. Other nodes are still reporting.',
        react: 'Yes — check the node soon.',
        check: 'Confirm that the node process and telemetry exporter are running.',
        evidence: 'No signal for 15 minutes from a node in the expected production roster.',
        incident: {
          ...INCIDENT_PANELS.nodeLogs,
          nodeLabel: 'service_instance_id',
        },
      }),
    },
    {
      id: 'fleet-blackout-mainnet',
      title: 'Mainnet fleet stopped reporting',
      signal: 'logs',
      priority: 'P1',
      component: 'telemetry',
      entityKind: 'fleet',
      staticLabels: { deployment_environment: 'mainnet' },
      ds: 'loki',
      windowSec: 900,
      maxDataPoints: 1,
      expr:
        'count(sum by (service_instance_id) ' +
        '(count_over_time({service_name="dkg-node", deployment_environment="mainnet"}[15m])))',
      condition: { op: '<', value: 1 },
      forDur: '5m',
      noData: 'Alerting',
      annotations: humanAnnotations({
        title: 'MAINNET monitoring has stopped',
        what: 'Grafana has not received logs from any DKG mainnet node for 15 minutes.',
        affected: 'The whole mainnet fleet, or the monitoring pipeline.',
        react: 'Yes — check this immediately.',
        check: 'Confirm that the telemetry collector and Loki are running, then check fleet reachability.',
        evidence: '0 mainnet nodes are reporting.',
        incident: INCIDENT_PANELS.fleetPresence,
      }),
    },
    {
      id: 'storage-overloaded',
      title: 'Node storage overloaded',
      signal: 'logs',
      priority: 'P2',
      component: 'storage',
      entityKind: 'node',
      ds: 'loki',
      windowSec: 600,
      expr: sumByLokiNode(
        `count_over_time(${dkgLogStream()} |~ \`${storageOverloadRegex}\` [10m])`,
      ),
      condition: { op: '>', value: 20 },
      forDur: '10m',
      noData: 'OK',
      annotations: humanAnnotations({
        title: 'Node {{ $labels.service_instance_id }} storage is overloaded',
        what: 'Database requests are waiting too long and timing out.',
        affected: 'Random Sampling work on this node is being delayed.',
        react: 'Yes — investigate this soon.',
        check: 'Check Blazegraph health and the storage scheduler queue.',
        evidence: '{{ printf "%.0f" $values.B }} storage timeouts in 10 minutes; alert threshold is 20.',
        incident: {
          ...INCIDENT_PANELS.nodeLogs,
          nodeLabel: 'service_instance_id',
          level: 'ERROR',
          search: 'Store scheduler|Blazegraph operation',
        },
      }),
    },
    {
      id: 'rpc-usage-watch',
      ruleGroup: 'dkg-capacity-watch',
      title: 'RPC usage unusually high',
      signal: 'metrics',
      priority: 'P3',
      component: 'chain-rpc',
      entityKind: 'node',
      ds: 'loki',
      windowSec: 3600,
      // Entry requires both an elevated hour and elevated recent usage. This
      // removes the old 6k boundary flap and the 30m pending window filters
      // short bursts. P3 routing then groups persistent items into a daily post.
      expr:
        `(${rpcOneHour}) and on (service_instance_id, deployment_environment) ` +
        `((${rpcRecent}) * 4 > 7200)`,
      condition: { op: '>', value: 8000 },
      forDur: '30m',
      noData: 'OK',
      annotations: humanAnnotations({
        title: 'RPC usage is unusually high on {{ $labels.service_instance_id }}',
        what: 'This node has used more blockchain RPC requests than normal for a sustained period.',
        affected: 'No service failure is confirmed, but provider costs may increase.',
        react: 'No immediate action is required; review it in the daily summary.',
        check: 'Check which blockchain operation is generating the requests.',
        evidence: '{{ printf "%.0f" $values.B }} requests in the last hour; watch level is 8,000.',
        incident: {
          ...INCIDENT_PANELS.nodeRpcUsage,
          nodeLabel: 'service_instance_id',
        },
      }),
    },
    {
      id: 'telemetry-export-failing',
      title: 'Telemetry collector cannot export logs',
      signal: 'metrics',
      priority: 'P2',
      component: 'telemetry',
      entityKind: 'collector',
      ds: 'vm',
      windowSec: 900,
      expr: 'sum(rate(otelcol_exporter_send_failed_log_records[10m]))',
      condition: { op: '>', value: 0 },
      forDur: '10m',
      noData: 'OK',
      annotations: humanAnnotations({
        title: 'The collector is failing to send DKG logs',
        what: 'Some logs cannot be exported to Loki.',
        affected: 'Grafana may show incomplete information, but DKG nodes may still be working.',
        react: 'Yes — investigate the monitoring pipeline.',
        check: 'Check collector errors and its connection to Loki.',
        evidence: '{{ humanize $values.B }} log records per second failed to export during the last 10 minutes.',
        incident: INCIDENT_PANELS.collectorExport,
      }),
    },
    {
      id: 'telemetry-queue-critical',
      title: 'Telemetry collector queue almost full',
      signal: 'metrics',
      priority: 'P1',
      component: 'telemetry',
      entityKind: 'collector',
      ds: 'vm',
      windowSec: 900,
      expr: 'max(otelcol_exporter_queue_size / otelcol_exporter_queue_capacity)',
      condition: { op: '>', value: 0.8 },
      forDur: '10m',
      noData: 'OK',
      annotations: humanAnnotations({
        title: 'The telemetry queue is almost full',
        what: 'Grafana’s collector cannot send data quickly enough.',
        affected: 'DKG logs may soon be lost. The nodes themselves may still be working.',
        react: 'Yes — check the monitoring pipeline immediately.',
        check: 'Check the collector, Loki connection and available storage.',
        evidence: 'Collector queue is {{ humanizePercentage $values.B }} full; critical level is 80%.',
        incident: INCIDENT_PANELS.collectorQueue,
      }),
    },
    {
      id: 'publish-failures',
      title: 'Publishing failure ratio high',
      signal: 'metrics',
      priority: 'P1',
      component: 'publishing',
      entityKind: 'node',
      ds: 'vm',
      windowSec: 900,
      // A ratio without a minimum volume pages on one failure out of one. The
      // vector match returns the percentage only when at least five publishes
      // occurred in the same node/window.
      expr:
        `(100 * (${publishFailures}) / clamp_min((${publishTotal}), 1)) ` +
        `and on (${PROM_NODE_GROUP}) ((${publishTotal}) >= 5)`,
      condition: { op: '>', value: 10 },
      forDur: '5m',
      noData: 'OK',
      annotations: humanAnnotations({
        title: `Publishing is failing on node {{ $labels.${PROM_NODE_LABEL} }}`,
        what: 'A significant percentage of publish operations are failing.',
        affected: `Publishing through node {{ $labels.${PROM_NODE_LABEL} }} is unreliable.`,
        react: 'Yes — check this immediately.',
        check: 'Check failed transactions, node balance and chain RPC connectivity.',
        evidence: '{{ printf "%.1f" $values.B }}% failed in 15 minutes; minimum 5 publishes and alert level 10%.',
        incident: {
          ...INCIDENT_PANELS.publishOutcomes,
          nodeLabel: PROM_NODE_LABEL,
        },
      }),
    },
    {
      id: 'ack-quorum-failures',
      title: 'Storage ACK quorum repeatedly missed',
      signal: 'metrics',
      priority: 'P2',
      component: 'storage-ack',
      entityKind: 'node',
      ds: 'vm',
      windowSec: 900,
      expr: promByNode(
        'increase(dkg_ack_quorum_total{outcome=~"timeout|impossible"}[15m])',
      ),
      condition: { op: '>', value: 2 },
      forDur: '5m',
      noData: 'OK',
      annotations: humanAnnotations({
        title: `Node {{ $labels.${PROM_NODE_LABEL} }} is not receiving enough storage ACKs`,
        what: 'Published data is repeatedly failing to receive the required acknowledgements.',
        affected: 'Publish finalization on this node may be delayed or fail.',
        react: 'Yes — investigate this soon.',
        check: 'Check connectivity and ACK responses from the selected nodes.',
        evidence: '{{ printf "%.0f" $values.B }} ACK quorum failures in 15 minutes; alert threshold is 2.',
        incident: {
          ...INCIDENT_PANELS.ackQuorum,
          nodeLabel: PROM_NODE_LABEL,
        },
      }),
    },
    {
      id: 'rpc-failover-exhausted',
      title: 'All chain RPC providers failed',
      signal: 'metrics',
      priority: 'P1',
      component: 'chain-rpc',
      entityKind: 'node',
      ds: 'vm',
      windowSec: 300,
      expr: promByNode(
        'increase(dkg_chain_rpc_failover_total{reason="exhausted"}[5m])',
      ),
      condition: { op: '>', value: 0 },
      forDur: '1m',
      noData: 'OK',
      annotations: humanAnnotations({
        title: `Node {{ $labels.${PROM_NODE_LABEL} }} cannot connect to its blockchain`,
        what: 'Every configured chain RPC provider failed.',
        affected: 'Blockchain operations on this node cannot continue.',
        react: 'Yes — check this immediately.',
        check: 'Test the configured RPC endpoints and provider limits.',
        evidence: '{{ printf "%.0f" $values.B }} exhausted-provider event(s) in the last 5 minutes.',
        incident: {
          ...INCIDENT_PANELS.rpcFailover,
          nodeLabel: PROM_NODE_LABEL,
        },
      }),
    },
    {
      id: 'trace-errors',
      title: 'Operation trace failure ratio high',
      signal: 'traces',
      priority: 'P2',
      component: 'operations',
      entityKind: 'node',
      ds: 'vm',
      windowSec: 900,
      expr:
        `(100 * (${traceFailures}) / clamp_min((${traceTotal}), 1)) ` +
        'and on (service_instance_id, deployment_environment) ' +
        `((${traceTotal}) >= 20)`,
      condition: { op: '>', value: 10 },
      forDur: '5m',
      noData: 'OK',
      annotations: humanAnnotations({
        title: 'Operations are failing on node {{ $labels.service_instance_id }}',
        what: 'Multiple operation traces are ending with an error.',
        affected: 'Operations on this node may be unreliable.',
        react: 'Yes — investigate this soon.',
        check: 'Open the failed traces and identify the shared failing step.',
        evidence: '{{ printf "%.1f" $values.B }}% of at least 20 traces failed in 15 minutes; alert level is 10%.',
        incident: {
          ...INCIDENT_PANELS.traceErrors,
          nodeLabel: 'service_instance_id',
        },
      }),
    },
  ];

  const EXPR = '__expr__';
  const specToRule = (spec) => {
    const datasource = alertDatasource(spec);
    const datasourceUid = datasource.uid({ VM_UID, LOKI_UID });
    return {
      orgID: 1,
      folderUID: 'dkg-observability',
      ruleGroup: spec.ruleGroup ?? 'dkg-node-telemetry',
      title: spec.title,
      condition: 'C',
      data: [
        {
          refId: 'A',
          // The LogQL/PromQL expression already declares its own lookback
          // window. Grafana only needs one recent evaluation timestamp here;
          // repeating a 3h range function across a 3h outer range multiplies
          // the same Loki scan and its memory cost.
          relativeTimeRange: { from: spec.evaluationRangeSec ?? 60, to: 0 },
          datasourceUid,
          model: datasource.model(spec, datasourceUid),
        },
        {
          refId: 'B',
          relativeTimeRange: { from: 0, to: 0 },
          datasourceUid: EXPR,
          model: {
            refId: 'B',
            type: 'reduce',
            expression: 'A',
            reducer: 'last',
            datasource: { type: EXPR, uid: EXPR },
          },
        },
        {
          refId: 'C',
          relativeTimeRange: { from: 0, to: 0 },
          datasourceUid: EXPR,
          model: {
            refId: 'C',
            type: 'math',
            expression: `$B ${spec.condition.op} ${spec.condition.value}`,
            datasource: { type: EXPR, uid: EXPR },
          },
        },
      ],
      noDataState: spec.noData,
      // A broken query must not become a false human incident. Query health is
      // verified separately by CI/import and Grafana exposes evaluation errors.
      execErrState: 'KeepLast',
      for: spec.forDur,
      labels: {
        team: 'dkg',
        signal: spec.signal,
        priority: spec.priority,
        component: spec.component,
        entity_kind: spec.entityKind,
        alert_id: spec.id,
        ...(spec.staticLabels ?? {}),
      },
      annotations: spec.annotations,
    };
  };

  const actionablePriorities = ['priority', '=~', 'P1|P2'];
  const baseRoutes = ['logs', 'metrics', 'traces'].map((signal) => ({
    id: `${signal}-actionable`,
    signal,
    priorities: 'P1/P2',
    channel: `#node-${signal}`,
    contactPoint: `DKG node ${signal} (Slack)`,
    matchers: [
      ['team', '=', 'dkg'],
      ['signal', '=', signal],
      actionablePriorities,
    ],
    // The signal matcher already separates Slack channels. Environment is the
    // only notification-group dimension so alerts which begin or recover
    // together become one readable Slack post instead of a message per rule,
    // priority or node.
    groupBy: ['deployment_environment'],
    groupWait: '30s',
    groupInterval: '5m',
    repeatInterval: '4h',
  }));

  const P3_ROUTE = {
    id: 'metrics-daily-watch',
    signal: 'metrics',
    priorities: 'P3',
    channel: '#node-metrics',
    contactPoint: 'DKG node metrics (Slack)',
    matchers: [
      ['team', '=', 'dkg'],
      ['priority', '=', 'P3'],
    ],
    // One grouped daily post for a sustained watch condition; individual node
    // churn cannot create the old 15-minute stream of RPC notifications.
    groupBy: ['deployment_environment'],
    groupWait: '24h',
    groupInterval: '24h',
    repeatInterval: '24h',
  };
  const SIGNAL_ROUTES = [...baseRoutes, P3_ROUTE];

  const contactSignals = ['logs', 'metrics', 'traces'];
  const alerts = {
    _readme: [
      'Secret-free mirror of DKG Grafana alerting. GENERATED — edit lib/alerts.mjs and lib/notification-template.mjs.',
      'The committed artifact keeps datasource and Slack webhook placeholders. Render a live payload with generate-observability.mjs.',
      'The apply script preserves existing Slack webhook secrets, backs up live state, upserts generated resources, removes the explicitly listed legacy rules, and verifies the result.',
      `Human incident contract: ${ALERT_SPECS.length} event-specific rules; P1/P2 real-time, sustained P3 grouped daily; no generic ERROR/WARN paging.`,
    ],
    evaluationGroups: ALERT_EVALUATION_GROUPS,
    notificationTemplates: [
      { name: DKG_NOTIFICATION_TEMPLATE_NAME, template: DKG_NOTIFICATION_TEMPLATE },
    ],
    contactPoints: contactSignals.map((signal) => ({
      name: `DKG node ${signal} (Slack)`,
      type: 'slack',
      settings: {
        url: `<SLACK_WEBHOOK_NODE_${signal.toUpperCase()}>`,
        title: '{{ template "dkg.title" . }}',
        text: '{{ template "dkg.body" . }}',
      },
      disableResolveMessage: false,
    })),
    policyRoutes: SIGNAL_ROUTES.map((route) => ({
      receiver: route.contactPoint,
      object_matchers: route.matchers,
      group_by: route.groupBy,
      group_wait: route.groupWait,
      group_interval: route.groupInterval,
      repeat_interval: route.repeatInterval,
      continue: false,
    })),
    rules: ALERT_SPECS.map(specToRule),
  };

  return { alerts, specs: ALERT_SPECS, routes: SIGNAL_ROUTES };
};

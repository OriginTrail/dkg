import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAlerts, EXPECTED_LOG_NODES } from './lib/alerts.mjs';
import {
  buildDashboards,
  INCIDENT_PANELS,
} from './lib/dashboards.mjs';
import { promNodeProfile } from './lib/profile.mjs';
import {
  DKG_NOTIFICATION_TEMPLATE,
  renderSlackGroupPreview,
  renderSlackPreview,
} from './lib/notification-template.mjs';

const nodeProfile = promNodeProfile('instance');
const { alerts, specs, routes } = buildAlerts({
  nodeProfile,
  VM_UID: 'vm-test',
  LOKI_UID: 'loki-test',
});
const dashboards = buildDashboards({ nodeProfile });

const requiredAnnotations = [
  'slack_title',
  'what_happened',
  'affected',
  'react',
  'check_first',
  'evidence',
  '__dashboardUid__',
  '__panelId__',
];

test('catalog has a stable unique event-specific inventory', () => {
  assert.equal(specs.length, 10);
  assert.equal(new Set(specs.map((spec) => spec.id)).size, specs.length);
  assert.equal(new Set(specs.map((spec) => spec.title)).size, specs.length);
  assert.equal(specs.some((spec) => /Error spike|Warn spike/.test(spec.title)), false);
  assert.deepEqual(new Set(specs.map((spec) => spec.priority)), new Set(['P1', 'P2', 'P3']));
});

test('every rule supplies the complete human response contract without ownership text', () => {
  for (const spec of specs) {
    for (const key of requiredAnnotations) {
      assert.ok(spec.annotations[key], `${spec.id} missing ${key}`);
    }
    const text = JSON.stringify(spec.annotations);
    assert.doesNotMatch(text, /who owns|owner|owned by/i, `${spec.id} contains ownership text`);
    assert.doesNotMatch(
      text,
      /runbook_url|dashboard_url|logs_url/i,
      `${spec.id} contains a retired broad link`,
    );
    assert.match(spec.annotations.react, /Yes|No immediate/i, `${spec.id} react answer is ambiguous`);
    assert.doesNotMatch(
      spec.annotations.evidence,
      /\$values\.B(?!\.Value)/,
      `${spec.id} formats the Grafana expression object instead of its numeric Value`,
    );
    assert.match(spec.annotations.__dashboardUid__, /^dkg-/);
    assert.match(spec.annotations.__panelId__, /^[1-9][0-9]*$/);
  }
});

test('every linked incident panel has a stable ID and the expected purpose', () => {
  const byUid = Object.fromEntries(
    Object.values(dashboards).map((dashboard) => [dashboard.uid, dashboard]),
  );
  const expectedTitles = new Map([
    [INCIDENT_PANELS.fleetPresence, 'Nodes reporting (last 10m)'],
    [INCIDENT_PANELS.nodeLogs, 'Logs — $node'],
    [INCIDENT_PANELS.nodeRpcUsage, 'RPC requests by method — $node'],
    [INCIDENT_PANELS.publishOutcomes, 'Publish rate by outcome'],
    [INCIDENT_PANELS.ackQuorum, 'ACK quorum outcomes'],
    [INCIDENT_PANELS.rpcFailover, 'RPC endpoint failover exhaustion'],
    [INCIDENT_PANELS.collectorExport, 'Collector log records/s: accepted vs exported'],
    [INCIDENT_PANELS.collectorQueue, 'Collector exporter queue'],
    [INCIDENT_PANELS.traceErrors, 'Errored operations'],
  ]);
  for (const [incident, expectedTitle] of expectedTitles) {
    const dashboard = byUid[incident.dashboardUid];
    assert.ok(dashboard, `missing dashboard ${incident.dashboardUid}`);
    const ids = dashboard.panels.map((panel) => panel.id);
    assert.equal(new Set(ids).size, ids.length, `${dashboard.uid} has duplicate panel IDs`);
    const panel = dashboard.panels.find(({ id }) => id === incident.panelId);
    assert.equal(
      panel?.title,
      expectedTitle,
      `${incident.dashboardUid} panel ${incident.panelId} drifted`,
    );
  }
});

test('known false-positive and noise controls are encoded in queries', () => {
  const byId = Object.fromEntries(specs.map((spec) => [spec.id, spec]));
  assert.match(byId['node-silent'].expr, /and on\(\)/);
  assert.match(byId['node-silent'].expr, /absent_over_time/);
  assert.doesNotMatch(byId['node-silent'].expr, /\[3h\]|offset/);
  assert.equal(EXPECTED_LOG_NODES.length, 15);
  assert.equal(
    new Set(EXPECTED_LOG_NODES.map(({ node, environment }) => `${environment}/${node}`)).size,
    EXPECTED_LOG_NODES.length,
  );
  assert.match(byId['storage-overloaded'].expr, /Store scheduler/);
  assert.match(byId['storage-overloaded'].expr, /Blazegraph operation/);
  assert.match(byId['rpc-usage-watch'].expr, /> 7200/);
  assert.equal(byId['rpc-usage-watch'].condition.value, 8000);
  assert.equal(byId['rpc-usage-watch'].forDur, '30m');
  assert.match(byId['publish-failures'].expr, />= 5/);
  assert.match(byId['publish-failures'].expr, /failed\|error/);
  assert.match(byId['ack-quorum-failures'].expr, /timeout\|impossible/);
  assert.match(byId['rpc-failover-exhausted'].expr, /reason="exhausted"/);
});

test('query evaluation cadence keeps expensive watches out of the one-minute loop', () => {
  assert.deepEqual(alerts.evaluationGroups, [
    { name: 'dkg-node-telemetry', interval: 60 },
    { name: 'dkg-node-health', interval: 300 },
    { name: 'dkg-capacity-watch', interval: 3600 },
  ]);
  const rulesById = Object.fromEntries(
    alerts.rules.map((rule) => [rule.labels.alert_id, rule]),
  );
  assert.equal(rulesById['node-silent'].ruleGroup, 'dkg-node-health');
  assert.equal(rulesById['rpc-usage-watch'].ruleGroup, 'dkg-capacity-watch');
  for (const rule of alerts.rules) {
    assert.deepEqual(rule.data[0].relativeTimeRange, { from: 60, to: 0 });
    if (!['node-silent', 'rpc-usage-watch'].includes(rule.labels.alert_id)) {
      assert.equal(rule.ruleGroup, 'dkg-node-telemetry');
    }
  }
});

test('alerts and recoveries aggregate by channel and environment', () => {
  const actionRoutes = routes.filter((route) => route.priorities === 'P1/P2');
  assert.equal(actionRoutes.length, 3);
  for (const route of actionRoutes) {
    assert.equal(route.groupWait, '30s');
    assert.equal(route.groupInterval, '5m');
    assert.equal(route.repeatInterval, '4h');
    assert.deepEqual(route.groupBy, ['deployment_environment']);
  }
  const p3 = routes.find((route) => route.priorities === 'P3');
  assert.ok(p3);
  assert.equal(p3.groupWait, '24h');
  assert.equal(p3.groupInterval, '24h');
  assert.equal(p3.repeatInterval, '24h');
  assert.deepEqual(p3.groupBy, ['deployment_environment']);
});

test('Slack groups related firing and recovery alerts with exact incident links', () => {
  const annotations = {
    slack_title: 'Cinna storage is overloaded',
    what_happened: 'Database requests are timing out.',
    affected: 'Random Sampling is delayed.',
    react: 'Yes — investigate this soon.',
    check_first: 'Check Blazegraph and the storage queue.',
    evidence: '95 timeouts in 10 minutes.',
    __dashboardUid__: 'dkg-node-logs',
    __panelId__: '1',
    incident_node_label: 'service_instance_id',
    incident_level: 'ERROR',
    incident_search: 'Store scheduler|Blazegraph operation',
  };
  const panelUrl =
    'http://localhost:3000/d/dkg-node-logs?orgId=1&viewPanel=1';
  const common = {
    labels: {
      priority: 'P2',
      deployment_environment: 'mainnet',
      service_instance_id: 'Trace Labs Node 7',
    },
    annotations,
    panelUrl,
    startsAt: 1720000000000,
    endsAt: 1720000900000,
  };
  const grouped = renderSlackGroupPreview({
    firing: [
      common,
      {
        ...common,
        labels: { ...common.labels, priority: 'P1' },
        annotations: {
          ...annotations,
          slack_title: 'Publishing is failing',
        },
      },
    ],
    resolved: [
      common,
      {
        ...common,
        annotations: {
          ...annotations,
          slack_title: 'RPC providers recovered',
        },
      },
    ],
  });
  for (const phrase of [
    '2 active DKG incidents',
    '2 recovered DKG incidents',
    '[P2 — ACTION]',
    'What happened:',
    'Affected:',
    'React:',
    'Check first:',
    'Evidence:',
    'Open exact incident',
    '[RECOVERED][P2]',
  ]) {
    assert.match(grouped, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(grouped, /from=1719996400000/);
  assert.match(grouped, /to=now/);
  assert.match(grouped, /to=1720000900000/);
  assert.match(grouped, /viewPanel=1/);
  assert.match(grouped, /var-node=Trace\+Labs\+Node\+7/);
  assert.match(grouped, /var-level=ERROR/);
  assert.match(grouped, /var-search=Store\+scheduler%7CBlazegraph\+operation/);
  assert.match(grouped, /No immediate action is required/);
  assert.doesNotMatch(grouped, /issue lasted|lasted 0s/i);
  assert.doesNotMatch(
    grouped,
    /localhost|owner|runbook|Open dashboard|Open logs/i,
  );
});

test('single-alert preview remains a grouped one-incident message', () => {
  const preview = renderSlackPreview({
    status: 'firing',
    labels: { priority: 'P1', deployment_environment: 'mainnet' },
    annotations: {
      slack_title: 'Publishing is failing',
      what_happened: 'Publishes failed.',
      __dashboardUid__: 'dkg-node-metrics',
      __panelId__: '3',
    },
    panelUrl:
      'http://localhost:3000/d/dkg-node-metrics?orgId=1&viewPanel=3',
  });
  assert.match(preview, /1 active DKG incident/);
});

test('Grafana template uses grouped exact links and avoids retired wording', () => {
  assert.match(DKG_NOTIFICATION_TEMPLATE, /define "dkg\.title" \}\}\{\{ end/);
  assert.match(DKG_NOTIFICATION_TEMPLATE, /len \.Alerts\.Firing/);
  assert.match(DKG_NOTIFICATION_TEMPLATE, /len \.Alerts\.Resolved/);
  assert.match(DKG_NOTIFICATION_TEMPLATE, /\.PanelURL/);
  assert.match(DKG_NOTIFICATION_TEMPLATE, /\.StartsAt\.Add/);
  assert.match(DKG_NOTIFICATION_TEMPLATE, /\.EndsAt\.UnixMilli/);
  assert.match(DKG_NOTIFICATION_TEMPLATE, /urlquery/);
  assert.match(DKG_NOTIFICATION_TEMPLATE, /Open exact incident/);
  assert.doesNotMatch(DKG_NOTIFICATION_TEMPLATE, /\.EndsAt\.Sub \.StartsAt/);
  assert.doesNotMatch(
    DKG_NOTIFICATION_TEMPLATE,
    /node\(s\) affected|Who owns|runbook_url|dashboard_url|logs_url|Open dashboard|Open logs|Runbook/i,
  );
  assert.equal(alerts.notificationTemplates.length, 1);
  for (const contact of alerts.contactPoints) {
    assert.equal(contact.settings.title, '{{ template "dkg.title" . }}');
    assert.equal(contact.settings.text, '{{ template "dkg.body" . }}');
    assert.match(contact.settings.url, /^<SLACK_WEBHOOK_NODE_/);
  }
});

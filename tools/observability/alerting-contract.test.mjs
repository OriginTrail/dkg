import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAlerts, EXPECTED_LOG_NODES } from './lib/alerts.mjs';
import { promNodeProfile } from './lib/profile.mjs';
import {
  DKG_NOTIFICATION_TEMPLATE,
  renderSlackPreview,
} from './lib/notification-template.mjs';

const { alerts, specs, routes } = buildAlerts({
  nodeProfile: promNodeProfile('instance'),
  VM_UID: 'vm-test',
  LOKI_UID: 'loki-test',
});

const requiredAnnotations = [
  'slack_title',
  'what_happened',
  'affected',
  'react',
  'check_first',
  'evidence',
  'dashboard_url',
  'runbook_url',
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
    assert.match(spec.annotations.react, /Yes|No immediate/i, `${spec.id} react answer is ambiguous`);
    assert.match(spec.annotations.dashboard_url, /^http:\/\/100\.81\.85\.62:3000\//);
    assert.match(spec.annotations.runbook_url, /^https:\/\/github\.com\/OriginTrail\/dkg\//);
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

test('P1/P2 are real-time per incident while P3 is one delayed grouped route', () => {
  const actionRoutes = routes.filter((route) => route.priorities === 'P1/P2');
  assert.equal(actionRoutes.length, 3);
  for (const route of actionRoutes) {
    assert.equal(route.groupWait, '30s');
    assert.equal(route.groupInterval, '5m');
    assert.equal(route.repeatInterval, '4h');
    assert.ok(route.groupBy.includes('alertname'));
    assert.ok(route.groupBy.includes('priority'));
    assert.ok(route.groupBy.includes('deployment_environment'));
    assert.ok(
      route.groupBy.includes('service_instance_id') || route.groupBy.includes('instance'),
      `${route.id} is not grouped by node`,
    );
  }
  const p3 = routes.find((route) => route.priorities === 'P3');
  assert.ok(p3);
  assert.equal(p3.groupWait, '24h');
  assert.equal(p3.groupInterval, '24h');
  assert.equal(p3.repeatInterval, '24h');
  assert.equal(p3.groupBy.includes('service_instance_id'), false);
});

test('Slack firing and recovery previews are readable and complete', () => {
  const annotations = {
    slack_title: 'Cinna storage is overloaded',
    what_happened: 'Database requests are timing out.',
    affected: 'Random Sampling is delayed.',
    react: 'Yes — investigate this soon.',
    check_first: 'Check Blazegraph and the storage queue.',
    evidence: '95 timeouts in 10 minutes.',
    dashboard_url: 'http://100.81.85.62:3000/d/dkg-node-logs',
    logs_url: 'http://100.81.85.62:3000/d/dkg-node-logs?var-level=ERROR',
    runbook_url: 'https://github.com/OriginTrail/dkg/blob/main/tools/observability/RUNBOOK.md',
  };
  const firing = renderSlackPreview({
    status: 'firing',
    labels: { priority: 'P2', deployment_environment: 'mainnet' },
    annotations,
  });
  for (const phrase of [
    '[P2 — ACTION]',
    'What happened:',
    'Affected:',
    'React:',
    'Check first:',
    'Evidence:',
    'Open dashboard',
    'Open logs',
    'Runbook',
  ]) {
    assert.match(firing, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(firing, /localhost|owner/i);

  const recovered = renderSlackPreview({
    status: 'resolved',
    labels: { priority: 'P2', deployment_environment: 'mainnet' },
    annotations,
    duration: '18m0s',
  });
  assert.match(recovered, /\[RECOVERED\]\[P2\]/);
  assert.match(recovered, /lasted 18m0s/);
  assert.match(recovered, /No immediate action is required/);
});

test('Grafana template avoids the broken localhost title and generic node wording', () => {
  assert.match(DKG_NOTIFICATION_TEMPLATE, /define "dkg\.title" \}\}\{\{ end/);
  assert.doesNotMatch(DKG_NOTIFICATION_TEMPLATE, /localhost|node\(s\) affected|Who owns/i);
  assert.equal(alerts.notificationTemplates.length, 1);
  for (const contact of alerts.contactPoints) {
    assert.equal(contact.settings.title, '{{ template "dkg.title" . }}');
    assert.equal(contact.settings.text, '{{ template "dkg.body" . }}');
    assert.match(contact.settings.url, /^<SLACK_WEBHOOK_NODE_/);
  }
});

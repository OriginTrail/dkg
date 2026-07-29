#!/usr/bin/env node
/**
 * Validate and apply the generated DKG alerting contract to a live Grafana.
 *
 * Safe defaults:
 *   - without --apply this is read-only (backup + datasource query validation);
 *   - the API token is read from a 0600 file, never accepted on the command line;
 *   - existing Slack webhook values are preserved server-side;
 *   - unrelated rules, routes, templates and contact points are untouched;
 *   - all generated queries are evaluated successfully before the first write.
 *
 * Example:
 *   node tools/observability/apply-grafana-alerting.mjs \
 *     --url http://100.81.85.62:3000 \
 *     --token-file /tmp/grafana-token \
 *     --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildAlerts } from './lib/alerts.mjs';
import { promNodeProfile } from './lib/profile.mjs';

const usage =
  'usage: node apply-grafana-alerting.mjs --url <grafana-url> --token-file <0600-file> ' +
  '[--vm-uid <uid>] [--loki-uid <uid>] [--prom-node-label <label>] [--backup-dir <dir>] [--apply]';

function parseArgs(argv) {
  const options = {};
  const valueFlags = new Set([
    '--url',
    '--token-file',
    '--vm-uid',
    '--loki-uid',
    '--prom-node-label',
    '--backup-dir',
  ]);
  const boolFlags = new Set(['--apply']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (boolFlags.has(flag)) {
      options[flag] = true;
      continue;
    }
    if (!valueFlags.has(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(usage);
    }
    options[flag] = argv[++i];
  }
  if (!options['--url'] || !options['--token-file']) throw new Error(usage);
  return options;
}

const options = parseArgs(process.argv.slice(2));
const baseUrl = options['--url'].replace(/\/+$/, '');
const tokenPath = path.resolve(options['--token-file']);
const tokenStat = fs.statSync(tokenPath);
if ((tokenStat.mode & 0o077) !== 0) {
  throw new Error(`token file must not be group/world accessible: ${tokenPath}`);
}
const token = fs.readFileSync(tokenPath, 'utf8').trim();
if (!token) throw new Error('token file is empty');

async function api(method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Disable-Provenance': 'true',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Some successful Grafana provisioning endpoints return plain text.
  }
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed (${response.status}): ${String(text).slice(0, 3000)}`);
  }
  return parsed;
}

const snapshotPaths = [
  '/api/v1/provisioning/alert-rules',
  '/api/v1/provisioning/contact-points',
  '/api/v1/provisioning/policies',
  '/api/v1/provisioning/templates',
  '/api/datasources',
  '/api/frontend/settings',
  '/api/health',
];

const before = {};
for (const pathname of snapshotPaths) before[pathname] = await api('GET', pathname);
const backupDir = path.resolve(options['--backup-dir'] ?? '/tmp');
fs.mkdirSync(backupDir, { recursive: true });
const timestamp = new Date().toISOString().replaceAll(':', '-');
const backupPath = path.join(backupDir, `dkg-grafana-alerting-${timestamp}.json`);
fs.writeFileSync(backupPath, `${JSON.stringify(before, null, 2)}\n`, { mode: 0o600 });

const datasources = before['/api/datasources'];
const datasourceUid = (type, explicit) => {
  if (explicit) return explicit;
  const matches = datasources.filter((entry) => entry.type === type);
  if (matches.length !== 1) {
    throw new Error(`expected one ${type} datasource, found ${matches.length}; pass its UID explicitly`);
  }
  return matches[0].uid;
};
const VM_UID = datasourceUid('prometheus', options['--vm-uid']);
const LOKI_UID = datasourceUid('loki', options['--loki-uid']);
const nodeProfile = promNodeProfile(options['--prom-node-label'] ?? 'instance');
const { alerts, specs } = buildAlerts({ nodeProfile, VM_UID, LOKI_UID });

async function validateQueries() {
  const failures = [];
  for (const rule of alerts.rules) {
    const query = {
      ...rule.data[0].model,
      refId: 'A',
      datasource: rule.data[0].model.datasource,
    };
    const result = await api('POST', '/api/ds/query', {
      from: String(Date.now() - rule.data[0].relativeTimeRange.from * 1000),
      to: String(Date.now()),
      queries: [query],
    });
    const queryResult = result?.results?.A;
    if (!queryResult || queryResult.error || queryResult.status === 500) {
      failures.push(`${rule.title}: ${queryResult?.error ?? 'missing query result'}`);
    }
  }
  if (failures.length) {
    throw new Error(`live query validation failed:\n${failures.map((failure) => `  - ${failure}`).join('\n')}`);
  }
}

await validateQueries();
console.log(`backup: ${backupPath}`);
console.log(`validated ${alerts.rules.length} live queries (Loki=${LOKI_UID}, VM=${VM_UID})`);

if (!options['--apply']) {
  console.log('read-only validation complete; pass --apply to change Grafana');
  process.exit(0);
}

const templatesBefore = before['/api/v1/provisioning/templates'];
for (const template of alerts.notificationTemplates) {
  await api(
    'PUT',
    `/api/v1/provisioning/templates/${encodeURIComponent(template.name)}`,
    { template: template.template },
  );
}

const contactsBefore = before['/api/v1/provisioning/contact-points'];
for (const generated of alerts.contactPoints) {
  const current = contactsBefore.find((contact) => contact.name === generated.name);
  if (!current?.uid) {
    throw new Error(`contact point "${generated.name}" is missing; refusing to create it without its Slack secret`);
  }
  const preservedUrl = current.settings?.url;
  if (!preservedUrl || /^<SLACK_WEBHOOK_/.test(preservedUrl)) {
    throw new Error(`contact point "${generated.name}" has no existing secure Slack URL to preserve`);
  }
  await api(
    'PUT',
    `/api/v1/provisioning/contact-points/${encodeURIComponent(current.uid)}`,
    {
      ...current,
      name: generated.name,
      type: generated.type,
      disableResolveMessage: generated.disableResolveMessage,
      settings: { ...generated.settings, url: preservedUrl },
    },
  );
}

const policyBefore = before['/api/v1/provisioning/policies'];
const isDkgRoute = (route) =>
  (route.object_matchers ?? []).some(([key, operator, value]) =>
    key === 'team' && operator === '=' && value === 'dkg');
const policyAfter = {
  ...policyBefore,
  routes: [
    ...(policyBefore.routes ?? []).filter((route) => !isDkgRoute(route)),
    ...alerts.policyRoutes,
  ],
};
await api('PUT', '/api/v1/provisioning/policies', policyAfter);

const rulesBefore = before['/api/v1/provisioning/alert-rules'];
const dkgRule = (rule) =>
  rule.folderUID === 'dkg-observability' &&
  rule.labels?.team === 'dkg';
const currentDkgRules = rulesBefore.filter(dkgRule);
const consumedUids = new Set();

for (const generated of alerts.rules) {
  const current = currentDkgRules.find((rule) =>
    rule.labels?.alert_id === generated.labels.alert_id || rule.title === generated.title);
  if (current) {
    consumedUids.add(current.uid);
    await api(
      'PUT',
      `/api/v1/provisioning/alert-rules/${encodeURIComponent(current.uid)}`,
      { ...generated, uid: current.uid },
    );
  } else {
    const created = await api('POST', '/api/v1/provisioning/alert-rules', generated);
    if (created?.uid) consumedUids.add(created.uid);
  }
}

for (const legacy of currentDkgRules) {
  if (!consumedUids.has(legacy.uid)) {
    await api(
      'DELETE',
      `/api/v1/provisioning/alert-rules/${encodeURIComponent(legacy.uid)}`,
    );
  }
}

// Keep expensive presence/capacity queries away from the one-minute incident
// loop. Updating a group interval does not replace or rewrite its rules.
for (const group of alerts.evaluationGroups) {
  await api(
    'PUT',
    `/api/v1/provisioning/folder/dkg-observability/rule-groups/${encodeURIComponent(group.name)}`,
    { interval: group.interval },
  );
}

// Read back and compare the surfaces that are fully controlled here. Grafana
// adds IDs/timestamps, so verification intentionally compares semantic fields.
const after = {
  rules: await api('GET', '/api/v1/provisioning/alert-rules'),
  contacts: await api('GET', '/api/v1/provisioning/contact-points'),
  policies: await api('GET', '/api/v1/provisioning/policies'),
  templates: await api('GET', '/api/v1/provisioning/templates'),
  groups: await Promise.all(
    alerts.evaluationGroups.map((group) =>
      api(
        'GET',
        `/api/v1/provisioning/folder/dkg-observability/rule-groups/${encodeURIComponent(group.name)}`,
      )),
  ),
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};
const semanticallyEqual = (left, right) =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

const liveDkgRules = after.rules.filter(dkgRule);
const expectedIds = new Set(specs.map((spec) => spec.id));
const liveIds = new Set(liveDkgRules.map((rule) => rule.labels?.alert_id));
if (
  liveDkgRules.length !== expectedIds.size ||
  [...expectedIds].some((id) => !liveIds.has(id))
) {
  throw new Error(
    `rule read-back mismatch: expected ${[...expectedIds].join(', ')}, got ${[...liveIds].join(', ')}`,
  );
}
for (const expected of alerts.rules) {
  const live = liveDkgRules.find((rule) => rule.labels.alert_id === expected.labels.alert_id);
  const comparable = (rule) => ({
    title: rule.title,
    ruleGroup: rule.ruleGroup,
    for: rule.for,
    noDataState: rule.noDataState,
    execErrState: rule.execErrState,
    labels: rule.labels,
    annotations: rule.annotations,
    query: {
      relativeTimeRange: rule.data?.[0]?.relativeTimeRange,
      datasourceUid: rule.data?.[0]?.datasourceUid,
      modelDatasource: rule.data?.[0]?.model?.datasource,
      expr: rule.data?.[0]?.model?.expr,
      queryType: rule.data?.[0]?.model?.queryType,
      intervalMs: rule.data?.[0]?.model?.intervalMs,
      maxDataPoints: rule.data?.[0]?.model?.maxDataPoints,
      range: rule.data?.[0]?.model?.range,
      instant: rule.data?.[0]?.model?.instant,
    },
    reducer: rule.data?.[1]?.model?.reducer,
    condition: rule.data?.[2]?.model?.expression,
  });
  if (!semanticallyEqual(comparable(live), comparable(expected))) {
    throw new Error(`rule read-back differs from generated contract: ${expected.title}`);
  }
}

for (const expected of alerts.notificationTemplates) {
  const live = after.templates.find((template) => template.name === expected.name);
  if (live?.template !== expected.template) {
    throw new Error(`notification template read-back differs: ${expected.name}`);
  }
}
for (const expected of alerts.contactPoints) {
  const live = after.contacts.find((contact) => contact.name === expected.name);
  if (
    live?.settings?.title !== expected.settings.title ||
    live?.settings?.text !== expected.settings.text ||
    live?.disableResolveMessage !== false
  ) {
    throw new Error(`contact-point read-back differs: ${expected.name}`);
  }
}

for (const expected of alerts.evaluationGroups) {
  const live = after.groups.find((group) => group.title === expected.name);
  if (live?.interval !== expected.interval) {
    throw new Error(
      `evaluation-group read-back differs: ${expected.name} expected ${expected.interval}s, got ${live?.interval}`,
    );
  }
}

const liveDkgRoutes = (after.policies.routes ?? []).filter(isDkgRoute);
const durationSeconds = (duration) => {
  const match = /^(\d+)(s|m|h|d)$/.exec(duration);
  if (!match) return duration;
  return Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
};
const normalizeRoute = (route) => ({
  receiver: route.receiver,
  matchers: [...(route.object_matchers ?? [])]
    .map((matcher) => [...matcher])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  groupBy: route.group_by ?? [],
  groupWaitSeconds: durationSeconds(route.group_wait),
  groupIntervalSeconds: durationSeconds(route.group_interval),
  repeatIntervalSeconds: durationSeconds(route.repeat_interval),
  continue: Boolean(route.continue),
});
if (!semanticallyEqual(
  liveDkgRoutes.map(normalizeRoute),
  alerts.policyRoutes.map(normalizeRoute),
)) {
  throw new Error('notification-policy read-back differs from generated routes');
}

console.log(
  `applied and verified: ${liveDkgRules.length} rules, ` +
  `${alerts.notificationTemplates.length} template, ${alerts.contactPoints.length} contact points, ` +
  `${alerts.policyRoutes.length} routes`,
);

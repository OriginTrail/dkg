#!/usr/bin/env node
// Parse-based verifier for rendered observability artifacts — the CI gate for
// the operator-facing render modes of generate-observability.mjs.
//
//   node verify-profile-render.mjs <dir> --prom-node-label <label>
//                                  [--vm-uid <uid>] [--loki-uid <uid>]
//
// Unlike a sampling grep, this loads the rendered JSON and asserts the WHOLE
// profile-sensitive surface:
//   - every metrics-dashboard target that reads a dkg_* metric carries the
//     profiled node filter `<label>=~"${node:regex}"`;
//   - the metrics $node variable discovers nodes via the profiled label;
//   - per-node alert expressions group by the profiled label and their
//     summaries reference `$labels.<label>`;
//   - actionable notification routes aggregate by environment rather than
//     splitting by alert, priority or node identity;
//   - when the profile is NOT the default, no unprofiled `instance` label
//     survives anywhere in a label-position (matcher, group-by, legend,
//     label_values, $labels.) across the metrics dashboard and the
//     Prometheus-backed alert rules;
//   - every alert rule's query block uses the expected datasource UID
//     consistently in BOTH `datasourceUid` and `model.datasource.uid`
//     (catches partial substitution), and a concrete --vm-uid render must
//     not leak the `<VM_DATASOURCE_UID>` placeholder anywhere;
//   - contact points carry `<SLACK_WEBHOOK_*>` placeholders, never a real
//     webhook URL.
// All violations are collected and reported together; any violation exits 1.
import fs from 'node:fs';
import path from 'node:path';
import { assertPromLabel, parseCliArgs } from './lib/cli.mjs';

const usage = 'usage: node verify-profile-render.mjs <dir> --prom-node-label <label> [--vm-uid <uid>] [--loki-uid <uid>]';
const opts = parseCliArgs({
  argv: process.argv.slice(2),
  usage,
  valueFlags: ['--prom-node-label', '--vm-uid', '--loki-uid'],
});
if (!opts.positional || !opts['--prom-node-label']) { console.error(usage); process.exit(1); }
const DIR = opts.positional;
const LABEL = opts['--prom-node-label'];
// shared validation (lib/cli.mjs): a malformed label is a usage error here
// too, not a raw RegExp SyntaxError from a detector below
assertPromLabel(LABEL, usage);
const VM_UID = opts['--vm-uid'] ?? '<VM_DATASOURCE_UID>';
const LOKI_UID = opts['--loki-uid'] ?? 'loki';
const DEFAULT_LABEL = 'instance';
const profiled = LABEL !== DEFAULT_LABEL;

const violations = [];
const fail = (where, msg) => violations.push(`${where}: ${msg}`);
const load = (file) => JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));

// ── label-position detectors (word-boundary safe: `instance` must not match
//    inside `service_instance_id`) ─────────────────────────────────────────
// Labels are already validated as identifier-only at the CLI boundary, but
// escape regex metacharacters anyway before interpolating into patterns —
// a provable non-injection rather than an implied one (CodeQL js/regex-injection).
const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelMatcherRe = (label) => new RegExp(`(^|[^A-Za-z0-9_])${reEscape(label)}\\s*(=~|!~|!=|=)`);
// every PromQL clause that names labels: aggregation grouping AND vector
// matching/joining — `on(instance)` or `group_left(instance)` is just as
// unprofiled as `by (instance)`
const clauseLabels = (expr) => [...expr.matchAll(/(?:by|without|on|ignoring|group_left|group_right)\s*\(([^)]*)\)/gi)]
  .flatMap((m) => m[1].split(',').map((t) => t.trim()).filter(Boolean));
const legendRe = (label) => new RegExp(`\\{\\{\\s*${reEscape(label)}\\s*\\}\\}`);
// both label_values forms: label_values(label) and label_values(metric, label)
const labelValuesRe = (label) => new RegExp(`label_values\\(([^)]*,)?\\s*${reEscape(label)}\\s*\\)`);
const labelsRefRe = (label) => new RegExp(`\\$labels\\.${reEscape(label)}(?![A-Za-z0-9_])`);
const usesUnprofiledLabel = (text) =>
  labelMatcherRe(DEFAULT_LABEL).test(text)
  || clauseLabels(text).includes(DEFAULT_LABEL)
  || legendRe(DEFAULT_LABEL).test(text)
  || labelValuesRe(DEFAULT_LABEL).test(text)
  || labelsRefRe(DEFAULT_LABEL).test(text);

// ── per-selector node-filter check ──────────────────────────────────────────
// A substring test ("the expr contains the filter somewhere") would pass a
// ratio/join panel where ONE selector was profiled and another dkg_ selector
// was left unfiltered. Instead, extract EVERY vector selector and require the
// node filter inside each one that reads a dkg_* metric; a bare dkg_* metric
// reference without any matcher block is a violation too. Grafana template
// interpolations (`${node:regex}`) contain braces, so they are masked before
// brace parsing.
const dkgSelectorViolations = (rawExpr, rawNodeFilter) => {
  const mask = (s) => s.replace(/\$\{[^}]*\}/g, '__GVAR__');
  const expr = mask(rawExpr);
  const nodeFilter = mask(rawNodeFilter);
  const bad = [];
  const braceSpans = [];
  const selRe = /([a-zA-Z_:][a-zA-Z0-9_:]*)?\{([^}]*)\}/g;
  let m;
  while ((m = selRe.exec(expr)) !== null) {
    braceSpans.push([m.index, selRe.lastIndex]);
    const name = m[1] ?? '';
    const matchers = m[2];
    const readsDkg = name.startsWith('dkg_') || /__name__\s*(=~|=)\s*"[^"]*dkg_/.test(matchers);
    if (readsDkg && !matchers.includes(nodeFilter)) bad.push(expr.slice(m.index, selRe.lastIndex));
  }
  const nameRe = /dkg_[a-zA-Z0-9_]+/g;
  while ((m = nameRe.exec(expr)) !== null) {
    if (braceSpans.some(([s, e]) => m.index >= s && m.index < e)) continue; // matcher value, e.g. __name__=~"dkg_…"
    if (expr[nameRe.lastIndex] === '{') continue; // handled above as a brace selector
    bad.push(`${m[0]} (bare selector, no matchers)`);
  }
  return bad;
};

// ── metrics dashboard: the full profile-sensitive surface ──────────────────
{
  const dash = load('grafana-dashboard-dkg-node-metrics.json');
  const nodeVar = (dash.templating?.list ?? []).find((v) => v.name === 'node');
  const wantVarQuery = `label_values({__name__=~"dkg_.+"}, ${LABEL})`;
  if (!nodeVar) fail('metrics dashboard', 'no $node template variable');
  else if (nodeVar.query !== wantVarQuery) fail('metrics dashboard $node variable', `query is ${JSON.stringify(nodeVar.query)}, want ${JSON.stringify(wantVarQuery)}`);

  const nodeFilter = `${LABEL}=~"\${node:regex}"`;
  // recurse into collapsed-row nesting so a panel can never hide from the walk
  const allPanels = (dash.panels ?? []).flatMap((p) => [p, ...(p.panels ?? [])]);
  let dkgTargetsSeen = 0;
  for (const panel of allPanels) {
    for (const t of panel.targets ?? []) {
      const where = `metrics panel "${panel.title}" target ${t.refId}`;
      const expr = t.expr ?? '';
      // every dkg_* read is per-node scoped through the profile — checked
      // PER SELECTOR (a ratio/join with one unfiltered dkg_ selector fails);
      // collector self-monitoring (otelcol_*) is intentionally fleet-wide.
      if (/dkg_/.test(expr)) dkgTargetsSeen++;
      for (const sel of dkgSelectorViolations(expr, nodeFilter)) {
        fail(where, `dkg_* selector lacks the profiled node filter ${nodeFilter}: ${sel}`);
      }
      if (profiled) {
        if (usesUnprofiledLabel(expr)) fail(where, `unprofiled '${DEFAULT_LABEL}' label survived in expr: ${expr}`);
        if (t.legendFormat && legendRe(DEFAULT_LABEL).test(t.legendFormat)) fail(where, `unprofiled legend: ${t.legendFormat}`);
      }
    }
  }
  // minimum-surface floor: the verifier proves properties of what exists, so
  // it must also prove the expected surface EXISTS — an empty dashboard or a
  // generator refactor that drops every dkg_ panel must not verify OK.
  if (dkgTargetsSeen < 1) fail('metrics dashboard', 'no dkg_* metric targets found — expected per-node DKG panels');
  if (profiled) {
    for (const v of dash.templating?.list ?? []) {
      const q = typeof v.query === 'string' ? v.query : JSON.stringify(v.query ?? '');
      if (usesUnprofiledLabel(q)) fail(`metrics dashboard variable $${v.name}`, `unprofiled '${DEFAULT_LABEL}' in query: ${q}`);
    }
  }
}

// ── alert payload: datasource UID integrity + profiled rules + routing ─────
{
  const alertsFile = 'alert-rules.provisioning.json';
  const payload = load(alertsFile);
  // the _readme prose legitimately documents the placeholder by name; every
  // OTHER part of a concrete --vm-uid render must be fully substituted
  const { _readme, ...machinePayload } = payload;
  if (VM_UID !== '<VM_DATASOURCE_UID>' && JSON.stringify(machinePayload).includes('<VM_DATASOURCE_UID>')) {
    fail(alertsFile, 'placeholder <VM_DATASOURCE_UID> leaked into a concrete --vm-uid render');
  }
  const EXPECTED_UID_BY_TYPE = { loki: LOKI_UID, prometheus: VM_UID };
  // minimum-surface floors: an empty payload proves nothing — the expected
  // alerting surface must EXIST, not merely be well-formed where present
  if ((payload.rules ?? []).length < 1) fail(alertsFile, 'no alert rules — expected the DKG alert catalog');
  if ((payload.contactPoints ?? []).length < 3) fail(alertsFile, `expected 3 signal contact points, got ${(payload.contactPoints ?? []).length}`);
  const expectedEvaluationGroups = new Map([
    ['dkg-node-telemetry', 60],
    ['dkg-node-health', 300],
    ['dkg-capacity-watch', 3600],
  ]);
  for (const [name, interval] of expectedEvaluationGroups) {
    const group = (payload.evaluationGroups ?? []).find((entry) => entry.name === name);
    if (group?.interval !== interval) {
      fail(alertsFile, `evaluation group "${name}" must run every ${interval}s`);
    }
  }
  // ── golden inventory tripwire ─────────────────────────────────────────────
  // DELIBERATELY duplicated from the alert catalog: the generated-artifact
  // check proves the files came from the generator, but not that the
  // generator still ships the production alert coverage — a rule deleted from
  // the catalog regenerates matching JSON and sails through every other
  // check. Removing/adding a rule now requires consciously editing this list
  // in the same PR, which is exactly the review speed bump it exists to be.
  const EXPECTED_RULE_STEMS = [
    'Node stopped reporting',
    'Mainnet fleet stopped reporting',
    'Node storage overloaded',
    'RPC usage unusually high',
    'Telemetry collector cannot export logs',
    'Telemetry collector queue almost full',
    'Publishing failure ratio high',
    'Storage ACK quorum repeatedly missed',
    'All chain RPC providers failed',
    'Operation trace failure ratio high',
  ];
  for (const stem of EXPECTED_RULE_STEMS) {
    const n = (payload.rules ?? []).filter((r) => (r.title ?? '').startsWith(stem)).length;
    if (n !== 1) fail(alertsFile, `golden inventory: expected exactly 1 rule titled "${stem}…", found ${n}`);
  }
  if ((payload.rules ?? []).length !== EXPECTED_RULE_STEMS.length) {
    fail(alertsFile, `golden inventory: expected ${EXPECTED_RULE_STEMS.length} rules, payload has ${(payload.rules ?? []).length} — update EXPECTED_RULE_STEMS consciously when the catalog changes`);
  }
  const EXPECTED_CONTACT_POINTS = ['logs', 'metrics', 'traces'].map((sig) => `DKG node ${sig} (Slack)`);
  for (const name of EXPECTED_CONTACT_POINTS) {
    if (!(payload.contactPoints ?? []).some((cp) => cp.name === name)) fail(alertsFile, `golden inventory: contact point "${name}" missing`);
  }
  let perNodeDkgRules = 0;
  for (const rule of payload.rules ?? []) {
    const where = `rule "${rule.title}"`;
    const [q, ...exprBlocks] = rule.data ?? [];
    if (!q?.model?.datasource?.type) { fail(where, 'query block A has no model.datasource.type'); continue; }
    const wantUid = EXPECTED_UID_BY_TYPE[q.model.datasource.type];
    if (wantUid === undefined) fail(where, `unexpected datasource type ${q.model.datasource.type}`);
    if (q.datasourceUid !== wantUid) fail(where, `data[0].datasourceUid is ${q.datasourceUid}, want ${wantUid}`);
    if (q.model.datasource.uid !== q.datasourceUid) fail(where, `model.datasource.uid (${q.model.datasource.uid}) != datasourceUid (${q.datasourceUid}) — partial substitution`);
    if (q.model.maxDataPoints !== 1) fail(where, `query maxDataPoints must be 1, got ${q.model.maxDataPoints}`);
    for (const b of exprBlocks) {
      if (b.datasourceUid !== '__expr__') fail(where, `expression block ${b.refId} datasourceUid is ${b.datasourceUid}, want __expr__`);
    }
    // per-node metric alerts: grouped + summarized through the profile
    const expr = q.model.expr ?? '';
    const summary = rule.annotations?.summary ?? '';
    for (const key of [
      'slack_title',
      'what_happened',
      'affected',
      'react',
      'check_first',
      'evidence',
      '__dashboardUid__',
      '__panelId__',
    ]) {
      if (!rule.annotations?.[key]) fail(where, `human annotation "${key}" missing`);
    }
    if (/runbook_url|dashboard_url|logs_url/i.test(JSON.stringify(rule.annotations ?? {}))) {
      fail(where, 'retired broad/runbook link annotation survived');
    }
    if (!['P1', 'P2', 'P3'].includes(rule.labels?.priority)) {
      fail(where, `priority must be P1/P2/P3, got ${JSON.stringify(rule.labels?.priority)}`);
    }
    for (const label of ['alert_id', 'component', 'entity_kind', 'signal', 'team']) {
      if (!rule.labels?.[label]) fail(where, `routing/classification label "${label}" missing`);
    }
    if (/owner|who owns/i.test(JSON.stringify(rule.annotations ?? {}))) {
      fail(where, 'ownership text is forbidden by the approved Slack contract');
    }
    const expectedGroup =
      rule.labels?.alert_id === 'node-silent'
        ? 'dkg-node-health'
        : rule.labels?.alert_id === 'rpc-usage-watch'
          ? 'dkg-capacity-watch'
          : 'dkg-node-telemetry';
    if (rule.ruleGroup !== expectedGroup) {
      fail(where, `rule must use evaluation group "${expectedGroup}", got "${rule.ruleGroup}"`);
    }
    if (q.model.datasource.type === 'prometheus' && /dkg_/.test(expr)) {
      perNodeDkgRules++;
      if (!clauseLabels(expr).includes(LABEL)) fail(where, `per-node metric alert does not group by profiled label '${LABEL}': ${expr}`);
      if (!labelsRefRe(LABEL).test(summary)) fail(where, `summary does not reference $labels.${LABEL}: ${summary}`);
      if (profiled && (usesUnprofiledLabel(expr) || labelsRefRe(DEFAULT_LABEL).test(summary))) {
        fail(where, `unprofiled '${DEFAULT_LABEL}' survived in expr/summary`);
      }
    }
  }
  if (perNodeDkgRules < 1) fail(alertsFile, 'no per-node dkg_* Prometheus alert rules — expected the armed node-metrics alerts');
  const routes = payload.policyRoutes ?? [];
  const routeFor = (sig) => routes.find((r) => (r.object_matchers ?? []).some(([k, , v]) => k === 'signal' && v === sig));
  const metricsRoute = routeFor('metrics');
  if (!metricsRoute) fail(alertsFile, 'no metrics policy route');
  else if (JSON.stringify(metricsRoute.group_by ?? []) !== JSON.stringify(['deployment_environment'])) {
    fail(alertsFile, `metrics route must aggregate by environment, got ${JSON.stringify(metricsRoute.group_by ?? [])}`);
  }
  const logsRoute = routeFor('logs');
  if (!logsRoute) fail(alertsFile, 'no logs policy route');
  else if (JSON.stringify(logsRoute.group_by ?? []) !== JSON.stringify(['deployment_environment'])) {
    fail(alertsFile, `logs route must aggregate by environment, got ${JSON.stringify(logsRoute.group_by ?? [])}`);
  }
  const tracesRoute = routeFor('traces');
  if (!tracesRoute) fail(alertsFile, 'no traces policy route');
  else if (JSON.stringify(tracesRoute.group_by ?? []) !== JSON.stringify(['deployment_environment'])) {
    fail(alertsFile, `traces route must aggregate by environment, got ${JSON.stringify(tracesRoute.group_by ?? [])}`);
  }
  const p3Routes = routes.filter((route) =>
    (route.object_matchers ?? []).some(([key, op, value]) =>
      key === 'priority' && op === '=' && value === 'P3'));
  if (p3Routes.length !== 1) fail(alertsFile, `expected one P3 route, got ${p3Routes.length}`);
  else {
    const route = p3Routes[0];
    if (route.group_wait !== '24h' || route.group_interval !== '24h' || route.repeat_interval !== '24h') {
      fail(alertsFile, `P3 route is not daily-delayed: ${JSON.stringify(route)}`);
    }
  }
  const actionableRoutes = routes.filter((route) =>
    (route.object_matchers ?? []).some(([key, op, value]) =>
      key === 'priority' && op === '=~' && value === 'P1|P2'));
  if (actionableRoutes.length !== 3) {
    fail(alertsFile, `expected 3 P1/P2 signal routes, got ${actionableRoutes.length}`);
  }
  if ((payload.notificationTemplates ?? []).length !== 1) {
    fail(alertsFile, `expected one generated notification template, got ${(payload.notificationTemplates ?? []).length}`);
  } else {
    const template = payload.notificationTemplates[0];
    if (template.name !== 'dkg-readable') fail(alertsFile, `unexpected template name ${template.name}`);
    if (!template.template?.includes('[RECOVERED]')) fail(alertsFile, 'template lacks recovery message');
    if (!template.template?.includes('*What happened:*')) fail(alertsFile, 'template lacks What happened field');
    if (!template.template?.includes('Open exact incident')) fail(alertsFile, 'template lacks exact incident link');
    if (!template.template?.includes('.PanelURL')) fail(alertsFile, 'template does not use Grafana PanelURL');
    if (!template.template?.includes('.StartsAt.Add')) fail(alertsFile, 'template lacks incident start-time context');
    if (!template.template?.includes('.EndsAt.UnixMilli')) fail(alertsFile, 'template lacks recovery end time');
    if (/node\(s\) affected|who owns|runbook_url|dashboard_url|logs_url|Open dashboard|Open logs|Runbook/i.test(template.template ?? '')) {
      fail(alertsFile, 'template contains retired/generic/ownership wording');
    }
  }
  for (const cp of payload.contactPoints ?? []) {
    const url = cp.settings?.url ?? '';
    if (!/^<SLACK_WEBHOOK_[A-Z_]+>$/.test(url)) fail(`contact point "${cp.name}"`, `settings.url must be a <SLACK_WEBHOOK_*> placeholder, got: ${url}`);
    if (cp.settings?.title !== '{{ template "dkg.title" . }}') fail(`contact point "${cp.name}"`, 'title template is not dkg.title');
    if (cp.settings?.text !== '{{ template "dkg.body" . }}') fail(`contact point "${cp.name}"`, 'text template is not dkg.body');
  }
}

if (violations.length) {
  console.error(`PROFILE RENDER VERIFY FAILED (${violations.length} violation(s), dir=${DIR}, label=${LABEL}):`);
  for (const v of violations) console.error('  - ' + v);
  process.exit(1);
}
console.log(`profile render verify OK: dir=${DIR} label=${LABEL} vm-uid=${VM_UID} loki-uid=${LOKI_UID}`);

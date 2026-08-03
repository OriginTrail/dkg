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
//   - the metrics notification route groups by the profiled label;
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

// ── W1 sync-cost dashboard: complete I1–I9 surface + parser fixture ───────
{
  const dash = load('grafana-dashboard-dkg-sync-cost.json');
  const nodeVar = (dash.templating?.list ?? []).find((v) => v.name === 'node');
  const wantVarQuery = `label_values({__name__=~"dkg_.+"}, ${LABEL})`;
  if (!nodeVar) fail('sync-cost dashboard', 'no $node template variable');
  else if (nodeVar.query !== wantVarQuery) fail('sync-cost dashboard $node variable', `query is ${JSON.stringify(nodeVar.query)}, want ${JSON.stringify(wantVarQuery)}`);

  const expectedVariables = {
    sync_source: 'catchup-foreground,on-connect,reconcile,catchup-background,vm-recovery,swm-recovery,control-plane,unspecified',
    sync_lane: 'durable,changelog,shared_memory,swm_recovery',
    sync_outcome: 'resolved,error,cancelled',
  };
  for (const [name, query] of Object.entries(expectedVariables)) {
    const variable = (dash.templating?.list ?? []).find((v) => v.name === name);
    if (!variable) fail('sync-cost dashboard', `missing $${name} variable`);
    else {
      if (variable.query !== query) fail(`sync-cost dashboard $${name}`, `query is ${JSON.stringify(variable.query)}, want ${JSON.stringify(query)}`);
      if (!variable.includeAll || !variable.multi || variable.allValue !== '.+') {
        fail(`sync-cost dashboard $${name}`, 'must be multi-select with an explicit .+ All value');
      }
    }
  }

  const allPanels = (dash.panels ?? []).flatMap((panel) => [panel, ...(panel.panels ?? [])]);
  const allTargets = allPanels.flatMap((panel) => (panel.targets ?? []).map((target) => ({ panel, target })));
  const nodeFilter = `${LABEL}=~"\${node:regex}"`;
  const dashboardExprs = [];
  for (const { panel, target } of allTargets) {
    const expr = target.expr ?? '';
    if (!/dkg_/.test(expr)) continue;
    dashboardExprs.push(expr);
    const where = `sync-cost panel "${panel.title}" target ${target.refId}`;
    for (const sel of dkgSelectorViolations(expr, nodeFilter)) {
      fail(where, `dkg_* selector lacks the profiled node filter ${nodeFilter}: ${sel}`);
    }
    if (profiled) {
      if (usesUnprofiledLabel(expr)) fail(where, `unprofiled '${DEFAULT_LABEL}' label survived in expr: ${expr}`);
      if (target.legendFormat && legendRe(DEFAULT_LABEL).test(target.legendFormat)) fail(where, `unprofiled legend: ${target.legendFormat}`);
    }
  }
  if (profiled) {
    for (const variable of dash.templating?.list ?? []) {
      const query = typeof variable.query === 'string' ? variable.query : JSON.stringify(variable.query ?? '');
      if (usesUnprofiledLabel(query)) fail(`sync-cost dashboard variable $${variable.name}`, `unprofiled '${DEFAULT_LABEL}' in query: ${query}`);
    }
  }

  const expressionText = dashboardExprs.join('\n');
  const expectedInstruments = [
    'dkg_sync_attempt_total',
    'dkg_sync_attempt_request_bytes',
    'dkg_sync_attempt_response_bytes',
    'dkg_sync_operation_duration_ms',
    'dkg_sync_operation_rejected_total',
    'dkg_sync_singleflight_joins_total',
    'dkg_context_graph_catchup_requests_total',
    'dkg_context_graph_catchup_jobs_total',
    'dkg_context_graph_catchup_job_duration_ms',
  ];
  for (const instrument of expectedInstruments) {
    if (!expressionText.includes(instrument)) fail('sync-cost dashboard', `W1 instrument ${instrument} is not read by any panel`);
  }

  const flame = allPanels.find((panel) => panel.type === 'flamegraph');
  if (!flame) fail('sync-cost dashboard', 'source-attributed flamegraph is missing');
  else {
    const refs = (flame.targets ?? []).map((target) => target.refId).join('');
    if (refs !== 'ABCD') fail('sync-cost dashboard flamegraph', `target order is ${JSON.stringify(refs)}, want ABCD`);
    const transforms = (flame.transformations ?? []).map((transform) => transform.id);
    const wanted = ['seriesToRows', 'extractFields', 'convertFieldType', 'calculateField', 'organize'];
    if (JSON.stringify(transforms) !== JSON.stringify(wanted)) {
      fail('sync-cost dashboard flamegraph', `transform chain is ${JSON.stringify(transforms)}, want ${JSON.stringify(wanted)}`);
    }
    const exprs = (flame.targets ?? []).map((target) => target.expr ?? '').join('\n');
    for (const label of ['source', 'lane', 'outcome']) {
      if (!exprs.includes(label)) fail('sync-cost dashboard flamegraph', `hierarchy does not include ${label}`);
    }
    if (!exprs.includes('$__range')) fail('sync-cost dashboard flamegraph', 'width is not evaluated over the selected Grafana range');
  }

  const heatmaps = allPanels.filter((panel) => panel.type === 'heatmap');
  const expectedHeatmaps = [
    ['Logical sync operation duration heatmap', 'dkg_sync_operation_duration_ms'],
    ['Sync scheduler queue-wait heatmap', 'dkg_sync_scheduler_queue_wait_ms'],
    ['Walk catch-up job duration heatmap', 'dkg_context_graph_catchup_job_duration_ms'],
  ];
  if (heatmaps.length !== expectedHeatmaps.length) {
    fail('sync-cost dashboard', `expected ${expectedHeatmaps.length} histogram heatmaps, got ${heatmaps.length}`);
  }
  for (const [title, metric] of expectedHeatmaps) {
    const panel = heatmaps.find((candidate) => candidate.title?.startsWith(title));
    const where = `sync-cost dashboard ${title}`;
    if (!panel) { fail(where, 'panel is missing'); continue; }
    if (panel.options?.calculate !== false) fail(where, 'must consume server-side Prometheus histogram buckets');
    if (panel.fieldConfig?.defaults?.unit !== 'ms' || panel.options?.yAxis?.unit !== 'ms') fail(where, 'must render duration in milliseconds');
    const [target, ...extra] = panel.targets ?? [];
    if (!target || extra.length) { fail(where, `expected exactly one target, got ${(panel.targets ?? []).length}`); continue; }
    if (target.format !== 'heatmap' || target.queryType !== 'range') fail(where, 'target must be a Prometheus range heatmap');
    if (!target.expr?.includes(metric) || !target.expr?.includes('_bucket') || !target.expr?.includes('sum by (le)')) {
      fail(where, `target is not a bucket aggregation for ${metric}`);
    }
  }

  for (const title of [
    'Completed durable operations',
    'Attributed durable payload',
    'Cross-family joins',
    'Unclassified source samples',
    'Counter resets',
    'Minimum export samples',
  ]) {
    if (!allPanels.some((panel) => panel.type === 'stat' && panel.title === title)) {
      fail('sync-cost dashboard evidence gates', `stat panel "${title}" is missing`);
    }
  }

  // The generated promtool fixture must be expression-identical to the
  // dashboard after substituting only Grafana runtime variables. That makes
  // the CI parser check certify every panel query, rather than a nearby copy.
  const substituteGrafana = (expr) => expr
    .replaceAll('${node:regex}', '.*')
    .replaceAll('${sync_source:regex}', '.*')
    .replaceAll('${sync_lane:regex}', '.*')
    .replaceAll('${sync_outcome:regex}', '.*')
    .replaceAll('$__rate_interval', '5m')
    .replaceAll('$__range', '2h');
  const fixtureText = fs.readFileSync(path.join(DIR, 'w1/w1-dashboard-rules.yaml'), 'utf8').replace(/\r\n/g, '\n');
  const fixtureExprs = [...fixtureText.matchAll(/^ {8}expr: "((?:[^"\\]|\\.)*)"$/gm)]
    .map((match) => match[1].replace(/\\(["\\])/g, '$1'));
  const sorted = (values) => [...values].sort();
  const rendered = sorted(dashboardExprs.map(substituteGrafana));
  const fixture = sorted(fixtureExprs);
  if (rendered.length !== fixture.length || rendered.some((expr, index) => expr !== fixture[index])) {
    fail('sync-cost dashboard ↔ w1-dashboard-rules.yaml', `expression sets differ (${rendered.length} dashboard targets vs ${fixture.length} fixture rules)`);
  }
}

// ── logs dashboard: PR #2003 worker-pressure surface ──────────────────────
{
  const dash = load('grafana-dashboard-dkg-node-logs.json');
  const flame = (dash.panels ?? []).find((panel) => panel.type === 'flamegraph');
  if (!flame) {
    fail('logs dashboard', 'worker-pressure flamegraph panel is missing');
  } else {
    if (!flame.title?.includes('Worker queue pressure')) {
      fail('logs dashboard flamegraph', `unexpected title: ${JSON.stringify(flame.title)}`);
    }
    if ((flame.targets ?? []).length !== 5) {
      fail('logs dashboard flamegraph', `expected 5 ordered profile targets, got ${(flame.targets ?? []).length}`);
    }
    const refs = (flame.targets ?? []).map((target) => target.refId).join('');
    if (refs !== 'ABCDE') {
      fail('logs dashboard flamegraph', `target order is ${JSON.stringify(refs)}, want ABCDE`);
    }
    const exprs = (flame.targets ?? []).map((target) => target.expr ?? '').join('\n');
    if (!exprs.includes('service_instance_id="$node"')) {
      fail('logs dashboard flamegraph', 'queries are not scoped to the selected node');
    }
    if (!exprs.includes('|= `[backpressure]`')) {
      fail('logs dashboard flamegraph', 'queries do not select PR #2003 backpressure records');
    }
    for (const phase of ['activeOperations', 'queuedOperations']) {
      for (let index = 0; index < 8; index++) {
        if (!exprs.includes(`${phase}[${index}].operation`)) {
          fail('logs dashboard flamegraph', `missing bounded ${phase}[${index}] extraction`);
        }
      }
    }
    const transforms = (flame.transformations ?? []).map((transform) => transform.id);
    const wanted = ['seriesToRows', 'extractFields', 'convertFieldType', 'calculateField', 'organize'];
    if (JSON.stringify(transforms) !== JSON.stringify(wanted)) {
      fail('logs dashboard flamegraph', `transform chain is ${JSON.stringify(transforms)}, want ${JSON.stringify(wanted)}`);
    }
  }
  const raw = (dash.panels ?? []).find((panel) => panel.title?.startsWith('Backpressure transitions'));
  if (!raw?.targets?.some((target) => target.expr?.includes('|= `[backpressure]`'))) {
    fail('logs dashboard', 'raw backpressure evidence panel is missing');
  }

  const heatmaps = (dash.panels ?? []).filter((panel) => panel.type === 'heatmap');
  if (heatmaps.length !== 2) {
    fail('logs dashboard', `expected 2 worker-pressure heatmaps, got ${heatmaps.length}`);
  }
  for (const phase of ['Active / admitted', 'Queued / waiting']) {
    const heatmap = heatmaps.find((panel) => panel.title?.startsWith(phase));
    const field = phase.startsWith('Active') ? 'oldestActiveAgeMs' : 'oldestQueuedAgeMs';
    const where = `logs dashboard ${phase.toLowerCase()} heatmap`;
    if (!heatmap) {
      fail(where, 'panel is missing');
      continue;
    }
    if (heatmap.options?.calculate !== true) {
      fail(where, 'must calculate heatmap buckets from the Loki time series');
    }
    if (heatmap.fieldConfig?.defaults?.unit !== 'ms' || heatmap.options?.yAxis?.unit !== 'ms') {
      fail(where, 'sampled pressure age must be rendered in milliseconds');
    }
    if ((heatmap.targets ?? []).length !== 1) {
      fail(where, `expected one range target, got ${(heatmap.targets ?? []).length}`);
      continue;
    }
    const [target] = heatmap.targets;
    const expr = target.expr ?? '';
    if (target.queryType !== 'range') fail(where, `queryType is ${JSON.stringify(target.queryType)}, want range`);
    if (!expr.includes('service_instance_id="$node"')) fail(where, 'query is not scoped to the selected node');
    if (!expr.includes('|= `[backpressure]`')) fail(where, 'query does not select PR #2003 backpressure records');
    if (!expr.includes(`age="${field}"`)) fail(where, `query does not extract ${field}`);
    if (!expr.includes('max_over_time(') || !expr.includes('[$__auto]')) {
      fail(where, 'query must retain the peak sparse sample in each Grafana resolution bucket');
    }
    if (target.legendFormat !== '{{scheduler}}/{{lane}}') {
      fail(where, `legend is ${JSON.stringify(target.legendFormat)}, want scheduler/lane`);
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
  // ── golden inventory tripwire ─────────────────────────────────────────────
  // DELIBERATELY duplicated from the alert catalog: the generated-artifact
  // check proves the files came from the generator, but not that the
  // generator still ships the production alert coverage — a rule deleted from
  // the catalog regenerates matching JSON and sails through every other
  // check. Removing/adding a rule now requires consciously editing this list
  // in the same PR, which is exactly the review speed bump it exists to be.
  const EXPECTED_RULE_STEMS = [
    'Node silent',
    'Fleet blackout',
    'Error spike',
    'Warn spike',
    'RPC credit burn spike',
    'Log pipeline export failing',
    'Collector exporter queue',
    'Publish failures',
    'Chain RPC failover exhausted',
    'Errored spans rate',
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
    for (const b of exprBlocks) {
      if (b.datasourceUid !== '__expr__') fail(where, `expression block ${b.refId} datasourceUid is ${b.datasourceUid}, want __expr__`);
    }
    // per-node metric alerts: grouped + summarized through the profile
    const expr = q.model.expr ?? '';
    const summary = rule.annotations?.summary ?? '';
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
  else {
    const groupBy = metricsRoute.group_by ?? [];
    if (!groupBy.includes(LABEL)) fail(alertsFile, `metrics route group_by ${JSON.stringify(groupBy)} lacks profiled label '${LABEL}'`);
    if (profiled && groupBy.includes(DEFAULT_LABEL)) fail(alertsFile, `metrics route group_by ${JSON.stringify(groupBy)} still carries unprofiled '${DEFAULT_LABEL}'`);
  }
  const logsRoute = routeFor('logs');
  if (!logsRoute) fail(alertsFile, 'no logs policy route');
  else if (!(logsRoute.group_by ?? []).includes('service_instance_id')) fail(alertsFile, `logs route group_by ${JSON.stringify(logsRoute.group_by)} lacks service_instance_id`);
  if (!routeFor('traces')) fail(alertsFile, 'no traces policy route');
  for (const cp of payload.contactPoints ?? []) {
    const url = cp.settings?.url ?? '';
    if (!/^<SLACK_WEBHOOK_[A-Z_]+>$/.test(url)) fail(`contact point "${cp.name}"`, `settings.url must be a <SLACK_WEBHOOK_*> placeholder, got: ${url}`);
  }
}

if (violations.length) {
  console.error(`PROFILE RENDER VERIFY FAILED (${violations.length} violation(s), dir=${DIR}, label=${LABEL}):`);
  for (const v of violations) console.error('  - ' + v);
  process.exit(1);
}
console.log(`profile render verify OK: dir=${DIR} label=${LABEL} vm-uid=${VM_UID} loki-uid=${LOKI_UID}`);

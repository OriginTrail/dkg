#!/usr/bin/env node
// Source of truth for the DKG observability Grafana artifacts.
//
// Emits the four dashboard JSONs and alert-rules.provisioning.json in this
// directory. Edit THIS file (compact helpers below), regenerate, commit both —
// never hand-edit the rendered JSON.
//
//   node generate-observability.mjs [outDir] [--vm-uid <uid>] [--loki-uid <uid>]
//                                   [--prom-node-label <label>] [--check]
//
// Dashboards bind datasources through template variables (loki/vm/tempo), so
// they import anywhere unchanged. Alert rules must reference concrete
// datasource UIDs; the committed artifact keeps the <VM_DATASOURCE_UID>
// placeholder (that UID is instance-specific) — pass --vm-uid to render an
// importable payload for a real instance. The Loki UID defaults to "loki",
// the deliberate stable name on the production server. --check verifies the
// committed artifacts match the generator (used by CI); --prom-node-label
// switches the metrics node-identity profile (see below).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboards } from './lib/dashboards.mjs';
import { buildAlerts } from './lib/alerts.mjs';

// Strict CLI boundary: one optional positional (outDir) + two value flags.
// Fail loudly on unknown flags, missing flag values, or flag values that look
// like flags — a typoed command must not silently render a malformed payload.
const usage = 'usage: node generate-observability.mjs [outDir] [--vm-uid <uid>] [--loki-uid <uid>] [--prom-node-label <label>] [--check]';
const VALUE_FLAGS = ['--vm-uid', '--loki-uid', '--prom-node-label'];
const opts = { outDir: null, '--check': false };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_FLAGS.includes(a)) {
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) { console.error(`${a} requires a value\n${usage}`); process.exit(1); }
    opts[a] = v;
  } else if (a === '--check') {
    opts['--check'] = true;
  } else if (a.startsWith('--')) {
    console.error(`unknown flag ${a}\n${usage}`); process.exit(1);
  } else if (opts.outDir === null) {
    opts.outDir = a;
  } else {
    console.error(`unexpected extra argument ${a}\n${usage}`); process.exit(1);
  }
}
const outDir = opts.outDir ?? path.dirname(fileURLToPath(import.meta.url));
const VM_UID = opts['--vm-uid'] ?? '<VM_DATASOURCE_UID>';
const LOKI_UID = opts['--loki-uid'] ?? 'loki';
// Node-identity profile for the PROMETHEUS backend: which label carries the
// node name (service.instance.id). 'instance' is the canonical OTLP mapping
// (VictoriaMetrics native OTLP ingest and prometheusremotewrite both use it);
// collectors configured with resource_to_telemetry_conversion emit
// 'service_instance_id' instead — switch with ONE flag, every metrics query,
// legend, group-by, alert expression and summary derives from this constant.
// (Loki's node label is service_instance_id and Tempo's is
// resource.service.instance.id — fixed by our own pipeline, not profiled.)
const PROM_NODE_LABEL = opts['--prom-node-label'] ?? 'instance';
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(PROM_NODE_LABEL)) {
  console.error(`--prom-node-label must be a valid Prometheus label name, got: ${PROM_NODE_LABEL}\n${usage}`); process.exit(1);
}


const { fleet, nodeLogs, metrics, traces } = buildDashboards({ PROM_NODE_LABEL });
const { alerts, rulesTableMd } = buildAlerts({ PROM_NODE_LABEL, VM_UID, LOKI_UID });

// -------------------------------------------------------- write / --check
// Everything renders in memory first; --check then diffs against the files on
// disk and exits 1 on any mismatch, so CI can prove the committed artifacts
// were produced by this generator (no stale or hand-edited JSON can ship).
const START = '<!-- GENERATED:RULES-TABLE:START (by generate-observability.mjs — do not edit between markers) -->';
const END = '<!-- GENERATED:RULES-TABLE:END -->';
const rendered = new Map([
  ['grafana-dashboard-dkg-fleet-logs.json', JSON.stringify(fleet, null, 2) + '\n'],
  ['grafana-dashboard-dkg-node-logs.json', JSON.stringify(nodeLogs, null, 2) + '\n'],
  ['grafana-dashboard-dkg-node-metrics.json', JSON.stringify(metrics, null, 2) + '\n'],
  ['grafana-dashboard-dkg-node-traces.json', JSON.stringify(traces, null, 2) + '\n'],
  ['alert-rules.provisioning.json', JSON.stringify(alerts, null, 2) + '\n'],
]);
const mdPath = path.join(outDir, 'example-alerts.md');
const injectMd = (md) => {
  const si = md.indexOf(START), ei = md.indexOf(END);
  if (si < 0 || ei <= si) return null;
  return md.slice(0, si + START.length) + '\n' + rulesTableMd + '\n' + md.slice(ei);
};

if (opts['--check']) {
  const stale = [];
  for (const [file, want] of rendered) {
    const p = path.join(outDir, file);
    const have = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '<missing>';
    if (have !== want) stale.push(file);
  }
  if (fs.existsSync(mdPath)) {
    const md = fs.readFileSync(mdPath, 'utf8');
    const want = injectMd(md);
    if (want === null) stale.push('example-alerts.md (markers missing)');
    else if (want !== md) stale.push('example-alerts.md (generated section)');
  } else {
    stale.push('example-alerts.md (missing)');
  }
  if (stale.length) {
    console.error('STALE generated artifacts (regenerate with: node generate-observability.mjs):');
    for (const f of stale) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('check OK: all generated artifacts match the generator output');
} else {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [file, content] of rendered) {
    fs.writeFileSync(path.join(outDir, file), content);
    console.log('wrote', path.join(outDir, file));
  }
  if (fs.existsSync(mdPath)) {
    const next = injectMd(fs.readFileSync(mdPath, 'utf8'));
    if (next === null) console.warn('markers not found in example-alerts.md — table not injected');
    else { fs.writeFileSync(mdPath, next); console.log('updated rules table in', mdPath); }
  }
}

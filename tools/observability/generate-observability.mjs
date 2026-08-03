#!/usr/bin/env node
// Source of truth for the DKG observability Grafana artifacts.
//
// Emits the four dashboard JSONs, alert-rules.provisioning.json,
// example-alerts.md and the W1 sync-measurement artifacts (w1/) in this
// directory. Edit the lib/ sources, regenerate, commit both — never hand-edit
// a rendered artifact.
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
import { buildDocs } from './lib/docs.mjs';
import { buildW1Artifacts } from './lib/w1.mjs';
import { promNodeProfile } from './lib/profile.mjs';
import { assertPromLabel, parseCliArgs } from './lib/cli.mjs';

// CLI boundary shared with verify-profile-render.mjs (lib/cli.mjs): unknown
// flags, missing/flag-shaped values and extra positionals fail loudly with
// usage — a typoed command must not silently render a malformed payload.
const usage = 'usage: node generate-observability.mjs [outDir] [--vm-uid <uid>] [--loki-uid <uid>] [--prom-node-label <label>] [--check]';
const opts = parseCliArgs({
  argv: process.argv.slice(2),
  usage,
  valueFlags: ['--vm-uid', '--loki-uid', '--prom-node-label'],
  boolFlags: ['--check'],
});
const outDir = opts.positional ?? path.dirname(fileURLToPath(import.meta.url));
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
assertPromLabel(PROM_NODE_LABEL, usage);
const nodeProfile = promNodeProfile(PROM_NODE_LABEL);


const { fleet, nodeLogs, metrics, traces } = buildDashboards({ nodeProfile });
const { alerts, specs, routes } = buildAlerts({ nodeProfile, VM_UID, LOKI_UID });
const docs = buildDocs({ specs, routes });
// W1 sync-measurement decision queries (lib/w1.mjs) render into a NESTED key
// (w1/…) — see the per-file mkdir in write mode below.
const w1 = buildW1Artifacts({ nodeProfile });

// -------------------------------------------------------- write / --check
// Everything (JSON artifacts AND docs) renders fully in memory; write mode
// emits the complete artifact set to outDir and --check diffs every file
// against disk, exiting 1 on any mismatch — render and check are symmetric,
// nothing is mutated in place, and CI can prove the committed artifacts were
// produced by this generator (no stale or hand-edited file can ship).
const rendered = new Map([
  ['grafana-dashboard-dkg-fleet-logs.json', JSON.stringify(fleet, null, 2) + '\n'],
  ['grafana-dashboard-dkg-node-logs.json', JSON.stringify(nodeLogs, null, 2) + '\n'],
  ['grafana-dashboard-dkg-node-metrics.json', JSON.stringify(metrics, null, 2) + '\n'],
  ['grafana-dashboard-dkg-node-traces.json', JSON.stringify(traces, null, 2) + '\n'],
  ['alert-rules.provisioning.json', JSON.stringify(alerts, null, 2) + '\n'],
  ...Object.entries(docs),
  ...Object.entries(w1),
]);

// Line endings are NOT part of any artifact's contract: the generator always
// renders LF, while git checks these textual files out with the platform
// convention (core.autocrlf=true on Windows rewrites every one of them to
// CRLF — the metrics dashboard alone holds ~660 pairs). A byte comparison
// therefore reports the whole set stale on a Windows checkout, which would
// leave the documented developer environment permanently red and make this
// gate unusable exactly where implementation happens. Both sides are
// normalized so ONE command is green on Windows and Linux alike; every
// artifact here is text and none of them encodes a meaningful CR.
const normalizeEol = (s) => s.replace(/\r\n/g, '\n');

if (opts['--check']) {
  const stale = [];
  for (const [file, want] of rendered) {
    const p = path.join(outDir, file);
    const have = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '<missing>';
    if (normalizeEol(have) !== normalizeEol(want)) stale.push(file);
  }
  if (stale.length) {
    console.error('STALE generated artifacts (regenerate with: node generate-observability.mjs):');
    for (const f of stale) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('check OK: all generated artifacts match the generator output');
} else {
  // Per-file mkdir, not one mkdir of outDir: artifact keys may be NESTED
  // (w1/w1-rules.yaml), and creating only outDir would ENOENT on the first
  // nested write.
  for (const [file, content] of rendered) {
    const p = path.join(outDir, file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    console.log('wrote', p);
  }
}

#!/usr/bin/env node
// A25 gate: prove `generate-observability.mjs --check` is line-ending agnostic
// AND still fails on real content drift.
//
//   node verify-check-mode.mjs
//
// Why this exists. Check mode normalizes CRLF/LF before comparing, because
// git checks these textual artifacts out with the platform convention
// (core.autocrlf=true rewrites every one of them to CRLF on Windows — the
// metrics dashboard alone holds ~660 pairs) while the generator always renders
// LF. Without normalization the gate is permanently red on a Windows checkout;
// WITH normalization the gate could just as easily be permanently green,
// because a comparison that answers "equal" to everything passes every
// positive test ever written against it.
//
// So this runs the REAL command against artifact trees it constructs itself:
// one CRLF, one LF, and four corrupted ones. Both directions are pinned — a
// check that always exited 0 fails cases C–F, and one that always exited 1
// fails cases A–B. Because the trees are built here rather than read from the
// checkout, the CRLF path is exercised on a Linux CI runner too, where git
// would otherwise only ever produce LF.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENERATOR = path.join(HERE, 'generate-observability.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-check-mode-'));

const listFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));

const setEol = (dir, style) => {
  for (const f of listFiles(dir)) {
    const lf = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(f, style === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf);
  }
};

/** Render a fresh artifact tree and run `--check` against it. */
const renderAndCheck = (id, prepare) => {
  const dir = path.join(ROOT, id);
  execFileSync(process.execPath, [GENERATOR, dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  prepare(dir);
  try {
    execFileSync(process.execPath, [GENERATOR, dir, '--check'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

// Edit one rendered artifact in place, preserving its line-ending style, so a
// negative case tests CONTENT drift and nothing else.
const editFile = (dir, rel, fn) => {
  const p = path.join(dir, rel);
  const raw = fs.readFileSync(p, 'utf8');
  const crlf = raw.includes('\r\n');
  const next = fn(raw.replace(/\r\n/g, '\n'));
  if (next === raw.replace(/\r\n/g, '\n')) throw new Error(`verify-check-mode: mutation of ${rel} changed nothing — the negative case would be vacuous`);
  fs.writeFileSync(p, crlf ? next.replace(/\n/g, '\r\n') : next);
};

const RULES = path.join('w1', 'w1-rules.yaml');
const DASH = 'grafana-dashboard-dkg-node-metrics.json';

const CASES = [
  { id: 'A-crlf-tree', why: 'a CRLF checkout (Windows, core.autocrlf=true) must be GREEN',
    expect: 0, prepare: (d) => setEol(d, 'crlf') },
  { id: 'B-lf-tree', why: 'an LF checkout (Linux CI) must be GREEN',
    expect: 0, prepare: (d) => setEol(d, 'lf') },
  { id: 'C-content-drift-crlf', why: 'real content drift in a CRLF tree must be RED',
    expect: 1, names: RULES,
    prepare: (d) => { setEol(d, 'crlf'); editFile(d, RULES, (s) => s.replace('w1:stable:counter_resets', 'w1:stable:counter_reset')); } },
  { id: 'D-content-drift-lf', why: 'real content drift in an LF tree must be RED',
    expect: 1, names: DASH,
    prepare: (d) => { setEol(d, 'lf'); editFile(d, DASH, (s) => s.replace('"refresh": "1m"', '"refresh": "5m"')); } },
  // Normalization must be EOL-only. A hand-edit that adds trailing whitespace
  // or drops a line is exactly the stale-artifact class this gate exists to
  // catch, and an over-broad "ignore all whitespace" comparison would swallow
  // both while still passing cases A and B.
  { id: 'E-trailing-space', why: 'trailing whitespace is content, not a line ending — must be RED',
    expect: 1, names: RULES,
    prepare: (d) => { setEol(d, 'crlf'); editFile(d, RULES, (s) => s.replace('groups:\n', 'groups:  \n')); } },
  { id: 'F-dropped-line', why: 'a dropped line must be RED',
    expect: 1, names: RULES,
    prepare: (d) => { setEol(d, 'crlf'); editFile(d, RULES, (s) => s.replace('  - name: w1-reconnect-window\n', '')); } },
];

const failures = [];
const results = [];
for (const c of CASES) {
  let got;
  try {
    got = renderAndCheck(c.id, c.prepare);
  } catch (err) {
    failures.push(`${c.id}: harness error — ${err.message}`);
    continue;
  }
  if (got.code !== c.expect) {
    failures.push(`${c.id}: expected exit ${c.expect} (${c.why}), got ${got.code}${got.out ? ` :: ${got.out.trim().split('\n').join(' | ')}` : ''}`);
  } else if (c.names && !got.out.includes(c.names.split(path.sep).join('/')) && !got.out.includes(c.names)) {
    failures.push(`${c.id}: exited ${got.code} as expected but never named the stale file ${c.names} — the failure may be unrelated to the drift :: ${got.out.trim().split('\n').join(' | ')}`);
  }
  results.push(`${c.id.padEnd(22)} exit=${got.code} (want ${c.expect})`);
}

fs.rmSync(ROOT, { recursive: true, force: true });

if (failures.length) {
  console.error(`CHECK-MODE VERIFY FAILED (${failures.length} case(s)):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
for (const r of results) console.log('  ' + r);
console.log(`check-mode verify OK: ${CASES.length} cases — CRLF and LF both green, content drift (value, trailing space, dropped line) still red`);

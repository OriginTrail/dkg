#!/usr/bin/env node
// Parse-based verifier for the rendered W1 sync-measurement artifacts.
//
//   node verify-w1-render.mjs <dir> [--prom-node-label <label>]
//
// `generate-observability.mjs --check` proves the artifacts came from the
// generator; `promtool check rules` proves the expressions are valid PromQL.
// Neither proves they still MEASURE the thing W1 exists to measure. This
// verifier loads both rendered files and asserts the semantic contract:
//
//   - the metric inventory: every W1 instrument I1–I9 is actually read;
//   - DUAL SPELLING: a selector matching an instrument's native name must also
//     match its Prometheus-translated name (and vice versa) — a single assumed
//     spelling comes back EMPTY on one supported ingest route, which is
//     indistinguishable from "no traffic" and silently invalidates a window;
//   - the §5.5 source-family mapping, including the invalidating family as the
//     NEGATION of the classified sources, and no source value outside the
//     closed eight-member vocabulary;
//   - the ALL-SOURCE (no family filter) bytes AND active-ms denominators —
//     the two-axis materiality rule is uncomputable without them;
//   - the profiled node filter inside EVERY selector, checked per selector
//     rather than per expression;
//   - both the stable-window and reconnect-window query groups, each with a
//     single consistent range;
//   - the report and the rule fixture carry the SAME expressions, so the
//     parser can never be validating a hand-maintained second copy.
//
// The instrument table, family table and filters below are DELIBERATELY
// duplicated from lib/w1.mjs rather than imported — the same tripwire
// convention verify-profile-render.mjs uses for the alert catalog. Importing
// the generator's own tables would make every assertion self-satisfying: a
// renamed instrument or a widened source vocabulary would regenerate matching
// artifacts and sail through. Changing either side now requires consciously
// changing both in the same PR.
import fs from 'node:fs';
import path from 'node:path';
import { assertPromLabel, parseCliArgs } from './lib/cli.mjs';

const usage = 'usage: node verify-w1-render.mjs <dir> [--prom-node-label <label>]';
const opts = parseCliArgs({ argv: process.argv.slice(2), usage, valueFlags: ['--prom-node-label'] });
if (!opts.positional) { console.error(usage); process.exit(1); }
const DIR = opts.positional;
const LABEL = opts['--prom-node-label'] ?? 'instance';
assertPromLabel(LABEL, usage);

const violations = [];
const fail = (where, msg) => violations.push(`${where}: ${msg}`);
// Artifacts are read line-ending-normalized: git checks them out CRLF on a
// Windows worktree, and a verifier that only passes on LF would be exactly the
// platform-dependent gate the generator's check mode was fixed to stop being.
const read = (rel) => fs.readFileSync(path.join(DIR, rel), 'utf8').replace(/\r\n/g, '\n');

// ── the W1 contract, transcribed independently ────────────────────────────
const EXPECTED_INSTRUMENTS = [
  { id: 'I1', name: 'dkg.sync.attempt.total', kind: 'counter', unit: '1' },
  { id: 'I2', name: 'dkg.sync.attempt.request_bytes', kind: 'counter', unit: 'By' },
  { id: 'I3', name: 'dkg.sync.attempt.response_bytes', kind: 'counter', unit: 'By' },
  { id: 'I4', name: 'dkg.sync.operation.duration_ms', kind: 'histogram', unit: 'ms' },
  { id: 'I5', name: 'dkg.sync.operation.rejected_total', kind: 'counter', unit: '1' },
  { id: 'I6', name: 'dkg.sync.singleflight.joins_total', kind: 'counter', unit: '1' },
  { id: 'I7', name: 'dkg.context_graph.catchup.requests_total', kind: 'counter', unit: '1' },
  { id: 'I8', name: 'dkg.context_graph.catchup.jobs_total', kind: 'counter', unit: '1' },
  { id: 'I9', name: 'dkg.context_graph.catchup.job_duration_ms', kind: 'histogram', unit: 'ms' },
];
// Pre-existing corroborating instruments: not part of the inventory floor, but
// a selector reading one still has to be dual-spelled and node-filtered.
const EXPECTED_CORROBORATING = [
  { id: 'P1', name: 'dkg.sync.scheduler.queue_wait_ms', kind: 'histogram', unit: 'ms' },
  { id: 'P2', name: 'dkg.backpressure.oldest_queued_age_ms', kind: 'gauge', unit: 'ms' },
];
const EXPECTED_FAMILIES = [
  { id: 'foreground', role: 'eligible', sources: ['catchup-foreground'] },
  { id: 'recurring', role: 'eligible', sources: ['on-connect', 'reconcile'] },
  // `control-plane` (the eighth union member) is EXCLUDED, not invalidating:
  // curator meta refresh fetches plane=durable/phase=meta from outside any
  // admission boundary, so leaving it unclassified would clamp it to
  // `unspecified` and make §7.3's zero-unspecified gate unreachable on any node
  // that had joined a private CG.
  { id: 'excluded', role: 'excluded', sources: ['catchup-background', 'vm-recovery', 'swm-recovery', 'control-plane'] },
  { id: 'invalidating', role: 'invalidating', sources: ['unspecified'] },
];
const CLASSIFIED_SOURCES = EXPECTED_FAMILIES.filter((f) => f.role !== 'invalidating').flatMap((f) => f.sources);
const ELIGIBLE_SOURCES = EXPECTED_FAMILIES.filter((f) => f.role === 'eligible').flatMap((f) => f.sources);
const ALL_SOURCES = EXPECTED_FAMILIES.flatMap((f) => f.sources);
const ATTEMPT_FILTERS = ['plane="durable"', 'phase=~"data|meta|delta"']; // I1–I3
const OPERATION_FILTERS = ['lane=~"durable|changelog"'];                 // I4/I5
const EXPECTED_WINDOWS = [
  { group: 'w1-stable-window', range: '2h' },
  { group: 'w1-reconnect-window', range: '1h' },
];

// Independent derivation of the two Prometheus spellings — the same rule as
// lib/w1.mjs, written out again on purpose (see the header note).
const UNIT_SUFFIX = { '1': '', By: 'bytes', ms: 'milliseconds' };
const spellingsOf = (inst) => {
  const base = inst.name.replaceAll('.', '_');
  const unit = UNIT_SUFFIX[inst.unit];
  if (unit === undefined) throw new Error(`verify-w1: unmapped unit '${inst.unit}' on ${inst.name}`);
  // The unit word is appended only when the normalized name does not already
  // carry it as a token (OTel Prometheus/OpenMetrics compatibility), so
  // `…request_bytes` + `By` is `…_request_bytes_total` — never the doubled
  // `…_request_bytes_bytes_total`.
  const unitAlreadyPresent = Boolean(unit) && base.split('_').includes(unit);
  const addTotal = (n) => (inst.kind === 'counter' && !n.endsWith('_total') ? `${n}_total` : n);
  const translated = addTotal(unit && !unitAlreadyPresent ? `${base}_${unit}` : base);
  // The spelling the naive "always append the unit" rule produces. NO ingest
  // route emits it, so a selector matching it is the duplicated-unit bug.
  // Rejecting it is NOT redundant with requiring `translated`: an alternation
  // can match both, and the original defect was exactly an alternation that
  // covered this form while missing the real one — which reads empty on a
  // standard suffixed backend and reports `inconclusive` forever.
  const overSuffixed = unitAlreadyPresent ? addTotal(`${base}_${unit}`) : null;
  return { native: base, translated, overSuffixed };
};
const SERIES_SUFFIXES = (inst) => (inst.kind === 'histogram' ? ['_bucket', '_sum', '_count'] : ['']);
// Flat index of every (instrument, series) the artifacts may legitimately read.
const SPELLING_INDEX = [...EXPECTED_INSTRUMENTS, ...EXPECTED_CORROBORATING].flatMap((inst) => {
  const { native, translated, overSuffixed } = spellingsOf(inst);
  return SERIES_SUFFIXES(inst).map((series) => ({
    id: inst.id, series, dual: native !== translated,
    native: `${native}${series}`, translated: `${translated}${series}`,
    overSuffixed: overSuffixed ? `${overSuffixed}${series}` : null,
  }));
});

// ── artifact loading ──────────────────────────────────────────────────────
// A strict reader for exactly the shape lib/w1.mjs emits: any drift in the
// rendered YAML fails loudly here instead of being silently half-parsed into
// a verification that checks less than it claims.
const parseRuleFile = (text) => {
  const groups = [];
  let group = null;
  let pending = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (line === 'groups:') continue;
    let m;
    if ((m = /^ {2}- name: (\S+)$/.exec(line))) { group = { name: m[1], rules: [] }; groups.push(group); continue; }
    if (/^ {4}rules:$/.test(line)) continue;
    if ((m = /^ {6}- record: (\S+)$/.exec(line))) {
      if (!group) throw new Error(`w1-rules.yaml: rule before any group: ${line}`);
      pending = { record: m[1] };
      group.rules.push(pending);
      continue;
    }
    if ((m = /^ {8}expr: "((?:[^"\\]|\\.)*)"$/.exec(line))) {
      if (!pending) throw new Error(`w1-rules.yaml: expr without a preceding record: ${line}`);
      pending.expr = m[1].replace(/\\(["\\])/g, '$1');
      pending = null;
      continue;
    }
    throw new Error(`w1-rules.yaml: unexpected line (this verifier only understands the shape lib/w1.mjs emits): ${line}`);
  }
  return groups;
};

let groups;
let report;
try {
  groups = parseRuleFile(read('w1/w1-rules.yaml'));
  report = read('w1/w1-queries.md');
} catch (err) {
  console.error(`W1 RENDER VERIFY FAILED (dir=${DIR}): ${err.message}`);
  process.exit(1);
}
const rulesText = read('w1/w1-rules.yaml');
const allRules = groups.flatMap((g) => g.rules.map((r) => ({ ...r, group: g.name })));
for (const r of allRules) if (typeof r.expr !== 'string') fail(`rule ${r.record}`, 'has no expr');

// ── report ↔ fixture: the same expressions, not a second copy ─────────────
{
  const fenced = [...report.matchAll(/```promql\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const sorted = (xs) => [...xs].sort();
  const a = sorted(fenced);
  const b = sorted(allRules.map((r) => r.expr ?? ''));
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
    fail('w1-queries.md ↔ w1-rules.yaml',
      `expression sets differ (${a.length} fenced promql blocks vs ${b.length} rule exprs) — the parsed fixture must carry EXACTLY the report's queries`
      + (a.length === b.length ? `; first difference: ${JSON.stringify(a.find((x, i) => x !== b[i]))}` : ''));
  }
  if (fenced.length < 1) fail('w1-queries.md', 'no ```promql blocks — the report must publish the queries it documents');
}

// ── windows ───────────────────────────────────────────────────────────────
for (const { group, range } of EXPECTED_WINDOWS) {
  const g = groups.find((x) => x.name === group);
  if (!g) { fail('w1-rules.yaml', `missing rule group "${group}" — both observation windows must be rendered`); continue; }
  if (g.rules.length < 1) fail(`group ${group}`, 'has no rules');
  for (const rule of g.rules) {
    const ranges = [...(rule.expr ?? '').matchAll(/\[(\d+[smhdwy])\]/g)].map((m) => m[1]);
    const wrong = ranges.filter((r) => r !== range);
    if (wrong.length) fail(`rule ${rule.record}`, `range selector(s) ${JSON.stringify(wrong)} do not match the ${group} range [${range}]`);
  }
}
for (const g of groups) {
  if (!EXPECTED_WINDOWS.some((w) => w.group === g.name)) fail('w1-rules.yaml', `unexpected rule group "${g.name}" — windows are a fixed contract (§7)`);
}

// ── per-selector walk ─────────────────────────────────────────────────────
// Grafana interpolations contain braces, so they are masked before the brace
// parse (the same technique verify-profile-render.mjs uses).
const mask = (s) => s.replace(/\$\{[^}]*\}/g, '__GVAR__');
const NODE_FILTER = mask(`${LABEL}=~"\${node:regex}"`);
const covered = new Set();
let dualSpelledSelectors = 0;
let overSuffixedRejections = 0;
let selectorsSeen = 0;
/** @type {{group: string, readsBytes: boolean, readsActiveMs: boolean}[]} */
const allSourceDenominators = [];

const matchesSpelling = (spec, spelling) => (spec.kind === 'plain'
  ? spec.value === spelling
  : new RegExp(`^(?:${spec.value})$`).test(spelling));

for (const rule of allRules) {
  const where = `rule ${rule.record}`;
  const expr = mask(rule.expr ?? '');
  const selRe = /([a-zA-Z_:][a-zA-Z0-9_:]*)?\{([^}]*)\}/g;
  let m;
  let sawSelector = false;
  while ((m = selRe.exec(expr)) !== null) {
    sawSelector = true;
    selectorsSeen++;
    const text = expr.slice(m.index, selRe.lastIndex);
    const name = m[1] ?? '';
    const matchers = m[2];
    const nameMatch = /__name__=~"([^"]*)"/.exec(matchers);
    let spec;
    if (name) spec = { kind: 'plain', value: name };
    else if (nameMatch) spec = { kind: 'regex', value: nameMatch[1] };
    else { fail(where, `selector has neither a metric name nor a __name__ matcher: ${text}`); continue; }

    // node filter, per selector — a substring test on the whole expression
    // would pass a ratio where one of two selectors was left unfiltered
    if (!matchers.includes(NODE_FILTER)) fail(where, `selector lacks the profiled node filter ${NODE_FILTER}: ${text}`);

    // dual spelling: matching one form obliges the selector to match the other
    const reads = [];
    let sawOverSuffixed = false;
    for (const entry of SPELLING_INDEX) {
      // Checked BEFORE the native/translated gate: a selector matching only the
      // duplicated form reads nothing real, and must be reported as the
      // duplicated-unit bug rather than as an unknown metric.
      if (entry.overSuffixed && matchesSpelling(spec, entry.overSuffixed)) {
        sawOverSuffixed = true;
        overSuffixedRejections++;
        fail(where, `selector matches the duplicated-unit spelling "${entry.overSuffixed}" of ${entry.id} — no ingest route emits it (the unit word is NOT appended when the name already carries it): ${text}`);
      }
      const hitsNative = matchesSpelling(spec, entry.native);
      const hitsTranslated = matchesSpelling(spec, entry.translated);
      if (!hitsNative && !hitsTranslated) continue;
      reads.push(entry);
      if (!hitsNative) fail(where, `selector matches the translated spelling of ${entry.id} but NOT the native "${entry.native}" — one ingest route returns empty: ${text}`);
      if (!hitsTranslated) fail(where, `selector matches the native spelling of ${entry.id} but NOT the translated "${entry.translated}" — one ingest route returns empty: ${text}`);
      if (entry.dual && hitsNative && hitsTranslated) dualSpelledSelectors++;
    }
    if (!reads.length) {
      if (!sawOverSuffixed) fail(where, `selector reads no known W1 or corroborating instrument (typo or unmapped metric): ${text}`);
      continue;
    }
    for (const entry of reads) covered.add(entry.id);

    // runnable filters (§7.2) — stated as predicates, so they are checkable
    const ids = new Set(reads.map((r) => r.id));
    const requireFilters = (needed) => {
      for (const f of needed) if (!matchers.includes(f)) fail(where, `selector reading ${[...ids].join('/')} is missing the required filter ${f}: ${text}`);
    };
    if (['I1', 'I2', 'I3'].some((id) => ids.has(id))) requireFilters(ATTEMPT_FILTERS);
    if (['I4', 'I5'].some((id) => ids.has(id))) requireFilters(OPERATION_FILTERS);

    // ALL-SOURCE denominators: no `source` matcher at all on the selector
    const hasSourceMatcher = /(^|,)\s*source\s*(=~|!~|!=|=)/.test(matchers);
    if (!hasSourceMatcher) {
      allSourceDenominators.push({
        group: rule.group,
        readsBytes: ids.has('I2') || ids.has('I3'),
        readsActiveMs: ids.has('I4') && reads.some((r) => r.id === 'I4' && r.series === '_sum'),
      });
    }
  }
  if (!sawSelector) fail(where, 'expression contains no vector selector');
}

// ── inventory and surface floors ──────────────────────────────────────────
for (const inst of EXPECTED_INSTRUMENTS) {
  if (!covered.has(inst.id)) fail('metric inventory', `${inst.id} (${inst.name}) is never read — every W1 instrument must appear in the decision queries`);
}
for (const id of covered) {
  if (![...EXPECTED_INSTRUMENTS, ...EXPECTED_CORROBORATING].some((i) => i.id === id)) fail('metric inventory', `unexpected instrument ${id}`);
}
if (selectorsSeen < EXPECTED_INSTRUMENTS.length) fail('w1-rules.yaml', `only ${selectorsSeen} selectors across all rules — the expected query surface is missing`);
// The dual-spelling assertion can only discriminate on instruments whose two
// spellings actually differ; if a refactor dropped every byte/duration query
// the check above would pass vacuously.
if (dualSpelledSelectors < 1) fail('w1-rules.yaml', 'no selector exercises a dual-spelling (__name__ alternation) instrument — the dual-spelling assertion would be vacuous');
// Same anti-vacuity discipline for the duplicated-unit rejection: it can only
// discriminate on instruments whose name already carries their unit word. If a
// refactor removed both `By` counters, the rejection would silently become a
// check over an empty set — green, and proving nothing.
if (!SPELLING_INDEX.some((e) => e.overSuffixed)) {
  fail('metric inventory', 'no instrument exercises the duplicated-unit rule (a name already ending in its unit word) — the duplicated-spelling rejection would be vacuous');
}

// ── source vocabulary and the §5.5 family mapping ─────────────────────────
{
  const sourceMatchers = [...rulesText.matchAll(/\b(source|owner_source|joiner_source)\s*(=~|!~|!=|=)\s*\\"([^"\\]*)\\"/g)];
  if (!sourceMatchers.length) fail('w1-rules.yaml', 'no source matcher anywhere — the family mapping is not applied');
  for (const [, key, op, value] of sourceMatchers) {
    for (const token of value.split('|')) {
      if (!ALL_SOURCES.includes(token)) {
        fail('source vocabulary', `${key}${op}"${value}" names "${token}", which is not one of the eight SYNC_ADMISSION_SOURCES ${JSON.stringify(ALL_SOURCES)}`);
      }
    }
  }
  const need = (fragment, why) => {
    if (!rulesText.includes(fragment.replaceAll('"', '\\"'))) fail('family mapping (§5.5)', `missing ${why}: ${fragment}`);
  };
  for (const f of EXPECTED_FAMILIES) {
    if (f.role === 'invalidating') continue;
    need(`source=~"${f.sources.join('|')}"`, `the "${f.id}" family predicate`);
    need(`owner_source=~"${f.sources.join('|')}"`, `the "${f.id}" cross-family join owner predicate`);
    need(`joiner_source!~"${f.sources.join('|')}"`, `the "${f.id}" cross-family join joiner predicate`);
  }
  // The invalidating family MUST be the negation of the classified set, not a
  // list of known-bad values: `unspecified` and any future member added to
  // SYNC_ADMISSION_SOURCES without updating the table both have to surface.
  // Pinned at BOTH sites — the evidence gate and the cross-family join
  // enumeration. Pinning only the gate let a mutation that rewrote the join
  // arm to `owner_source=~"unspecified"` survive, which would have stopped a
  // future unlisted source's joins from invalidating the window.
  //
  // MUTATION-MATRIX REQUIREMENT: the gate and the join arm are PARTIALLY
  // overlapping, not subsuming. The join arm fires on an unlisted source only
  // when a join occurs; the gate fires either way. A scenario exercising the
  // gate must therefore carry an unlisted-source sample with NO join, or the
  // join arm masks a mutant that deletes the gate. Do not drop either
  // assertion on the grounds that the other appears to cover it.
  need(`source!~"${CLASSIFIED_SOURCES.join('|')}"`, 'the invalidating-source evidence gate (negation of the classified sources)');
  need(`owner_source!~"${CLASSIFIED_SOURCES.join('|')}"`, 'the invalidating-family cross-join owner predicate (negation, not a list)');
  need(`joiner_source=~"${CLASSIFIED_SOURCES.join('|')}"`, 'the invalidating-family cross-join joiner predicate');
  need(`source=~"${ELIGIBLE_SOURCES.join('|')}"`, 'the eligible (foreground + recurring) predicate');
  for (const s of ALL_SOURCES) {
    if (!report.includes(s)) fail('w1-queries.md', `source "${s}" is absent from the report — the family table must be exhaustive over the eight-member vocabulary`);
  }
}

// ── ALL-SOURCE denominators, per window ───────────────────────────────────
for (const { group } of EXPECTED_WINDOWS) {
  const inWindow = allSourceDenominators.filter((d) => d.group === group);
  if (!inWindow.some((d) => d.readsBytes)) {
    fail(`group ${group}`, 'no ALL-SOURCE (no source matcher) byte denominator — the two-axis materiality rule of §7.3 cannot be computed without it');
  }
  if (!inWindow.some((d) => d.readsActiveMs)) {
    fail(`group ${group}`, 'no ALL-SOURCE (no source matcher) I4 _sum denominator — the strain floor is uncomputable without it');
  }
}

if (violations.length) {
  console.error(`W1 RENDER VERIFY FAILED (${violations.length} violation(s), dir=${DIR}, label=${LABEL}):`);
  for (const v of violations) console.error('  - ' + v);
  process.exit(1);
}
console.log(`w1 render verify OK: dir=${DIR} label=${LABEL} instruments=${EXPECTED_INSTRUMENTS.length} rules=${allRules.length} selectors=${selectorsSeen}`);

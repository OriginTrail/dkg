#!/usr/bin/env node
// FIBO reasoner on the Chorus memory layers.
//
//   node run.mjs              Paced, narrated walkthrough (offline — always runs)
//   node run.mjs --no-pause   Same, no Enter prompts
//   node run.mjs --json       NDJSON, one line per step (agent-friendly)
//   node run.mjs --live       Also drive a real daemon's WM→SWM→VM KA lifecycle
//
// Offline mode needs nothing but `pnpm install` (eye-js runs in-process).
// --live additionally needs a healthy daemon (`dkg start`) and devnet.

import { createInterface } from 'node:readline';

import * as fmt from './lib/format.mjs';
import { OPENING, OWNERSHIP_DIAGRAM, PHASES, CLOSING } from './lib/narrative.mjs';
import { DEMO_NS, ENTITY_NS, ENTITIES, OWNERSHIP, labelOf, ownershipKaName, ownershipQuads } from './lib/data.mjs';
import { loadSources, reason, explain, shorten, isIndirect } from './lib/reasoner.mjs';
import * as live from './lib/live.mjs';

const JSON_MODE = process.argv.includes('--json');
const NO_PAUSE = process.argv.includes('--no-pause') || JSON_MODE;
const LIVE = process.argv.includes('--live');

const PROV = 'http://www.w3.org/ns/prov#';
const DKG_ONT = 'https://ontology.origintrail.io/dkg/1.0#';
const REASONER_AGENT = 'urn:dkg:agent:eye-js-reasoner';
const NOW = '2026-06-08T00:00:00Z'; // fixed for deterministic, replayable output

const say = (...lines) => { if (!JSON_MODE) console.log(lines.join('\n')); };
const emit = (obj) => { if (JSON_MODE) process.stdout.write(JSON.stringify(obj) + '\n'); };

async function pause() {
  if (NO_PAUSE) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((r) => rl.question(fmt.dim('\n  ⏎  Enter to continue…  '), () => r()));
  rl.close();
}

const fact = (t) => `${shorten(t.s)} ${fmt.bold(shorten(t.p))} ${shorten(t.o)}`;
const prettyJson = (o) => fmt.dim(JSON.stringify(o, null, 2).split('\n').slice(0, 24).join('\n'));

// Build the inference KA content: the derived triples + PROV provenance, in the
// same spirit as the daemon's buildSemanticEnrichmentProvenanceQuads.
function inferenceQuads(triples) {
  const enrich = 'urn:dkg:semantic-enrichment:fibo-control';
  const quads = [];
  const sources = new Set();
  for (const t of triples) {
    quads.push({ subject: t.s, predicate: t.p, object: t.o });
    quads.push({ subject: t.s, predicate: `${PROV}wasAttributedTo`, object: REASONER_AGENT });
    for (const d of explain(t).derivedFrom) sources.add(d);
  }
  for (const s of sources) {
    quads.push({ subject: enrich, predicate: `${PROV}wasDerivedFrom`, object: `urn:dkg:ka:${s}` });
  }
  quads.push({ subject: enrich, predicate: `${DKG_ONT}generatedBy`, object: REASONER_AGENT });
  quads.push({
    subject: enrich,
    predicate: `${DKG_ONT}generatedAt`,
    object: `"${NOW}"^^http://www.w3.org/2001/XMLSchema#dateTime`,
  });
  return quads;
}

async function main() {
  let auth = null;
  let cgId = null;
  if (LIVE) {
    try {
      auth = await live.resolveAuth();
    } catch (e) {
      say(fmt.fail(`--live unavailable: ${e.message}`));
      say(fmt.note('Continuing offline — the narrative is identical.\n'));
    }
  }

  // ── Opening ───────────────────────────────────────────────────────────
  say(fmt.header(OPENING.title));
  for (const p of OPENING.body) say('\n' + p);
  say('\n' + OWNERSHIP_DIAGRAM);
  emit({ phase: 'opening', live: Boolean(auth) });
  await pause();

  // ── Phase 0 — Setup ───────────────────────────────────────────────────
  const { fibo, ownership, rules } = await loadSources();
  say(fmt.header(`${PHASES.setup.id} — ${PHASES.setup.title}`));
  say('\n' + PHASES.setup.body + '\n');
  say(fmt.kv('FIBO slice', `${ENTITIES.length} entities, all fibo:LegalEntity`));
  say(fmt.kv('Rules', 'rules/control.n3 — 2 N3 rules (majority control, transitivity)'));
  say(fmt.kv('Facts', `${OWNERSHIP.length} voting-share stakes`));
  if (auth) {
    try {
      const r = await live.ensureContextGraph(`fibo-reasoner-${Date.now().toString(36)}`);
      cgId = r.contextGraphId;
      say(fmt.success(`context graph: ${cgId}${r.created ? ' (created)' : ' (reused)'}`));
    } catch (e) {
      say(fmt.warn(`context-graph create failed — falling back to offline: ${e.message}`));
      auth = null;
    }
  }
  emit({ phase: 'setup', entities: ENTITIES.length, rules: 2, facts: OWNERSHIP.length, contextGraphId: cgId });
  await pause();

  // ── Phase 1 — Working Memory ──────────────────────────────────────────
  say(fmt.header(`${PHASES.wm.id} — ${PHASES.wm.title}`));
  say('\n' + PHASES.wm.body + '\n');
  for (const o of OWNERSHIP) {
    const name = ownershipKaName(o);
    const line = `${labelOf(o.owner)} owns ${o.pct}% of ${labelOf(o.company)}`;
    let status = fmt.dim('(offline)');
    if (auth) {
      const res = await live.writeWorkingMemory(auth, cgId, name, ownershipQuads(o));
      status = res.ok ? fmt.green(`→ KA ${name}`) : fmt.red(`HTTP ${res.status}`);
    }
    say('  ' + fmt.layerTag('WM', `${line}  ${status}`));
    emit({ phase: 'wm', ka: name, owner: o.owner, company: o.company, pct: o.pct });
  }
  say('\n' + fmt.note('All four facts are now Working Memory: asserted, local, nothing inferred.'));
  await pause();

  // ── Phase 2 — Reason ──────────────────────────────────────────────────
  say(fmt.header(`${PHASES.reason.id} — ${PHASES.reason.title}`));
  say('\n' + PHASES.reason.body + '\n');
  const { triples } = await reason({ fibo, ownership, rules });
  for (const t of triples) {
    const tag = isIndirect(t) ? fmt.magenta('  ◀ derived, not asserted') : '';
    say('  ' + fact(t) + tag);
    emit({ phase: 'reason', subject: shorten(t.s), predicate: shorten(t.p), object: shorten(t.o), indirect: isIndirect(t) });
  }
  const hidden = triples.find(isIndirect);
  if (hidden) {
    say('');
    say(fmt.success(
      `${fmt.bold(labelOf(hidden.s.slice(ENTITY_NS.length)))} controls ` +
      `${fmt.bold(labelOf(hidden.o.slice(ENTITY_NS.length)))} — through the chain, not the cap table.`,
    ));
  }
  say(fmt.note('Meridian (30%) produced nothing: below the 50% control threshold. The rule encodes the law, not a guess.'));
  await pause();

  // ── Phase 3 — Provenance & SWM ────────────────────────────────────────
  say(fmt.header(`${PHASES.provenance.id} — ${PHASES.provenance.title}`));
  say('\n' + PHASES.provenance.body + '\n');
  for (const t of triples) {
    const why = explain(t);
    say('  ' + fmt.layerTag('SWM', fact(t)));
    say(fmt.kv('  rule', why.rule));
    say(fmt.kv('  ' + fmt.dim(why.gloss), ''));
    for (const b of why.because) say(fmt.bullet(b));
    say(fmt.kv('  wasDerivedFrom', why.derivedFrom.map((d) => `urn:dkg:ka:${d}`).join('  ') || fmt.dim('—')));
    say(fmt.kv('  generatedBy', REASONER_AGENT));
    say('');
    emit({ phase: 'provenance', triple: fact(t), rule: why.rule, derivedFrom: why.derivedFrom });
  }
  const infQuads = inferenceQuads(triples);
  if (auth) {
    const res = await live.shareToSwm(auth, cgId, 'fibo-control-inference', infQuads);
    say(res.ok
      ? fmt.success('inference KA created & promoted to Shared Working Memory (alsoShareSwm)')
      : fmt.red(`SWM share failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`));
  } else {
    say(fmt.note(`Would write ${infQuads.length} quads (inference + provenance) and swm/share them.`));
  }
  await pause();

  // ── Phase 4 — Verifiable Memory ─────────────────────────────────────────
  say(fmt.header(`${PHASES.vm.id} — ${PHASES.vm.title}`));
  say('\n' + PHASES.vm.body + '\n');
  if (auth) {
    const pub = await live.publishToVm(auth, cgId, 'fibo-control-inference');
    say(pub.ok ? fmt.success('published to Verifiable Memory (vm/publish)') : fmt.red(`vm/publish failed: HTTP ${pub.status}`));
    const sparql = `PREFIX demo: <${DEMO_NS}>
SELECT ?a ?c WHERE { ?a demo:indirectlyControls ?c }`;
    const q = live.querySparql(cgId, sparql);
    say(fmt.kv('SPARQL', 'SELECT ?a ?c WHERE { ?a demo:indirectlyControls ?c }'));
    say(q.parsed ? prettyJson(q.parsed) : fmt.dim((q.raw || q.stderr || '').trim().slice(0, 400)));
    emit({ phase: 'vm', published: pub.ok, query: q.parsed ?? null });
  } else {
    if (hidden) {
      say('  ' + fmt.layerTag('VM', fmt.bold(fact(hidden))));
      const why = explain(hidden);
      say(fmt.dim('     provenance chain on the verified fact:'));
      for (const b of why.because) say(fmt.bullet(b));
      say(fmt.bullet(`rule: ${why.rule}`));
      say(fmt.bullet(`generatedBy: ${REASONER_AGENT}`));
    }
    say('\n' + fmt.note('Run with --live against a healthy daemon to publish and SPARQL it back for real.'));
    emit({ phase: 'vm', published: false, offline: true });
  }
  await pause();

  // ── Closing ───────────────────────────────────────────────────────────
  say(fmt.header(CLOSING.title));
  for (const p of CLOSING.body) say('\n' + p);
  say('');
  emit({ phase: 'closing' });
}

main().catch((e) => {
  if (JSON_MODE) emit({ phase: 'error', error: String(e?.message ?? e) });
  else console.error(fmt.fail(String(e?.stack ?? e)));
  process.exit(1);
});

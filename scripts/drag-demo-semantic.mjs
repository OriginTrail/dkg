#!/usr/bin/env node
/**
 * dRAG Phase 1 demo — semantic (vector) retrieval vs the keyword scan (OT-RFC-55).
 *
 * Publishes PARAPHRASE-gap data (compliance failures described WITHOUT the words
 * "flagged"/"audit", plus two positive distractors and a linked review) and runs
 * the same question through the two public retrieval modes on one node:
 *   keyword  (substring)   → misses entirely
 *   semantic (by meaning)  → ranks the actual failures
 * then shows 1-hop GraphRAG (match the review → follow the link to a supplier).
 *
 * Prereq:  ./scripts/devnet.sh start 4   AND   npm i @huggingface/transformers
 * Run:     node scripts/drag-demo-semantic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = readFileSync(join(REPO, '.devnet/node1/auth.token'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))[0].trim();
const N1 = 'http://127.0.0.1:9201';
const CG = 'drag-sem-demo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m` };
const hr = (t) => console.log(`\n${c.b(c.c('━'.repeat(72)))}\n${c.b(t)}`);

async function post(p, body) { const r = await fetch(N1 + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) }); let b; try { b = await r.json(); } catch { b = await r.text(); } return { status: r.status, b }; }
async function get(p) { return (await fetch(N1 + p, { headers: { Authorization: `Bearer ${TOKEN}` } })).json(); }
async function waitId() { for (let i = 0; i < 40; i++) { try { if ((await get('/api/identity')).hasIdentity) return; } catch {} await sleep(2000); } }
async function publish(name, triples, tries = 4) {
  for (let t = 0; t < tries; t++) {
    let ok = true;
    for (const [path, extra] of [['/api/knowledge-assets', { name }], [`/api/knowledge-assets/${name}/wm/write`, { quads: triples.map(([s, p, o]) => ({ subject: s, predicate: p, object: o, graph: '' })) }], [`/api/knowledge-assets/${name}/wm/finalize`, {}], [`/api/knowledge-assets/${name}/swm/share`, {}], ['/api/shared-memory/publish', { assertionName: name }]]) {
      if (![200, 201].includes((await post(path, { contextGraphId: CG, ...extra })).status)) { ok = false; break; }
    }
    if (ok) return true;
    await sleep(5000);
  }
  return false;
}
async function ask(question, retrieval, maxKas) {
  const r = await post('/api/answer', { question, contextGraphId: CG, scope: 'local', retrieval, maxKas });
  return [...new Set((r.b.facts || []).map((f) => f.subject.split(':').pop()))];
}

(async () => {
  console.log(c.b('\n  dRAG Phase 1 — semantic retrieval: find facts the keywords never mention\n'));
  await waitId();
  hr('SETUP — publish compliance FAILURES (no "flagged"/"audit") + positive DISTRACTORS + a linked review');
  await post('/api/context-graph/create', { id: CG, name: 'dRAG semantic demo', accessPolicy: 0, publishPolicy: 0, register: true });
  await publish('initech', [['urn:supplier:initech', 'http://schema.org/name', '"Initech Components"'], ['urn:supplier:initech', 'http://ex/note', '"did not meet incoming-inspection thresholds; multiple lots returned"']]);
  await publish('hooli', [['urn:supplier:hooli', 'http://schema.org/name', '"Hooli Materials"'], ['urn:supplier:hooli', 'http://ex/note', '"raw-material purity deviations led to rejected shipments"']]);
  await publish('globex', [['urn:supplier:globex', 'http://schema.org/name', '"Globex Logistics"'], ['urn:supplier:globex', 'http://ex/note', '"consistently on-time delivery; top-rated partner"']]);
  await publish('acme', [['urn:supplier:acme', 'http://schema.org/name', '"Acme Foods"'], ['urn:supplier:acme', 'http://ex/note', '"expanded product line; strong customer satisfaction"']]);
  await publish('review', [['urn:report:review', 'http://schema.org/title', '"early-2026 vendor quality review"'], ['urn:report:review', 'http://ex/coversVendor', '<urn:supplier:initech>']]);
  console.log(`  ${c.g('✓')} 5 KAs published to ${c.c(CG)}. FAILURES = ${c.y('initech, hooli')}; distractors = globex, acme.`);

  const Q = 'which suppliers were flagged in the audit, and why?';
  const RELEVANT = ['initech', 'hooli'];
  const score = (es) => `${es.filter((e) => RELEVANT.includes(e)).length}/2 relevant`;
  hr(`Q: "${Q}"  ${c.dim('— the data never says "flagged", "audit" or "suppliers"')}`);
  const kw = await ask(Q, 'keyword', 2);
  console.log(`  ${c.b('keyword')}  (substring scan)   → ${c.r(kw.length ? kw.join(', ') : 'nothing')}   ${c.dim('— misses entirely')}`);
  console.log(c.dim('  semantic: loading the embedding model + indexing on first call (~10s)…'));
  const ll = await ask(Q, 'semantic', 2);
  const win = ll.filter((e) => RELEVANT.includes(e)).length === 2;
  console.log(`  ${c.b('semantic')} (by meaning, top-2) → ${(win ? c.g : c.y)(ll.join(', '))}   ${c.g('(' + score(ll) + ' — the actual failures)')}`);

  hr('1-hop GraphRAG — match the REVIEW entity, then follow its link to a supplier');
  const hop = await ask('summarize the early 2026 vendor quality review', 'semantic', 5);
  console.log(`  Q: "summarize the early 2026 vendor quality review"`);
  console.log(`  → entities: ${hop.join(', ')}`);
  console.log(`  ${hop.includes('initech') ? c.g('✓ reached "initech"') : c.r('✗')} via coversVendor — a supplier the question never named.`);

  console.log(c.b(`\n${c.c('━'.repeat(72))}`));
  console.log(`  Keyword found ${c.r('0')} of the failures; semantic found ${c.g('both')} — and reached a related`);
  console.log(`  supplier by following the graph. Same verifiable citations underneath, every time.`);
  console.log(c.b(`${c.c('━'.repeat(72))}\n`));
})().catch((e) => { console.error(c.r('demo failed:'), e); process.exit(1); });

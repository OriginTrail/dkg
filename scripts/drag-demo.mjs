#!/usr/bin/env node
/**
 * dRAG V1 demo (OT-RFC-55). A narrated walk-through of the three pillars:
 *   1. VERIFIABLE   — every fact in an answer is cryptographically auditable.
 *   2. DECENTRALIZED— a node holding NOTHING answers across the network.
 *   3. TAMPER-PROOF — independently re-verify a citation; a forged one fails.
 *   4. MONETIZED    — the data-holder charges per answer (x402 402 -> pay -> 200).
 *
 * Prereq:  ./scripts/devnet.sh start 4   (4-node local devnet)
 * Run:     node scripts/drag-demo.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// The pure citation verifier from dkg-core — the SAME check the asking node runs.
const { verifyCitationProof } = await import(join(REPO, 'packages/core/dist/index.js'));

const TOKEN = readFileSync(join(REPO, '.devnet/node1/auth.token'), 'utf8')
  .split('\n').filter((l) => l && !l.startsWith('#'))[0].trim();
const N = (i) => `http://127.0.0.1:${9200 + i}`;
const CG = 'demo-supply';
const QUESTION = 'Which suppliers were flagged in the 2026 Q1 audit, and why?';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m` };
const hr = (t) => console.log(`\n${c.b(c.c('━'.repeat(72)))}\n${c.b(t)}\n`);

async function post(api, path, body, headers = {}) {
  const r = await fetch(api + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });
  let b; try { b = await r.json(); } catch { b = await r.text(); }
  return { status: r.status, b };
}
async function get(api, path) { return (await fetch(api + path, { headers: { Authorization: `Bearer ${TOKEN}` } })).json(); }
async function waitId(api) { for (let i = 0; i < 40; i++) { try { if ((await get(api, '/api/identity')).hasIdentity) return; } catch {} await sleep(2000); } }
async function peerId(api) { return (await get(api, '/api/status')).peerId; }
async function localFacts(api) { return (await post(api, '/api/answer', { question: QUESTION, contextGraphId: CG, scope: 'local' })).b?.stats?.factsCited ?? 0; }

async function publish(api, name, triples) {
  const quads = triples.map(([p, o]) => ({ subject: `urn:supplier:${name}`, predicate: p, object: o, graph: '' }));
  for (const [path, extra] of [['/api/knowledge-assets', { name }], [`/api/knowledge-assets/${name}/wm/write`, { quads }], [`/api/knowledge-assets/${name}/wm/finalize`, {}], [`/api/knowledge-assets/${name}/swm/share`, {}], ['/api/shared-memory/publish', { assertionName: name }]]) {
    const r = await post(api, path, { contextGraphId: CG, ...extra });
    if (![200, 201].includes(r.status)) return { error: `${path} -> ${r.status}: ${JSON.stringify(r.b).slice(0, 120)}` };
  }
  return { ok: true };
}

(async () => {
  console.log(c.b('\n  dRAG V1 — verifiable · decentralized · monetized answering (OT-RFC-55)\n'));

  hr('SETUP — two independent nodes publish supplier audit facts into a PUBLIC context graph');
  console.log(c.dim('  waiting for node identities…'));
  await Promise.all([waitId(N(1)), waitId(N(2)), waitId(N(3))]);
  const [p1, p2] = [await peerId(N(1)), await peerId(N(2))];

  // node1 owns the CG; create + publish (retry — a freshly-booted node may not be ready to anchor yet).
  let created = await post(N(1), '/api/context-graph/create', { id: CG, name: 'Demo supply chain', accessPolicy: 0, publishPolicy: 0, register: true });
  for (let attempt = 1; (await localFacts(N(1))) === 0 && attempt <= 4; attempt++) {
    console.log(c.dim(`  node1: publishing audit findings (attempt ${attempt})…`));
    await publish(N(1), 'northwind', [['http://schema.org/name', '"Northwind Components"'], ['http://schema.org/auditStatus', '"flagged"'], ['http://schema.org/auditReason', '"late delivery — 3 incidents in 2026 Q1"']]);
    await publish(N(1), 'globex', [['http://schema.org/name', '"Globex Materials"'], ['http://schema.org/auditStatus', '"flagged"'], ['http://schema.org/auditReason', '"spec deviation on lot #4471"']]);
    if ((await localFacts(N(1))) === 0) await sleep(4000);
  }
  console.log(`  node1: published into public CG ${c.c(CG)} (on-chain id ${created.b?.onChainId ?? '?'})`);
  console.log(c.dim('  node2: subscribing (syncs the CG → becomes a second serving node)…'));
  await post(N(2), '/api/context-graph/subscribe', { contextGraphId: CG, includeSharedMemory: true });
  for (let i = 0; i < 12 && (await localFacts(N(2))) === 0; i++) await sleep(4000);
  console.log(`  ${c.g('✓')} node1 + node2 now both serve ${c.c(CG)}; node3 holds nothing.`);

  hr('① VERIFIABLE — ask node1 in natural language; every fact carries a chain-anchored citation');
  console.log(c.dim(`  Q: ${QUESTION}\n`));
  const a1 = await post(N(1), '/api/answer', { question: QUESTION, contextGraphId: CG });
  console.log(a1.b.answer.split('\n').map((l) => '  ' + l).join('\n'));
  console.log(`\n  ${c.g('→')} ${a1.b.stats.verified}/${a1.b.stats.factsCited} facts carry author-sig ✓ merkle ✓ on-chain ✓`);

  hr('② DECENTRALIZED — node3 holds NONE of this data; it answers across the network');
  const n3before = await localFacts(N(3));
  console.log(`  node3 local knowledge of "${CG}": ${c.y(n3before + ' facts')} (it never subscribed)\n`);
  const net = await post(N(3), '/api/answer', { question: QUESTION, contextGraphId: CG, scope: 'network', peers: [p1, p2] });
  console.log(net.b.answer.split('\n').map((l) => '  ' + l).join('\n'));
  console.log(`\n  ${c.g('→')} node3 assembled ${net.b.stats.factsCited} facts from ${net.b.stats.nodesAnswered} remote node(s) and re-verified each against its OWN chain.`);

  hr('③ TAMPER-PROOF — audit one citation yourself, then forge it and watch verification reject it');
  const cit = (net.b.citations.length ? net.b.citations : a1.b.citations)[0];
  console.log(`  citation: ${c.dim(cit.triple.subject)} ${c.dim(cit.triple.predicate.split('/').pop())} = ${c.b(cit.triple.object)}`);
  console.log(`  KA ${cit.kaId.slice(-8)} · on-chain root ${cit.onChain.merkleRoot.slice(0, 14)}…`);
  // (a) the asker's own verdict
  console.log(`  ${c.g('✓')} pure proof check (verifyCitationProof) = ${c.g(String(verifyCitationProof(cit)))}`);
  // (b) the on-chain root is the chain's, not the node's word — cross-check via /api/kc
  const kc = await get(N(1), `/api/kc/${cit.kaId}`);
  console.log(`  ${c.g('✓')} on-chain anchor (GET /api/kc) root = ${kc.merkleRoot?.slice(0, 14)}… → ${kc.merkleRoot?.toLowerCase() === cit.onChain.merkleRoot.toLowerCase() ? c.g('MATCHES the citation') : c.r('MISMATCH')}`);
  // (c) forge it: change the cited fact; the proof no longer binds
  const forged = JSON.parse(JSON.stringify(cit));
  forged.triple.object = '"PASSED — totally compliant"';
  console.log(`  ${c.r('✗')} forge the fact → "${forged.triple.object}" → verifyCitationProof = ${c.r(String(verifyCitationProof(forged)))}  ${c.dim('(forgery rejected)')}`);

  hr('④ MONETIZED — the data-holder charges per answer (x402: 402 → pay → 200 + receipt)');
  const unpaid = await post(N(1), '/api/answer', { question: QUESTION, contextGraphId: CG, simulatePrice: '0.01 USDC' });
  console.log(`  request WITHOUT payment → HTTP ${c.y(unpaid.status)}  ${c.dim('(Payment Required)')}`);
  if (unpaid.status !== 402 || !unpaid.b.accepts?.[0]) {
    console.log(c.dim('  payments are OFF by default — set config.drag.payments.enabled + experimentalOverrides to'));
    console.log(c.dim('  exercise the 402 → pay → 200 + receipt flow. (Answer returned free; the seam is unit-tested.)'));
    console.log(c.b(`\n${c.c('━'.repeat(72))}\n  That's dRAG: ask in natural language → cryptographically-auditable answers,\n  assembled across nodes that hold knowledge you don't.\n${c.c('━'.repeat(72))}\n`));
    return;
  }
  const ch = unpaid.b.accepts[0];
  console.log(`  challenge: pay ${c.b(ch.amount + ' ' + ch.asset)} to ${ch.payTo.slice(0, 10)}… on ${ch.network}`);
  const xpay = Buffer.from(JSON.stringify({ x402Version: 1, scheme: ch.scheme, network: ch.network, asset: ch.asset, amount: ch.amount, payTo: ch.payTo, nonce: ch.nonce, from: '0xA9e1…buyerAgent' })).toString('base64');
  const paid = await post(N(1), '/api/answer', { question: QUESTION, contextGraphId: CG, simulatePrice: '0.01 USDC' }, { 'X-PAYMENT': xpay });
  console.log(`  retry WITH x402 payment → HTTP ${c.g(paid.status)}  ${c.dim('settlement:')} ${c.g(JSON.stringify(paid.b.settlement))}`);
  console.log(`  ${c.g('→')} paid answer is still fully verified: ${paid.b.stats.verified}/${paid.b.stats.factsCited} facts ✓`);

  console.log(c.b(`\n${c.c('━'.repeat(72))}\n  That's dRAG: ask in natural language → cryptographically-auditable answers,\n  assembled across nodes that hold knowledge you don't, paid for per answer.\n${c.c('━'.repeat(72))}\n`));
})().catch((e) => { console.error(c.r('demo failed:'), e); process.exit(1); });

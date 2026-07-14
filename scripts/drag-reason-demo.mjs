#!/usr/bin/env node
/**
 * dRAG REASONING demo — retrieve → verify → REASON → prove (OT-RFC-55 + EYE).
 *
 * A multi-agent CODE context graph: agents publish on-chain decision/code/review
 * traces (in the graph root), and the team's POLICY lives as managed, verifiable
 * rules in a dedicated `rules` sub-graph. EYE reasons over the COMPLETE graph
 * (root + sub-graphs) and DERIVES a governance conclusion nobody published —
 * "which change violates the review policy" — using NEGATION + TRANSITIVITY, with
 * every proof leaf a chain-verified citation. A second, DISABLED rule shows that
 * rules are managed (a disabled rule never fires).
 *
 * Prereq:  ./scripts/devnet.sh start 4   AND   (cd packages/cli && pnpm i eyereasoner)
 * Run:     node scripts/drag-reason-demo.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = readFileSync(join(REPO, '.devnet/node1/auth.token'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))[0].trim();
const N1 = 'http://127.0.0.1:9201';
const CG = 'code-graph-demo';
const NS = 'http://ex/code#';
const R = 'https://ontology.origintrail.io/drag/reasoning#'; // drag reasoning vocab
const A = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m` };
const hr = (t) => console.log(c.b(`\n${c.c('━'.repeat(76))}\n${t}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (u) => String(u).split(/[/#]/).pop();
const lit = (o) => (typeof o === 'string' && o.startsWith('"') ? o.slice(1).replace(/"$/, '') : local(o));
const esc = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

async function post(p, body) {
  const r = await fetch(N1 + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
  let b; try { b = await r.json(); } catch { b = await r.text(); }
  return { status: r.status, b };
}
// Named-KA lifecycle publish (the canonical authoring path): create → WM write
// → WM finalize → SWM share → VM publish. IRI objects are BARE.
async function pub(name, quads, subGraphName) {
  const sub = subGraphName ? { subGraphName } : {};
  for (let attempt = 0; attempt < 6; attempt++) {
    let ok = true;
    const steps = [
      ['/api/knowledge-assets', {}],
      [`/api/knowledge-assets/${name}/wm/write`, { quads }],
      [`/api/knowledge-assets/${name}/wm/finalize`, {}],
      [`/api/knowledge-assets/${name}/swm/share`, {}],
      [`/api/knowledge-assets/${name}/vm/publish`, {}],
    ];
    for (const [path, extra] of steps) {
      const { status } = await post(path, { contextGraphId: CG, name, ...sub, ...extra });
      if (![200, 201].includes(status)) { ok = false; break; }
    }
    if (ok) return true;
    await sleep(5000);
  }
  return false;
}
const T = (s, p, o) => ({ subject: NS + s, predicate: p.startsWith('http') ? p : NS + p, object: o, graph: '' });
const ref = (x) => NS + x; // bare IRI object

// The review policy (single-line N3 so the body is one literal).
const POLICY_N3 =
  `@prefix code: <${NS}>. @prefix log: <http://www.w3.org/2000/10/swap/log#>. @prefix list: <http://www.w3.org/2000/10/swap/list#>. ` +
  `{ ?c code:changes ?f } => { ?f code:affectedBy ?c } . ` +
  `{ ?caller code:calls ?f . ?f code:affectedBy ?c } => { ?caller code:affectedBy ?c } . ` +
  `{ ?c a code:Change . ?c code:changes ?f . ?f code:inModule ?m . ?m code:securityCritical "true" . ` +
  `( ?a { ?c code:reviewedBy ?r . ?r code:reviewer ?a . ?a code:clearance "senior" } ?L ) log:collectAllIn _:s . ?L list:length 0 . } ` +
  `=> { ?c code:violatesReviewPolicy "true" } .`;
// A second rule that WOULD flag every change — but it is published DISABLED.
const FLAG_ALL_N3 = `@prefix code: <${NS}>. { ?c a code:Change } => { ?c code:flagged "true" } .`;

// A managed rule = a typed, status-bearing KA: a drag:ReasoningRule.
const rule = (id, n3, status) => [
  { subject: 'urn:rule:' + id, predicate: A, object: R + 'ReasoningRule', graph: '' },
  { subject: 'urn:rule:' + id, predicate: R + 'ruleStatus', object: esc(status), graph: '' },
  { subject: 'urn:rule:' + id, predicate: R + 'ruleN3', object: esc(n3), graph: '' },
];

(async () => {
  console.log(c.b('\n  dRAG reasoning — rules live in a managed `rules` sub-graph; EYE reasons over the whole context graph\n'));
  for (let i = 0; i < 30; i++) { try { if ((await (await fetch(N1 + '/api/identity', { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).hasIdentity) break; } catch {} await sleep(2000); }

  hr('SETUP — code/decision/review facts (graph root) + POLICY rules (a `rules` sub-graph)');
  await post('/api/context-graph/create', { id: CG, name: 'multi-agent code graph', accessPolicy: 0, publishPolicy: 0, register: true });
  await sleep(2000);
  await post('/api/sub-graph/create', { contextGraphId: CG, subGraphName: 'rules' });

  const ok = {};
  ok.code = await pub('code-map', [
    T('apiGateway', 'calls', ref('handleAuth')), T('handleAuth', 'calls', ref('validateToken')),
    T('validateToken', 'inModule', ref('authModule')), T('sessionStore', 'inModule', ref('authModule')),
    T('authModule', 'securityCritical', '"true"'),
  ]);
  ok.d1 = await pub('D1-decision', [
    T('D1', A, ref('Change')), T('D1', 'author', ref('agentA')), T('D1', 'changes', ref('validateToken')), T('D1', 'status', '"active"'),
    T('D1', 'reviewedBy', ref('R1')), T('R1', 'reviewer', ref('agentC')), T('agentC', 'clearance', '"standard"'),
  ]);
  ok.d2 = await pub('D2-decision', [
    T('D2', A, ref('Change')), T('D2', 'author', ref('agentB')), T('D2', 'changes', ref('sessionStore')), T('D2', 'status', '"active"'),
    T('D2', 'reviewedBy', ref('R2')), T('R2', 'reviewer', ref('agentV')), T('agentV', 'clearance', '"senior"'),
  ]);
  // rules → the `rules` sub-graph: one active policy, one DISABLED rule.
  ok.policy = await pub('rule-senior-review', rule('senior-review', POLICY_N3, 'active'), 'rules');
  ok.flag = await pub('rule-flag-all', rule('flag-all', FLAG_ALL_N3, 'disabled'), 'rules');

  const allOk = Object.values(ok).every(Boolean);
  console.log(`  ${allOk ? c.g('✓') : c.r('✗')} facts → ${c.c(CG)} (root) · rules → ${c.c(CG + '/rules')} sub-graph`);
  console.log(c.d('  rules: ') + c.g('senior-review [active]') + c.d(' — critical change needs a senior review · ') + c.r('flag-all [disabled]') + c.d(' — would flag every change'));
  console.log(c.d('  D1 (agentA) changes validateToken (critical), reviewed at STANDARD · D2 (agentB) changes sessionStore (critical), reviewed at SENIOR'));

  hr('REASON — POST /api/answer { reason: true } → EYE over the COMPLETE graph (root + rules sub-graph)');
  let res;
  for (let i = 0; i < 15; i++) {
    res = (await post('/api/answer', { contextGraphId: CG, question: 'which changes violate the review policy?', reason: true })).b;
    if (res?.reasoning?.derived?.length) break;
    process.stdout.write(c.d('.'));
    await sleep(4000);
  }
  console.log();
  const der = res?.reasoning?.derived ?? [];
  if (!der.length) { console.log(c.r('  no derivations — ' + (res?.reasoning?.note ?? 'reasoning did not run'))); return; }

  const violations = der.filter((d) => d.conclusion.predicate.endsWith('violatesReviewPolicy'));
  const impact = der.filter((d) => d.conclusion.predicate.endsWith('affectedBy'));
  const flagged = der.filter((d) => d.conclusion.predicate.endsWith('flagged'));

  hr('⚖  DERIVED — review-policy violations (nobody published these; EYE inferred them)');
  for (const v of violations) {
    console.log(`  ${c.r('✗ ' + local(v.conclusion.subject))} ${c.b('violatesReviewPolicy')}   ${c.d('(security-critical change, no senior review)')}`);
    for (const cit of v.support) console.log(`       ${cit.checks?.verified ? c.g('✓') : c.r('✗')} ${local(cit.triple.subject)} ${c.c(local(cit.triple.predicate))} ${lit(cit.triple.object)}`);
  }
  const compliant = ['D1', 'D2'].map((x) => NS + x).filter((s) => !violations.some((v) => v.conclusion.subject === s));
  console.log(`  ${c.g('✓ ' + compliant.map(local).join(', '))} ${c.d('— compliant (senior review satisfies the policy)')}`);

  hr('🔗 DERIVED — transitive impact (a change ripples up the call graph)');
  const by = {};
  for (const d of impact) (by[local(d.conclusion.object)] ??= []).push(local(d.conclusion.subject));
  for (const [chg, fns] of Object.entries(by)) console.log(`  ${c.b(chg)} affects → ${c.y(fns.join(', '))}`);

  hr('🛠  RULE MANAGEMENT — rules are first-class, verifiable, status-gated KAs');
  for (const rc of res.reasoning.rules ?? []) console.log(`  ${c.g('✓ applied')} ${c.d('rule KA ' + String(rc.kaId).slice(0, 10) + '… (from the rules sub-graph, verifiable)')}`);
  console.log(`  ${c.r('∅ skipped')} ${c.d('flag-all — drag:ruleStatus "disabled" → never fires (' + (flagged.length ? c.r('LEAKED ' + flagged.length) : 'no `flagged` derived ✓') + ')')}`);

  console.log(c.b(`\n${c.c('━'.repeat(76))}`));
  console.log(`  retrieve → verify → ${c.b('reason')} → ${c.b('prove')}: rules managed in the graph, a governance conclusion`);
  console.log(`  DERIVED with negation + transitivity — every fact AND rule cryptographically auditable.`);
  console.log(c.b(`${c.c('━'.repeat(76))}\n`));
})();

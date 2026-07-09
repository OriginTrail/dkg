#!/usr/bin/env node
/**
 * dRAG REASONING demo — retrieve → verify → REASON → prove (OT-RFC-55 + EYE).
 *
 * A multi-agent CODE context graph: coding agents publish per-agent, on-chain
 * decision / code / review traces. The EYE reasoner then DERIVES a governance
 * conclusion nobody published — "which in-progress change violates the team's
 * review policy" — using NEGATION and TRANSITIVITY (things vectors/SPARQL can't),
 * and every leaf of the proof is a chain-verified, per-agent-authored citation.
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
const RULE_PRED = 'https://ontology.origintrail.io/drag/reasoning#ruleN3';
const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m` };
const hr = (t) => console.log(c.b(`\n${c.c('━'.repeat(76))}\n${t}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (u) => String(u).split(/[/#]/).pop();
const lit = (o) => (typeof o === 'string' && o.startsWith('"') ? o.slice(1).replace(/"$/, '') : local(o));

async function post(p, body, headers = {}) {
  const r = await fetch(N1 + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });
  let b; try { b = await r.json(); } catch { b = await r.text(); }
  return { status: r.status, b };
}
async function publish(name, triples) {
  const quads = triples.map(([s, p, o]) => ({ subject: s, predicate: p, object: o, graph: '' }));
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
      const { status } = await post(path, { contextGraphId: CG, name, ...extra });
      if (![200, 201].includes(status)) { ok = false; break; }
    }
    if (ok) return true;
    await sleep(5000);
  }
  return false;
}

// One-line N3 so the rule body is a single literal (only inner quotes escaped).
const RULES_N3 =
  `@prefix code: <${NS}>. @prefix log: <http://www.w3.org/2000/10/swap/log#>. @prefix list: <http://www.w3.org/2000/10/swap/list#>. ` +
  `{ ?c code:changes ?f } => { ?f code:affectedBy ?c } . ` +
  `{ ?caller code:calls ?f . ?f code:affectedBy ?c } => { ?caller code:affectedBy ?c } . ` +
  `{ ?c a code:Change . ?c code:changes ?f . ?f code:inModule ?m . ?m code:securityCritical "true" . ` +
  `( ?a { ?c code:reviewedBy ?r . ?r code:reviewer ?a . ?a code:clearance "senior" } ?L ) log:collectAllIn _:s . ?L list:length 0 . } ` +
  `=> { ?c code:violatesReviewPolicy "true" } .`;
const escLit = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

(async () => {
  console.log(c.b('\n  dRAG reasoning — derive a verifiable governance conclusion from a multi-agent code graph\n'));
  // wait for node identity
  for (let i = 0; i < 30; i++) { try { if ((await (await fetch(N1 + '/api/identity', { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).hasIdentity) break; } catch {} await sleep(2000); }

  hr('SETUP — agents publish on-chain code/decision/review traces (+ a rule KA)');
  await post('/api/context-graph/create', { id: CG, name: 'multi-agent code graph', accessPolicy: 0, publishPolicy: 0, register: true });
  await sleep(2000);
  // subjects/predicates are bare IRIs; IRI OBJECTS are wrapped in <> (KA write
  // convention — they round-trip to bare in the stored triples); literals quoted.
  // The authoring agent is recorded as a queryable FACT (code:author), as in the
  // article's "/decisions graph with the author's identity".
  const ref = (x) => `${NS}${x}`;
  const T = (s, p, o) => [NS + s, p.startsWith('http') ? p : NS + p, o];
  const A = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  // One KA per concern, with DISTINCT rootEntities (a KA's subjects are its root
  // entities, and a CG rejects a re-used rootEntity). Each decision carries its
  // own review so D1/D2 are each a rootEntity exactly once.
  const ok = {};
  // code structure (call graph + criticality) — agentA
  ok.code = await publish('code-structure', [
    T('apiGateway', 'calls', ref('handleAuth')), T('handleAuth', 'calls', ref('validateToken')),
    T('validateToken', 'inModule', ref('authModule')), T('sessionStore', 'inModule', ref('authModule')),
    T('authModule', 'securityCritical', '"true"'),
  ]);
  // decision D1 (agentA) + its STANDARD-clearance review (agentC)
  ok.d1 = await publish('decision-d1', [
    T('D1', A, ref('Change')), T('D1', 'author', ref('agentA')), T('D1', 'changes', ref('validateToken')), T('D1', 'status', '"active"'), T('D1', 'rationale', '"session tokens to JWT"'),
    T('D1', 'reviewedBy', ref('R1')), T('R1', 'reviewer', ref('agentC')), T('agentC', 'clearance', '"standard"'),
  ]);
  // decision D2 (agentB, same critical module) + its SENIOR-clearance review (agentV)
  ok.d2 = await publish('decision-d2', [
    T('D2', A, ref('Change')), T('D2', 'author', ref('agentB')), T('D2', 'changes', ref('sessionStore')), T('D2', 'status', '"active"'),
    T('D2', 'reviewedBy', ref('R2')), T('R2', 'reviewer', ref('agentV')), T('agentV', 'clearance', '"senior"'),
  ]);
  // the review policy, as a VERIFIABLE rule KA
  const ruleOk = await publish('policy-rules', [[NS + 'policyRules', RULE_PRED, escLit(RULES_N3)]]);
  const factsOk = [ok.code, ok.d1, ok.d2].filter(Boolean).length;
  console.log(`  ${factsOk === 3 ? c.g('✓') : c.r('✗')} published ${factsOk}/3 fact KAs + rule-KA ${ruleOk ? c.g('ok') : c.r('FAILED')} to ${c.c(CG)}`);
  console.log(c.d('  D1 (agentA) changes validateToken — security-critical, reviewed only at STANDARD clearance (agentC)'));
  console.log(c.d('  D2 (agentB) changes sessionStore — same critical module, reviewed at SENIOR clearance (agentV)'));

  hr('REASON — POST /api/answer { reason: true } → EYE derives, over VERIFIED facts only');
  // The rule-KA (when published) drives reasoning as a VERIFIABLE rule; if it
  // blipped, fall back to request-supplied rules so the demo always reasons.
  const reqRules = ruleOk ? undefined : RULES_N3;
  let R;
  for (let i = 0; i < 15; i++) {
    R = (await post('/api/answer', { contextGraphId: CG, question: 'which changes violate the review policy?', reason: true, ...(reqRules ? { rules: reqRules } : {}) })).b;
    if (R?.reasoning?.derived?.length) break;
    process.stdout.write(c.d('.'));
    await sleep(4000);
  }
  console.log();
  const der = R?.reasoning?.derived ?? [];
  if (!der.length) { console.log(c.r('  no derivations — ' + (R?.reasoning?.note ?? 'reasoning did not run')), JSON.stringify(R?.reasoning ?? R).slice(0, 300)); return; }

  const violations = der.filter((d) => d.conclusion.predicate.endsWith('violatesReviewPolicy'));
  const impact = der.filter((d) => d.conclusion.predicate.endsWith('affectedBy'));

  hr('⚖  DERIVED — review-policy violations (nobody published these; EYE inferred them)');
  for (const v of violations) {
    console.log(`  ${c.r('✗ ' + local(v.conclusion.subject))} ${c.b('violatesReviewPolicy')}   ${c.d('(security-critical change with no senior review)')}`);
    console.log(c.d('     proof — each leaf is a chain-verified citation:'));
    for (const cit of v.support) {
      const t = cit.triple, ok = cit.checks?.verified;
      console.log(`       ${ok ? c.g('✓') : c.r('✗')} ${local(t.subject)} ${c.c(local(t.predicate))} ${lit(t.object)}   ${c.d('[KA ' + String(cit.kaId).slice(0, 8) + '… auth ' + String(cit.onChain?.author ?? '?').slice(0, 8) + '…]')}`);
    }
  }
  const compliant = ['D1', 'D2'].map((x) => NS + x).filter((s) => !violations.some((v) => v.conclusion.subject === s));
  console.log(`  ${c.g('✓ ' + compliant.map(local).join(', '))} ${c.d('— compliant (senior review satisfies the policy; same critical module, different outcome)')}`);

  hr('🔗 DERIVED — transitive impact (a change ripples up the call graph)');
  const byChange = {};
  for (const d of impact) (byChange[local(d.conclusion.object)] ??= []).push(local(d.conclusion.subject));
  for (const [chg, fns] of Object.entries(byChange)) console.log(`  ${c.b(chg)} affects → ${c.y(fns.join(', '))}`);

  hr('RULES applied (themselves verifiable KAs)');
  for (const rc of R.reasoning.rules ?? []) console.log(`  ${c.g('✓')} rule KA ${c.d(String(rc.kaId).slice(0, 10) + '…')} ${c.d('author ' + String(rc.onChain?.author ?? '?').slice(0, 8) + '…')}`);

  console.log(c.b(`\n${c.c('━'.repeat(76))}`));
  console.log(`  retrieve → verify → ${c.b('reason')} → ${c.b('prove')}: a governance conclusion DERIVED with negation +`);
  console.log(`  transitivity, every input fact + the rule cryptographically auditable. An LLM can't show its work; EYE can.`);
  console.log(c.b(`${c.c('━'.repeat(76))}\n`));
})();

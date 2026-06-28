import { describe, it, beforeAll, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// dRAG reasoning release-gate suite (OT-RFC-55 + EYE). Requires a live devnet
// (`./scripts/devnet.sh start 4`) and the optional `eyereasoner` dependency.

const TOKEN = readFileSync(resolve(import.meta.dirname, '../../.devnet/node1/auth.token'), 'utf8')
  .split('\n')
  .filter((l) => l && !l.startsWith('#'))[0]
  .trim();
const N1 = 'http://127.0.0.1:9201';
const CG = `code-reason-${Date.now().toString(36)}`;
const NS = 'http://ex/code#';
const RULE_PRED = 'https://ontology.origintrail.io/drag/reasoning#ruleN3';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Json = Record<string, any>;
async function post(path: string, body: Json): Promise<{ status: number; b: Json }> {
  const r = await fetch(N1 + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  let b: Json;
  try {
    b = await r.json();
  } catch {
    b = {};
  }
  return { status: r.status, b };
}
async function publish(name: string, triples: Array<[string, string, string]>): Promise<boolean> {
  const quads = triples.map(([s, p, o]) => ({ subject: s, predicate: p, object: o, graph: '' }));
  for (let t = 0; t < 6; t++) {
    let ok = true;
    const steps: Array<[string, Json]> = [
      ['/api/knowledge-assets', {}],
      [`/api/knowledge-assets/${name}/wm/write`, { quads }],
      [`/api/knowledge-assets/${name}/wm/finalize`, {}],
      [`/api/knowledge-assets/${name}/swm/share`, {}],
      ['/api/shared-memory/publish', { assertionName: name }],
    ];
    for (const [path, extra] of steps) {
      if (![200, 201].includes((await post(path, { contextGraphId: CG, name, ...extra })).status)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
    await sleep(5000);
  }
  return false;
}

const A = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const ref = (x: string) => `<${NS}${x}>`;
const T = (s: string, p: string, o: string): [string, string, string] => [NS + s, p.startsWith('http') ? p : NS + p, o];
const RULES_N3 =
  `@prefix code: <${NS}>. @prefix log: <http://www.w3.org/2000/10/swap/log#>. @prefix list: <http://www.w3.org/2000/10/swap/list#>. ` +
  `{ ?c code:changes ?f } => { ?f code:affectedBy ?c } . ` +
  `{ ?caller code:calls ?f . ?f code:affectedBy ?c } => { ?caller code:affectedBy ?c } . ` +
  `{ ?c a code:Change . ?c code:changes ?f . ?f code:inModule ?m . ?m code:securityCritical "true" . ` +
  `( ?a { ?c code:reviewedBy ?r . ?r code:reviewer ?a . ?a code:clearance "senior" } ?L ) log:collectAllIn _:s . ?L list:length 0 . } ` +
  `=> { ?c code:violatesReviewPolicy "true" } .`;
const escLit = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

let reasoning: Json | undefined;
let reasoningAvailable = false;

beforeAll(async () => {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await (await fetch(N1 + '/api/identity', { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).hasIdentity) break;
    } catch {
      /* retry */
    }
    await sleep(2000);
  }
  await post('/api/context-graph/create', { id: CG, name: 'code reason', accessPolicy: 0, publishPolicy: 0, register: true });
  await sleep(2000);
  expect(await publish('code-structure', [
    T('apiGateway', 'calls', ref('handleAuth')), T('handleAuth', 'calls', ref('validateToken')),
    T('validateToken', 'inModule', ref('authModule')), T('sessionStore', 'inModule', ref('authModule')),
    T('authModule', 'securityCritical', '"true"'),
  ]), 'publish code-structure').toBe(true);
  expect(await publish('decision-d1', [
    T('D1', A, ref('Change')), T('D1', 'changes', ref('validateToken')), T('D1', 'status', '"active"'),
    T('D1', 'reviewedBy', ref('R1')), T('R1', 'reviewer', ref('agentC')), T('agentC', 'clearance', '"standard"'),
  ]), 'publish decision-d1').toBe(true);
  expect(await publish('decision-d2', [
    T('D2', A, ref('Change')), T('D2', 'changes', ref('sessionStore')), T('D2', 'status', '"active"'),
    T('D2', 'reviewedBy', ref('R2')), T('R2', 'reviewer', ref('agentV')), T('agentV', 'clearance', '"senior"'),
  ]), 'publish decision-d2').toBe(true);
  const ruleOk = await publish('policy-rules', [[NS + 'policyRules', RULE_PRED, escLit(RULES_N3)]]);

  // Poll until reasoning derives (anchoring + the rule-KA must settle); fall back
  // to request-supplied rules if the rule-KA blipped.
  const reqRules = ruleOk ? undefined : RULES_N3;
  for (let i = 0; i < 15; i++) {
    const r = await post('/api/answer', { contextGraphId: CG, question: 'which changes violate the review policy?', reason: true, ...(reqRules ? { rules: reqRules } : {}) });
    reasoning = r.b.reasoning;
    if (reasoning?.derived?.length) break;
    await sleep(4000);
  }
  reasoningAvailable = !reasoning?.note?.includes('not installed');
}, 300_000);

const subjectsFor = (pred: string): string[] =>
  (reasoning?.derived ?? []).filter((d: Json) => String(d.conclusion.predicate).endsWith(pred)).map((d: Json) => String(d.conclusion.subject));

describe('dRAG reasoning — EYE derives proof-carrying governance conclusions', () => {
  it('derives the review-policy violation via NEGATION: D1 violates, D2 (senior review) does not', (ctx) => {
    if (!reasoningAvailable) ctx.skip(); // optional eyereasoner dep absent → SKIPPED
    const violations = subjectsFor('violatesReviewPolicy');
    expect(violations).toContain(NS + 'D1');
    expect(violations).not.toContain(NS + 'D2');
  });

  it('every derived conclusion is proof-carrying: the support is chain-verified citations', (ctx) => {
    if (!reasoningAvailable) ctx.skip();
    const d1 = (reasoning!.derived as Json[]).find((d) => String(d.conclusion.predicate).endsWith('violatesReviewPolicy') && d.conclusion.subject === NS + 'D1')!;
    expect(d1.support.length).toBeGreaterThan(0);
    expect(d1.support.every((c: Json) => c.checks?.verified)).toBe(true);
    // the proof contains the load-bearing facts (the change + the critical module + the only-standard review)
    const proofPreds = d1.support.map((c: Json) => String(c.triple.predicate).split(/[/#]/).pop());
    expect(proofPreds).toEqual(expect.arrayContaining(['changes', 'securityCritical', 'clearance']));
  });

  it('derives transitive impact: a change to validateToken ripples up the call graph', (ctx) => {
    if (!reasoningAvailable) ctx.skip();
    const affected = subjectsFor('affectedBy');
    expect(affected).toEqual(expect.arrayContaining([NS + 'validateToken', NS + 'handleAuth', NS + 'apiGateway']));
  });
});

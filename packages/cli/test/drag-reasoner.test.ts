import { describe, it, expect } from 'vitest';
import { DragReasoner, type VerifiedFact } from '../src/daemon/drag-reasoner.js';
import type { VerifiableCitation } from '@origintrail-official/dkg-core';

const C = 'http://ex/code#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// A VerifiedFact whose citation is a marker we can assert on (the reasoner treats
// the citation as opaque and returns it in a conclusion's `support`).
function vf(s: string, p: string, o: string): VerifiedFact {
  const triple = { subject: s.startsWith('http') ? s : C + s, predicate: p.startsWith('http') ? p : C + p, object: o };
  return {
    triple,
    citation: {
      kaId: `${s}.${p}`,
      triple,
      checks: { merkle: true, onChain: true, authorSig: true, verified: true },
    } as unknown as VerifiableCitation,
  };
}
const iri = (x: string) => C + x;

const FACTS: VerifiedFact[] = [
  // call graph + criticality (agentA)
  vf('apiGateway', 'calls', iri('handleAuth')),
  vf('handleAuth', 'calls', iri('validateToken')),
  vf('validateToken', 'inModule', iri('authModule')),
  vf('authModule', 'securityCritical', '"true"'),
  // D1 — change to a security-critical fn, only a STANDARD review (agentA + agentC)
  vf('D1', RDF_TYPE, iri('Change')),
  vf('D1', 'changes', iri('validateToken')),
  vf('D1', 'reviewedBy', iri('R1')),
  vf('R1', 'reviewer', iri('agentC')),
  vf('agentC', 'clearance', '"standard"'),
  // D2 — same critical module, but a SENIOR review (agentB + agentV) → compliant
  vf('D2', RDF_TYPE, iri('Change')),
  vf('D2', 'changes', iri('sessionStore')),
  vf('sessionStore', 'inModule', iri('authModule')),
  vf('D2', 'reviewedBy', iri('R2')),
  vf('R2', 'reviewer', iri('agentV')),
  vf('agentV', 'clearance', '"senior"'),
];

const RULES = `@prefix code: <http://ex/code#>.
@prefix log: <http://www.w3.org/2000/10/swap/log#>.
@prefix list: <http://www.w3.org/2000/10/swap/list#>.
# transitive impact up the call graph
{ ?c code:changes ?f } => { ?f code:affectedBy ?c } .
{ ?caller code:calls ?f . ?f code:affectedBy ?c } => { ?caller code:affectedBy ?c } .
# review policy: a change to a security-critical module with NO senior-clearance review violates policy
{ ?c a code:Change . ?c code:changes ?f . ?f code:inModule ?m . ?m code:securityCritical "true" .
  ( ?a { ?c code:reviewedBy ?r . ?r code:reviewer ?a . ?a code:clearance "senior" } ?L ) log:collectAllIn _:s .
  ?L list:length 0 .
} => { ?c code:violatesReviewPolicy "true" } .`;

describe('DragReasoner — EYE over verified facts', () => {
  it('derives the policy violation (negation) + transitive impact, with verified support', async (ctx) => {
    const res = await new DragReasoner().reason(FACTS, RULES);
    if (res.note?.includes('not installed')) ctx.skip(); // optional eyereasoner dep absent → SKIPPED, not failed
    expect(res.note, res.note).toBeUndefined();

    const concl = (p: string) => res.derived.filter((d) => d.conclusion.predicate === iri(p));

    // NEGATION: D1 violates (only standard review), D2 does NOT (senior review).
    const violations = concl('violatesReviewPolicy').map((d) => d.conclusion.subject);
    expect(violations).toContain(iri('D1'));
    expect(violations).not.toContain(iri('D2'));

    // TRANSITIVE: a change to validateToken reaches its callers up the graph.
    const affected = concl('affectedBy').map((d) => d.conclusion.subject);
    expect(affected).toEqual(expect.arrayContaining([iri('validateToken'), iri('handleAuth'), iri('apiGateway')]));

    // EVIDENCE-CARRYING: D1's violation cites relevant verified facts, and the
    // support is drawn from the real input citations (not fabricated).
    const d1 = concl('violatesReviewPolicy').find((d) => d.conclusion.subject === iri('D1'))!;
    const supportKas = d1.support.map((c) => (c as unknown as { kaId: string }).kaId);
    expect(supportKas).toEqual(
      expect.arrayContaining(['D1.changes', 'validateToken.inModule', 'authModule.securityCritical', 'agentC.clearance']),
    );
    expect(d1.support.every((c) => c.checks.verified)).toBe(true);
    expect(d1.rule).toContain('violatesReviewPolicy'); // attributed to the policy rule
  }, 30_000);

  it('returns an empty result (no throw) for no facts', async () => {
    const res = await new DragReasoner().reason([], RULES);
    expect(res.derived).toEqual([]);
  });
});

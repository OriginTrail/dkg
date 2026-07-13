// daemon/drag-reasoner.ts
//
// dRAG REASONING tier (OT-RFC-55): retrieve → verify → REASON → derive.
//
// Runs the EYE N3 reasoner (eyereasoner, in-process WebAssembly) over the
// VERIFIED facts only, applying N3 rules to DERIVE new conclusions — negation
// (log:collectAllIn / list:length), transitive inference, conditional/policy
// logic — things vectors and SPARQL cannot do. Each derived conclusion carries
// a bounded rule-scoped neighborhood of chain-verified supporting facts. This
// evidence is auditable but is not claimed to be an exact/minimal EYE proof.
//
// Two invariants:
//   1. EYE only ever sees VERIFIED facts (the trust gate).
//   2. Derived conclusions are NEVER citations — they are labelled `derived`
//      and carry bounded, verified supporting evidence. A reasoner can
//      mis-derive (a bad rule), but it can never forge a published fact.
//
// eyereasoner is an OPTIONAL dependency, loaded by dynamic import so the base
// build/binary is unaffected; absent → reasoning degrades to a clear note.

import { tripleContentV10, type CitationTriple, type VerifiableCitation } from '@origintrail-official/dkg-core';

/**
 * Predicate that carries an N3 rule body as a verified literal — so RULES are
 * themselves chain-published, verifiable KAs ("verified facts + verified rules
 * → conclusions with verified evidence"). A CG's rules are auto-discovered from facts
 * with this predicate.
 */
export const DRAG_RULE_PREDICATE = 'https://ontology.origintrail.io/drag/reasoning#ruleN3';

export interface VerifiedFact {
  triple: CitationTriple;
  citation: VerifiableCitation;
}

export interface DerivedConclusion {
  conclusion: CitationTriple;
  /** The rule(s) whose head produced this conclusion (best-effort attribution). */
  rule?: string;
  /** Verified, rule-scoped supporting evidence; not an exact/minimal proof. */
  support: VerifiableCitation[];
}

export interface ReasoningResult {
  engine: 'eye-js';
  derived: DerivedConclusion[];
  /** Citations for the rule-KAs applied (when rules came from the graph). */
  rules?: VerifiableCitation[];
  /** Set when reasoning could not run (e.g. optional dependency missing, no rules). */
  note?: string;
}

type RdfTerm = { termType: string; value: string; datatype?: { value: string }; language?: string };
type RdfQuad = { subject: RdfTerm; predicate: RdfTerm; object: RdfTerm };

const decoder = new TextDecoder();
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

/** A dRAG triple term is an IRI when it is neither a literal ("…) nor a blank node (_:…). */
const isIri = (term: string): boolean => term.length > 0 && !term.startsWith('"') && !term.startsWith('_:');

/** Dynamic import keeps eyereasoner optional + out of the build graph (mirrors LocalEmbeddingProvider). */
async function loadN3Reasoner(): Promise<
  (data: string, query?: unknown, opts?: unknown) => Promise<unknown>
> {
  const specifier = 'eyereasoner';
  const mod = (await import(specifier)) as {
    n3reasoner: (data: string, query?: unknown, opts?: unknown) => Promise<unknown>;
  };
  return mod.n3reasoner;
}

/** The exact canonical N-Triple line the hashing path uses — no drift, so it round-trips for citation re-match. */
function ntriple(t: CitationTriple): string {
  return decoder.decode(tripleContentV10(t.subject, t.predicate, t.object));
}

/** rdf/js term → the bare-IRI / N-Triples-literal form the rest of dRAG uses for objects. */
function termToObject(term: RdfTerm): string {
  if (term.termType === 'Literal') {
    const v = term.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (term.language) return `"${v}"@${term.language}`;
    if (term.datatype && term.datatype.value && term.datatype.value !== XSD_STRING) return `"${v}"^^<${term.datatype.value}>`;
    return `"${v}"`;
  }
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  return term.value; // NamedNode → bare IRI (dRAG triple structs hold IRIs bare)
}

export class DragReasoner {
  /**
   * Reason over `facts` (already verified) with `rulesN3`, returning derived,
   * conclusions with verified evidence. `neighborhoodDepth` bounds how far the support
   * traversal follows the rule chain from a conclusion's subject (default 4).
   */
  async reason(
    facts: VerifiedFact[],
    rulesN3: string,
    opts?: { neighborhoodDepth?: number },
  ): Promise<ReasoningResult> {
    if (facts.length === 0) return { engine: 'eye-js', derived: [] };

    let n3reasoner: (data: string, query?: unknown, opts?: unknown) => Promise<unknown>;
    try {
      n3reasoner = await loadN3Reasoner();
    } catch {
      return {
        engine: 'eye-js',
        derived: [],
        note: 'reasoning unavailable: optional dependency "eyereasoner" is not installed (npm i eyereasoner)',
      };
    }

    // ── 1. serialize the verified facts to N3, and index them BY SUBJECT (forward) ──
    const factLines: string[] = [];
    const citationByCanonical = new Map<string, VerifiableCitation>();
    const factsBySubject = new Map<string, VerifiedFact[]>();
    for (const f of facts) {
      const line = ntriple(f.triple);
      factLines.push(line);
      citationByCanonical.set(line, f.citation);
      const b = factsBySubject.get(f.triple.subject);
      if (b) b.push(f);
      else factsBySubject.set(f.triple.subject, [f]);
    }
    const data = factLines.join('\n') + '\n' + rulesN3;

    // ── 2. derive — `output:'derivations'` returns ONLY the newly-entailed facts ──
    let quads: RdfQuad[];
    try {
      const out = (await n3reasoner(data, undefined, { output: 'derivations', outputType: 'quads' })) as RdfQuad[];
      quads = Array.isArray(out) ? out : [];
    } catch (e) {
      return { engine: 'eye-js', derived: [], note: `reasoning error: ${e instanceof Error ? e.message : String(e)}` };
    }

    // ── 3. each derived quad → a conclusion with bounded verified evidence ──
    const ruleClauses = splitRules(rulesN3);
    const depth = Math.max(1, Math.min(opts?.neighborhoodDepth ?? 4, 8));
    const MAX_DERIVED = 2000;
    const derived: DerivedConclusion[] = [];
    for (const q of quads.slice(0, MAX_DERIVED)) {
      const conclusion: CitationTriple = {
        subject: q.subject.value,
        predicate: q.predicate.value,
        object: termToObject(q.object),
      };
      // Scope the proof to the firing rule(s): forward-traverse from the
      // conclusion's subject (and IRI object, to catch the change that justifies
      // an `affectedBy`), and keep only facts whose predicate appears in the
      // rule body — so a shared entity (e.g. a module two changes touch) can't
      // bridge the proof into an unrelated conclusion.
      const { rule, predicates } = rulesForPredicate(conclusion.predicate, ruleClauses);
      const seeds = isIri(conclusion.object) ? [conclusion.subject, conclusion.object] : [conclusion.subject];
      const support = this.collectSupport(seeds, factsBySubject, citationByCanonical, depth, predicates);
      derived.push({ conclusion, rule, support });
    }
    return { engine: 'eye-js', derived };
  }

  /**
   * Evidence attribution: verified facts related to the conclusion and rule. A
   * bounded FORWARD traversal from the seed entities (the conclusion's subject,
   * plus its IRI object so an `f affectedBy D1` reaches the justifying
   * `D1 changes f`), keeping ONLY facts whose predicate appears in the rule body
   * (`predicateFilter`). Forward-only + the predicate filter stop a shared entity
   * (e.g. a module two changes touch) from bridging the proof into an unrelated
   * conclusion.
   *
   * BEST-EFFORT, not a minimal proof: every returned citation is a REAL verified
   * fact (matched from the INPUT set by canonical N-Triple, never EYE's
   * re-serialized output — so a leaf is never fabricated), but the SET is a bounded
   * heuristic — for some rule shapes it can include a sibling-branch fact or omit
   * a body fact anchored on a shared object. The exact rule-instance proof (EYE's
   * justification output) is a planned enhancement; the trust guarantee (real
   * verified leaves) holds regardless.
   */
  private collectSupport(
    seeds: string[],
    factsBySubject: Map<string, VerifiedFact[]>,
    citationByCanonical: Map<string, VerifiableCitation>,
    depth: number,
    predicateFilter: Set<string>,
  ): VerifiableCitation[] {
    const seenTriple = new Set<string>();
    const support: VerifiableCitation[] = [];
    let frontier = [...seeds];
    const visited = new Set<string>();
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const e of frontier) {
        if (visited.has(e)) continue;
        visited.add(e);
        for (const f of factsBySubject.get(e) ?? []) {
          const include = predicateFilter.size === 0 || predicateFilter.has(localName(f.triple.predicate));
          const key = ntriple(f.triple);
          if (include && !seenTriple.has(key)) {
            seenTriple.add(key);
            const cite = citationByCanonical.get(key);
            if (cite) support.push(cite);
          }
          // expand forward to the fact's IRI object (the rule chain)
          if (include && isIri(f.triple.object)) next.push(f.triple.object);
        }
      }
      frontier = next;
    }
    return support;
  }
}

function localName(iri: string): string {
  return iri.split(/[/#]/).pop() ?? iri;
}

/** Split an N3 rules block into individual `{...} => {...} .` clauses. */
function splitRules(rulesN3: string): string[] {
  const clauses: string[] = [];
  const re = /\{[\s\S]*?\}\s*=>\s*\{[\s\S]*?\}\s*\./g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rulesN3)) !== null) clauses.push(m[0].trim());
  return clauses;
}

/**
 * For a conclusion's predicate, find the rule(s) whose HEAD derives it, and the
 * set of predicate LOCAL NAMES used across those rules' bodies (so the proof can
 * be scoped to rule-relevant facts). `rule` is the first matching clause (display).
 */
function rulesForPredicate(predicate: string, clauses: string[]): { rule?: string; predicates: Set<string> } {
  const local = localName(predicate);
  const predicates = new Set<string>();
  let rule: string | undefined;
  for (const c of clauses) {
    const arrow = c.indexOf('=>');
    const body = arrow >= 0 ? c.slice(0, arrow) : c;
    const head = arrow >= 0 ? c.slice(arrow + 2) : '';
    if (!head.includes(local)) continue;
    if (!rule) rule = c;
    // collect predicate local-names from the body: prefixed names + `a` (rdf:type)
    for (const m of body.matchAll(/[A-Za-z][\w-]*:([A-Za-z][\w-]*)/g)) predicates.add(m[1]);
    if (/\s a \s|\sa\s/.test(body) || body.includes(' a ')) predicates.add('type');
  }
  if (!rule && clauses.length === 1) rule = clauses[0];
  return { rule, predicates };
}

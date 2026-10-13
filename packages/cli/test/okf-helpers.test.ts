import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  importBundle,
  loadBundleDir,
  exportBundle,
  quadsToNQuads,
  RDF_TYPE,
  SCHEMA_NAME,
  OKF_SOURCE,
  DKG_HAS_SECTION,
  SECTION_GENID_INFIX,
  GENID_TAGS,
  type Quad,
} from '@origintrail-official/dkg-okf';
import {
  bindingsOf,
  cell,
  distinctTripleCountsByPredicate,
  exportInputFromBindings,
  parseRelateRules,
  summarizeOkfImport,
} from '../src/commands/okf-helpers.js';

const acme = loadBundleDir(fileURLToPath(new URL('../../okf/test/fixtures/acme_retail', import.meta.url)));

/** The semantic graph: everything except presentational section structure (as in the okf round-trip tests). */
function semantic(quads: Quad[]): string {
  const sectionNode = SECTION_GENID_INFIX + GENID_TAGS.section;
  return quadsToNQuads(quads.filter((q) => !q.subject.includes(sectionNode) && q.predicate !== DKG_HAS_SECTION));
}

/** Deterministic Fisher–Yates with a small LCG. */
function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let x = seed;
  for (let i = out.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('bindingsOf / cell (daemon result readers)', () => {
  it('reads bindings structurally and normalises bare-string and SPARQL-JSON cells', () => {
    expect(bindingsOf({ bindings: [{ s: 'a' }] })).toEqual([{ s: 'a' }]);
    expect(bindingsOf({ type: 'bindings' })).toEqual([]);
    expect(bindingsOf(null)).toEqual([]);
    expect(cell('x')).toBe('x');
    expect(cell({ value: 'y', type: 'uri' })).toBe('y');
    expect(cell({ value: null })).toBe('');
    expect(cell(undefined)).toBe('');
    expect(cell(7)).toBe('7');
  });
});

describe('summarizeOkfImport (acme_retail v0.2 trust picture)', () => {
  const imported = importBundle(acme);

  it('counts the §5 families alongside the triple and link counts', () => {
    const s = summarizeOkfImport(imported, new Date('2026-10-13T00:00:00Z'));
    expect(s).toMatchObject({
      concepts: 9,
      reservedSkipped: 8,
      sources: 9,
      derivedFromConcepts: 8,
      trustTiers: { humanReviewed: 8, machineConfirmed: 0, unverified: 1 },
      draft: 0,
      deprecated: 1,
      stale: 0,
      attestedComputations: 2,
    });
    expect(s.triples).toBe(imported.quads.length);
  });

  it('evaluates staleness against the supplied instant', () => {
    expect(summarizeOkfImport(imported, new Date('2027-01-01T00:00:00Z')).stale).toBe(7);
  });
});

describe('parseRelateRules', () => {
  it('resolves bare terms against schema.org and keeps full IRIs', () => {
    expect(parseRelateRules(['BigQuery Dataset>BigQuery Table=hasPart'])).toEqual([
      { from: 'BigQuery Dataset', to: 'BigQuery Table', predicate: 'http://schema.org/hasPart' },
    ]);
    expect(parseRelateRules(['A>B=https://example.org/rel'])[0].predicate).toBe('https://example.org/rel');
  });
  it('rejects malformed rules', () => {
    expect(() => parseRelateRules(['no-separators'])).toThrow(/Invalid --relate rule/);
    expect(() => parseRelateRules(['A=B>C'])).toThrow(/Invalid --relate rule/);
    expect(() => parseRelateRules(['>B=p'])).toThrow(/Invalid --relate rule/);
  });
});

describe('exportInputFromBindings (graph → exporter input)', () => {
  const base = 'urn:okf:';

  it('keeps concept roots and attaches their skolemized nodes; skips non-concept subjects and empty cells', () => {
    const concept = `${base}metrics/revenue`;
    const source = `${concept}/.well-known/genid/okfsrc_metrics_revenue_0`;
    const section = `${concept}/.well-known/genid/okfsec_metrics_revenue_0`;
    const bindings = [
      { s: `<${concept}>`, p: `<${RDF_TYPE}>`, o: '<http://schema.org/Metric>' },
      { s: concept, p: SCHEMA_NAME, o: '"Revenue"' },
      { s: { value: concept, type: 'uri' }, p: { value: OKF_SOURCE }, o: { value: source } },
      { s: source, p: RDF_TYPE, o: 'http://dkg.io/ontology/okf/Source' },
      { s: section, p: SCHEMA_NAME, o: '"Definition"' },
      // a subject under the base without rdf:type is not a concept root
      { s: `${base}orphan`, p: SCHEMA_NAME, o: '"nope"' },
      // a subject outside the base is ignored even with a type
      { s: 'urn:other:x', p: RDF_TYPE, o: 'http://schema.org/Thing' },
      // empty cells are skipped
      { s: concept, p: '', o: '"x"' },
      { s: concept, p: SCHEMA_NAME },
    ];
    const input = exportInputFromBindings(bindings, base);
    expect(input.concepts.map((c) => c.conceptId)).toEqual(['metrics/revenue']);
    const [c] = input.concepts;
    expect(c.iri).toBe(concept);
    expect(c.quads).toEqual([
      { subject: concept, predicate: RDF_TYPE, object: '<http://schema.org/Metric>' },
      { subject: concept, predicate: SCHEMA_NAME, object: '"Revenue"' },
      { subject: concept, predicate: OKF_SOURCE, object: source },
      { subject: source, predicate: RDF_TYPE, object: 'http://dkg.io/ontology/okf/Source' },
      { subject: section, predicate: SCHEMA_NAME, object: '"Definition"' },
    ]);
  });

  const imported = importBundle(acme);
  const toBindings = (quads: Quad[]) => quads.map((q) => ({ s: `<${q.subject}>`, p: `<${q.predicate}>`, o: q.object }));

  it('rebuilds the complete semantic graph from shuffled bindings, every family payload included', () => {
    for (const seed of [3, 17, 2026]) {
      const input = exportInputFromBindings(shuffled(toBindings(imported.quads), seed), base);
      expect(input.concepts.map((c) => c.conceptId).sort()).toEqual(imported.concepts.map((c) => c.conceptId).sort());
      const reimported = importBundle(exportBundle(input));
      expect(semantic(reimported.quads)).toBe(semantic(imported.quads));
      for (const c of imported.concepts) {
        expect(reimported.concepts.find((x) => x.conceptId === c.conceptId)!.trust).toEqual(c.trust);
      }
    }
  });

  it('is not vacuous: dropping the parameter nodes changes the graph even though trust summaries still match', () => {
    const bindings = toBindings(imported.quads).filter((b) => !b.s.includes(GENID_TAGS.parameter));
    const reimported = importBundle(exportBundle(exportInputFromBindings(bindings, base)));
    expect(semantic(reimported.quads)).not.toBe(semantic(imported.quads));
    // the summary-only comparison this test replaced would have passed here
    for (const c of imported.concepts) {
      expect(reimported.concepts.find((x) => x.conceptId === c.conceptId)!.trust).toEqual(c.trust);
    }
  });
});

describe('distinctTripleCountsByPredicate (verify expectations)', () => {
  it('counts each distinct triple once per predicate', () => {
    const q = (s: string, p: string, o: string): Quad => ({ subject: s, predicate: p, object: o });
    const counts = distinctTripleCountsByPredicate([
      q('urn:okf:m', 'urn:p:lineage', 'urn:okf:p'),
      q('urn:okf:m', 'urn:p:lineage', 'urn:okf:p'),
      q('urn:okf:m', 'urn:p:lineage', 'https://x.example/doc'),
      q('urn:okf:n', 'urn:p:lineage', 'urn:okf:p'),
      q('urn:okf:m', 'urn:p:name', '"M"'),
    ]);
    expect(Object.fromEntries(counts)).toEqual({ 'urn:p:lineage': 3, 'urn:p:name': 1 });
  });
});

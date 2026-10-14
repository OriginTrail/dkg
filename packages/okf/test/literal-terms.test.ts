import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { formatCanonicalRdfLiteralTerm, parseWritableRdfTerm } from '@origintrail-official/dkg-rdf-utils';
import {
  exportBundle,
  exportInputFromQuads,
  importBundle,
  isSafeIri,
  literalTerm,
  loadBundleDir,
  parseDocument,
  typedLiteralTerm,
  OKF_RESOURCE,
  PROV_WAS_DERIVED_FROM,
  RDF_JSON,
  RDF_TYPE,
  SCHEMA_NAME,
  SCHEMA_NS,
  SCHEMA_URL,
  XSD_DATE_TIME,
} from '../src/index.js';
import type { BundleImport, Quad } from '../src/index.js';
import { isWritableIri } from '../src/utils.js';
import { IDX_V02, bundle, exportedFrontmatter, objs, semantic } from './helpers/okf-v02-fixtures.js';

// Literal terms use the DKG's canonical form (dkg-rdf-utils), the one the
// stores return, so an import's quads match what a store holds byte for byte
// and export reads both with one parser.
const AWKWARD = 'del\u007F esc\u001B tab\t nl\n quote" back\\ emoji 🙂 Grüße 日本';

describe('literal terms are written in the canonical RDF form', () => {
  it('escapes what N-Triples requires, as the shared formatter does', () => {
    expect(literalTerm(AWKWARD)).toBe(formatCanonicalRdfLiteralTerm({ kind: 'plain', value: AWKWARD }));
    expect(literalTerm(AWKWARD)).toBe('"del\\u007F esc\\u001B tab\\t nl\\n quote\\" back\\\\ emoji 🙂 Grüße 日本"');
    expect(typedLiteralTerm('2026-06-30T14:00:00Z', XSD_DATE_TIME)).toBe(`"2026-06-30T14:00:00Z"^^<${XSD_DATE_TIME}>`);
    expect(typedLiteralTerm('{"a":"x\\ny"}', RDF_JSON)).toBe(`"{\\"a\\":\\"x\\\\ny\\"}"^^<${RDF_JSON}>`);
  });

  it('keeps every such character through import, export and re-import', () => {
    const escaped = 'del\\x7F esc\\x1B tab\\t nl\\n quote\\" back\\\\ emoji 🙂 Grüße 日本';
    const files = bundle(
      [
        'type: Metric',
        `title: "${escaped}"`,
        `note: "${escaped}"`,
        `executor: { resource: https://x.example/run, memo: "${escaped}" }`,
        `owner: { label: "${escaped}", lone: "\\uD800" }`,
      ].join('\n'),
    );
    const first = importBundle(files);
    expect(semantic(importBundle(exportBundle(first)).quads)).toBe(semantic(first.quads));
    const fm = exportedFrontmatter(files);
    expect(fm.title).toBe(AWKWARD);
    expect(fm.note).toBe(AWKWARD);
    expect((fm.executor as Record<string, unknown>).memo).toBe(AWKWARD);
    expect(fm.owner).toEqual({ label: AWKWARD, lone: '\uD800' });
  });
});

describe('export reads literals with the shared RDF parser', () => {
  const iri = 'urn:okf:x';
  const typed: Quad = { subject: iri, predicate: RDF_TYPE, object: 'http://schema.org/Thing' };
  const exported = (quads: Quad[]) => {
    const file = exportBundle(exportInputFromQuads(quads)).find((f) => f.path === 'x.md')!;
    return parseDocument('x.md', file.content).frontmatter;
  };

  it('decodes every escape N-Triples allows, as a store may return them', () => {
    const fm = exported([
      typed,
      // a long UCHAR, a surrogate pair as two short escapes, an escaped single quote
      { subject: iri, predicate: SCHEMA_NAME, object: `"smile \\U0001F642 pair \\uD83D\\uDE42 it\\'s"` },
      { subject: iri, predicate: 'http://schema.org/note', object: '"hello"@en' },
    ]);
    expect(fm.title).toBe("smile 🙂 pair 🙂 it's");
    expect(fm.note).toBe('hello');
  });

  it('writes a literal that does not parse back as given instead of throwing', () => {
    // A raw line break is not canonical N-Triples.
    const raw = '"line one\nline two"';
    expect(exported([typed, { subject: iri, predicate: 'http://schema.org/note', object: raw }]).note).toBe(raw);
  });
});

describe('a value is written as an IRI only when the node accepts it', () => {
  // The write routes parse every term with `parseWritableRdfTerm`, so an IRI
  // must be an absolute RFC 3987 IRI. `https://example.org/%zz` (a malformed
  // percent escape) passes the looser shape check, and as an IRI the node
  // refuses the concept's whole write.
  const BAD = 'https://example.org/%zz';
  const ACCEPTS: Record<'subject' | 'predicate' | 'object', readonly string[]> = {
    subject: ['iri', 'blank-node'],
    predicate: ['iri'],
    object: ['literal', 'iri', 'blank-node'],
  };
  const refused = (quads: readonly Quad[]) =>
    quads.filter((q) => (['subject', 'predicate', 'object'] as const).some((field) => {
      const term = parseWritableRdfTerm(q[field]);
      return term === null || !ACCEPTS[field].includes(term.kind);
    }));
  const concept = (r: BundleImport, id = 'metrics/revenue') => r.concepts.find((c) => c.conceptId === id)!;
  const invalidIri = (r: BundleImport) => r.warnings.filter((w) => w.code === 'invalid-iri').map((w) => w.message);

  it('tells a writable IRI from one only shaped like it', () => {
    expect(isSafeIri(BAD)).toBe(true);
    expect(isWritableIri(BAD)).toBe(false);
    for (const iri of ['https://例え.jp/パス', 'urn:isbn:0451450523', 'tag:example.com,2026:x', 'https://example.org/%41ok']) expect(isWritableIri(iri), iri).toBe(true);
    // RFC 3987 allows a no-break space; it is whitespace to SPARQL interpolation (`isSafeIri`).
    expect(isWritableIri('https://example.org/a\u00A0b')).toBe(false);
  });

  it('keeps a malformed source URL as a literal, with a warning and no lineage, and imports the concept after it', () => {
    const r = importBundle([
      IDX_V02(),
      { path: 'a.md', content: `---\ntype: Metric\nsources: [{ resource: '${BAD}' }]\n---\n\nbody\n` },
      { path: 'z.md', content: '---\ntype: Metric\ntitle: Healthy\n---\n\nbody\n' },
    ]);
    expect(refused(r.quads)).toEqual([]);
    expect(r.concepts.map((c) => c.conceptId)).toEqual(['a', 'z']);
    const a = concept(r, 'a');
    expect(a.quads.filter((q) => q.predicate === OKF_RESOURCE).map((q) => q.object)).toEqual([`"${BAD}"`]);
    expect(a.quads.some((q) => q.predicate === PROV_WAS_DERIVED_FROM)).toBe(false);
    expect(r.warnings).toContainEqual({ conceptId: 'a', code: 'invalid-iri', message: `sources[0].resource "${BAD}" is not a valid IRI (RFC 3987); kept as a literal` });
  });

  it('writes such a value as a literal wherever it is, warning where a link was meant', () => {
    const files = bundle(
      [
        'type: Attested Computation',
        'runtime: python',
        `resource: '${BAD}'`,
        `computation: '${BAD}'`,
        `executor: { resource: '${BAD}', endpoint: '${BAD}' }`,
        `attester: { resource: '${BAD}' }`,
        `sources:\n  - { resource: '${BAD}', usage_count: '${BAD}' }`,
        `parameters:\n  - { name: p, type: string, required: '${BAD}' }`,
        `usage_window: '${BAD}'`,
        `homepage: '${BAD}'`,
        `mirrors: ['https://example.org/ok', '${BAD}']`,
      ].join('\n'),
      `body\n\n# Citations\n\n- ${BAD}\n`,
    );
    const r = importBundle(files);
    expect(refused(r.quads)).toEqual([]);
    expect(concept(r).quads.filter((q) => q.object === BAD)).toEqual([]);
    expect(invalidIri(r).map((m) => m.split(' "')[0])).toEqual(['`resource`', 'computation', 'executor.resource', 'attester.resource', 'sources[0].resource']);
    const second = importBundle(exportBundle(r));
    expect(semantic(second.quads)).toBe(semantic(r.quads));
    expect(invalidIri(second)).toEqual(invalidIri(r));
  });

  it('maps a malformed type to its schema: name, with a warning', () => {
    const r = importBundle(bundle(`type: '${BAD}'`));
    expect(objs(concept(r).quads, RDF_TYPE)).toEqual([SCHEMA_NS + 'HttpsExampleOrgZz']);
    expect(invalidIri(r)).toEqual([`\`type\` "${BAD}" is not a valid IRI (RFC 3987); mapped as ${SCHEMA_NS}HttpsExampleOrgZz`]);
  });

  it('still writes every IRI the node accepts as an IRI', () => {
    const valid = ['https://例え.jp/パス', 'urn:isbn:0451450523', 'tag:example.com,2026:x', 'https://example.org/%41ok'];
    const r = importBundle(bundle([
      'type: Metric',
      `resource: '${valid[0]}'`,
      'sources:',
      ...valid.map((v) => `  - { resource: '${v}' }`),
      "  - { resource: 'urn:okf:policies/revenue-recognition' }",
      `homepage: '${valid[1]}'`,
    ].join('\n')));
    const c = concept(r);
    expect(invalidIri(r)).toEqual([]);
    expect(objs(c.quads, SCHEMA_URL)).toEqual([valid[0]]);
    expect(objs(c.quads, PROV_WAS_DERIVED_FROM).sort()).toEqual([...valid, 'urn:okf:policies/revenue-recognition'].sort());
    expect(c.trust.derivedFromConcepts).toEqual(['policies/revenue-recognition']);
    expect(objs(c.quads, SCHEMA_NS + 'homepage')).toEqual([valid[1]]);
    expect(refused(r.quads)).toEqual([]);
  });

  it('writes only terms the node accepts, for every vendored bundle', () => {
    for (const name of ['crypto_bitcoin', 'acme_retail', 'synthetic_links', 'edge_cases']) {
      const r = importBundle(loadBundleDir(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
      expect(refused(r.quads), name).toEqual([]);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  exportBundle,
  exportInputFromQuads,
  importBundle,
  loadBundleDir,
  parseDocument,
  quadsToNQuads,
  validateBundle,
  DKG_HAS_SECTION,
  GENID_TAGS,
  PROV_WAS_DERIVED_FROM,
  RDF_TYPE,
  SCHEMA_IS_PART_OF,
  SCHEMA_NAME,
  SCHEMA_URL,
  SECTION_GENID_INFIX,
} from '../src/index.js';
import type { BundleFile, Quad } from '../src/index.js';
import { objs, IDX_V02, bundle, exportedFrontmatter } from './helpers/okf-v02-fixtures.js';

const files = loadBundleDir(fileURLToPath(new URL('./fixtures/crypto_bitcoin', import.meta.url)));

/**
 * The semantic graph: every quad minus the presentational `dkg:hasSection`
 * structure (the `hasSection` edges and the skolemized *section* nodes). The
 * v0.2 family nodes (`okfver_` / `okfsrc_` / `okfparam_`) ARE part of the
 * semantic graph and must survive the round trip. Equivalence is asserted over
 * this projection (export is graph-faithful, not byte-faithful — see export.ts).
 */
function semantic(quads: Quad[]): string {
  const sectionNode = SECTION_GENID_INFIX + GENID_TAGS.section;
  return quadsToNQuads(
    quads.filter((q) => !q.subject.includes(sectionNode) && q.predicate !== DKG_HAS_SECTION),
  );
}

describe('round-trip: import → export → import (§4.2)', () => {
  const first = importBundle(files);
  const exported = exportBundle(first);
  const second = importBundle(exported);

  it('reproduces an equivalent semantic graph', () => {
    expect(semantic(second.quads)).toBe(semantic(first.quads));
  });

  it('reproduces the same 5 concepts and reconstructed edges', () => {
    expect(second.concepts.map((c) => c.conceptId).sort()).toEqual(
      first.concepts.map((c) => c.conceptId).sort(),
    );
    const edgesOf = (r: typeof first, id: string) =>
      [...new Set(r.concepts.find((c) => c.conceptId === id)!.resolvedLinks.map((l) => l.targetConceptId))].sort();
    for (const id of first.concepts.map((c) => c.conceptId)) {
      expect(edgesOf(second, id)).toEqual(edgesOf(first, id));
    }
  });

  it('produces a §9-conformant bundle', () => {
    expect(validateBundle(exported).conformant).toBe(true);
  });
});

describe('round-trip preserves typed producer-key scalars (export fidelity)', () => {
  // Producer-defined numeric/boolean keys must keep their RDF datatype across
  // import → export → import; otherwise `count: 3` degrades to a string literal.
  const bundle = [
    {
      path: 'm.md',
      content:
        '---\n' +
        'type: Metric\n' +
        'title: M\n' +
        'count: 3\n' +
        'ratio: 1.5\n' +
        'active: true\n' +
        'archived: false\n' +
        '---\n\nbody\n',
    },
  ];

  const first = importBundle(bundle);
  const second = importBundle(exportBundle(first));

  const objFor = (r: typeof first, predicate: string) =>
    r.concepts[0].quads.find((q) => q.predicate === predicate)?.object;

  it('keeps xsd:integer / xsd:decimal / xsd:boolean datatypes', () => {
    expect(objFor(second, 'http://schema.org/count')).toBe(
      '"3"^^<http://www.w3.org/2001/XMLSchema#integer>',
    );
    expect(objFor(second, 'http://schema.org/ratio')).toBe(
      '"1.5"^^<http://www.w3.org/2001/XMLSchema#decimal>',
    );
    expect(objFor(second, 'http://schema.org/active')).toBe(
      '"true"^^<http://www.w3.org/2001/XMLSchema#boolean>',
    );
    expect(objFor(second, 'http://schema.org/archived')).toBe(
      '"false"^^<http://www.w3.org/2001/XMLSchema#boolean>',
    );
    // and they match the first import exactly
    for (const p of ['count', 'ratio', 'active', 'archived']) {
      expect(objFor(second, `http://schema.org/${p}`)).toBe(objFor(first, `http://schema.org/${p}`));
    }
  });
});

describe('export only rewrites IRIs that are exported concepts', () => {
  // With a custom iriBase the namespace alone does not identify a concept:
  // an external https://example.org/docs/external must survive verbatim.
  const BASE = 'https://example.org/';
  const files: BundleFile[] = [
    { path: 'index.md', content: '---\nokf_version: "0.2"\n---\n\n# Root\n' },
    {
      path: 'metric.md',
      content: [
        '---',
        'type: Attested Computation',
        'runtime: bigquery',
        'computation: https://example.org/sql/revenue.sql',
        'executor: { resource: https://example.org/skills/run.md }',
        'attester: { resource: /policy.md }',
        'sources:',
        '  - { id: ext, resource: https://example.org/docs/external }',
        '  - { id: pol, resource: /policy.md }',
        '---',
        '',
        'body',
        '',
      ].join('\n'),
    },
    { path: 'policy.md', content: '---\ntype: Policy\n---\n\nbody\n' },
  ];

  it('keeps external IRIs under the namespace verbatim and writes real concepts as bundle paths', () => {
    const first = importBundle(files, { iriBase: BASE });
    const exported = exportBundle(first, { iriBase: BASE });
    const fm = parseDocument('metric.md', exported.find((f) => f.path === 'metric.md')!.content).frontmatter;
    expect(fm.sources).toEqual([
      { id: 'ext', resource: 'https://example.org/docs/external' },
      { id: 'pol', resource: '/policy.md' },
    ]);
    expect(fm.computation).toBe('https://example.org/sql/revenue.sql');
    expect(fm.executor).toEqual({ resource: 'https://example.org/skills/run.md' });
    expect(fm.attester).toEqual({ resource: '/policy.md' });
  });

  it('round-trips graph-equal, lineage edges included', () => {
    const first = importBundle(files, { iriBase: BASE });
    const second = importBundle(exportBundle(first, { iriBase: BASE }), { iriBase: BASE });
    const metric = (r: typeof first) => r.concepts.find((c) => c.conceptId === 'metric')!;
    expect(objs(metric(first).quads, PROV_WAS_DERIVED_FROM, BASE + 'metric').sort()).toEqual([
      'https://example.org/docs/external',
      'https://example.org/policy',
    ]);
    expect(quadsToNQuads(metric(second).quads)).toBe(quadsToNQuads(metric(first).quads));
  });
});

describe('exportInputFromQuads: the package rebuilds concepts from a graph in any order', () => {
  const BASE = 'https://example.org/';
  const files: BundleFile[] = [
    IDX_V02(),
    {
      path: 'a.md',
      content: '---\ntype: Metric\nverified:\n  - { by: human:a }\n  - { by: process:b }\nsources:\n  - { id: s0, resource: /b.md }\n---\n\n# Notes\n\nbody\n',
    },
    { path: 'b.md', content: '---\ntype: Attested Computation\nruntime: dbt\nparameters:\n  - { name: year }\n  - { name: region }\n---\n\nbody\n' },
  ];
  const imported = importBundle(files, { iriBase: BASE });
  const sectionNode = '/.well-known/genid/' + GENID_TAGS.section;
  const semantic = (quads: Quad[]) =>
    quadsToNQuads(quads.filter((q) => !q.subject.includes(sectionNode) && q.predicate !== DKG_HAS_SECTION));

  it('selects typed roots under the base and attaches every node to its owner', () => {
    const noise: Quad[] = [
      { subject: `${BASE}untyped`, predicate: SCHEMA_NAME, object: '"no rdf:type"' },
      { subject: 'urn:elsewhere:x', predicate: RDF_TYPE, object: 'http://schema.org/Thing' },
    ];
    const input = exportInputFromQuads([...noise, ...[...imported.quads].reverse()], { iriBase: BASE });
    expect(input.concepts.map((c) => c.conceptId).sort()).toEqual(['a', 'b']);
    for (const c of input.concepts) {
      expect(c.iri).toBe(BASE + c.conceptId);
      for (const q of c.quads) expect(q.subject === c.iri || q.subject.startsWith(`${c.iri}/.well-known/genid/`)).toBe(true);
    }
    const a = input.concepts.find((c) => c.conceptId === 'a')!;
    expect(a.quads.some((q) => q.subject.includes(GENID_TAGS.verification))).toBe(true);
    expect(a.quads.some((q) => q.subject.includes(GENID_TAGS.parameter))).toBe(false);
  });

  it('round-trips the semantic graph from shuffled quads under a custom base', () => {
    let x = 99;
    const shuffledQuads = [...imported.quads];
    for (let i = shuffledQuads.length - 1; i > 0; i--) {
      x = (x * 1103515245 + 12345) % 2147483648;
      const j = x % (i + 1);
      [shuffledQuads[i], shuffledQuads[j]] = [shuffledQuads[j], shuffledQuads[i]];
    }
    const exported = exportBundle(exportInputFromQuads(shuffledQuads, { iriBase: BASE }), { iriBase: BASE });
    expect(exported.some((f) => f.path.includes('.well-known'))).toBe(false);
    expect(semantic(importBundle(exported, { iriBase: BASE }).quads)).toBe(semantic(imported.quads));
  });
});

describe('arbitrary producer keys, prototype names included', () => {
  // `key in obj` is true for inherited names, and plain assignment of
  // `__proto__` runs the prototype setter; neither may drop a producer key.
  const PROTO = [
    'type: Metric',
    'constructor: c0',
    'toString: t0',
    'generated: { by: human:a, constructor: c1, toString: t1, __proto__: p1 }',
    'verified:',
    '  - { by: human:a, constructor: c2, __proto__: p2 }',
    'sources:',
    '  - { id: s, resource: https://x.example/s, toString: t3, usage_window: { from: 2026-05-01T00:00:00Z, constructor: c4, __proto__: p4 } }',
    'usage_window: { from: 2026-06-01T00:00:00Z, toString: t5 }',
    'parameters:',
    '  - { name: year, constructor: c6, __proto__: p6 }',
    'executor: { resource: https://example.org/run, constructor: custom, toString: t7, __proto__: p7 }',
    'attester: { resource: https://x.example/a, valueOf: v8 }',
  ].join('\n');
  const own = (obj: unknown, key: string) => Object.getOwnPropertyDescriptor(obj as object, key)?.value;

  it('writes every key back in every family', () => {
    const fm = exportedFrontmatter(bundle(PROTO));
    expect([own(fm, 'constructor'), own(fm, 'toString')]).toEqual(['c0', 't0']);
    expect(['constructor', 'toString', '__proto__'].map((k) => own(fm.generated, k))).toEqual(['c1', 't1', 'p1']);
    const [v] = fm.verified as unknown[];
    expect([own(v, 'constructor'), own(v, '__proto__')]).toEqual(['c2', 'p2']);
    const [src] = fm.sources as Array<Record<string, unknown>>;
    expect(own(src, 'toString')).toBe('t3');
    expect([own(src.usage_window, 'constructor'), own(src.usage_window, '__proto__')]).toEqual(['c4', 'p4']);
    expect(own(fm.usage_window, 'toString')).toBe('t5');
    const [param] = fm.parameters as unknown[];
    expect([own(param, 'constructor'), own(param, '__proto__')]).toEqual(['c6', 'p6']);
    expect(['constructor', 'toString', '__proto__'].map((k) => own(fm.executor, k))).toEqual(['custom', 't7', 'p7']);
    expect(own(fm.attester, 'valueOf')).toBe('v8');
    // and no prototype was replaced along the way
    expect(Object.getPrototypeOf(fm.executor)).toBe(Object.prototype);
  });

  it('round-trips the graph exactly', () => {
    const first = importBundle(bundle(PROTO));
    const second = importBundle(exportBundle(first));
    const strip = (r: typeof first) => quadsToNQuads(r.quads.filter((q) => !q.subject.includes(GENID_TAGS.section) && q.predicate !== DKG_HAS_SECTION));
    expect(strip(second)).toBe(strip(first));
  });
});

describe('the same triple from several named graphs is one triple on export', () => {
  const acme = loadBundleDir(fileURLToPath(new URL('./fixtures/acme_retail', import.meta.url)));
  const bitcoin = loadBundleDir(fileURLToPath(new URL('./fixtures/crypto_bitcoin', import.meta.url)));

  it('exports doubled rows byte-for-byte like the single graph', () => {
    for (const files of [acme, bitcoin]) {
      const imported = importBundle(files);
      const single = exportBundle(exportInputFromQuads(imported.quads));
      expect(single).toEqual(exportBundle(imported));
      expect(exportBundle(exportInputFromQuads([...imported.quads, ...imported.quads]))).toEqual(single);
      // a caller-built ExportInput with repeats is normalised as well
      const repeated = { concepts: imported.concepts.map((c) => ({ ...c, quads: [...c.quads, ...c.quads] })) };
      expect(exportBundle(repeated)).toEqual(single);
    }
  });

  it('keeps distinct sources that name the same resource as separate entries', () => {
    const files = bundle('type: Metric\nsources:\n  - { id: a, resource: /policies/revenue-recognition.md }\n  - { id: b, resource: /policies/revenue-recognition.md }');
    const imported = importBundle(files);
    const doubled = exportBundle(exportInputFromQuads([...imported.quads, ...imported.quads]));
    const fm = parseDocument('metrics/revenue.md', doubled.find((f) => f.path === 'metrics/revenue.md')!.content).frontmatter;
    expect(fm.sources).toEqual([
      { id: 'a', resource: '/policies/revenue-recognition.md' },
      { id: 'b', resource: '/policies/revenue-recognition.md' },
    ]);
  });
});

describe('rdf:type export', () => {
  const TYPES: Array<[string, string]> = [
    ['http://schema.org/toString', 'http://schema.org/toString'],
    ['http://schema.org/constructor', 'http://schema.org/constructor'],
    ['http://schema.org/__proto__', 'http://schema.org/__proto__'],
    ['http://schema.org/foo-bar', 'http://schema.org/foo-bar'],
    ['http://schema.org/thing', 'http://schema.org/thing'],
    ['BigQuery Table', 'BigQueryTable'],
    ['Attested Computation', 'Attested Computation'],
    ['https://example.org/Custom', 'https://example.org/Custom'],
  ];
  const files: BundleFile[] = [IDX_V02(), ...TYPES.map(([type], i) => ({ path: `t${i}.md`, content: `---\ntype: ${type}\n---\n\nbody\n` }))];
  const imported = importBundle(files);

  it('writes a string for every type, and the full IRI when a bare local name would not map back', () => {
    const exported = exportBundle(imported);
    TYPES.forEach(([, expected], i) => {
      const fm = parseDocument(`t${i}.md`, exported.find((f) => f.path === `t${i}.md`)!.content).frontmatter;
      expect(typeof fm.type).toBe('string');
      expect(fm.type).toBe(expected);
    });
  });

  it('re-imports every concept with its original rdf:type', () => {
    const exported = exportBundle(imported);
    const typesOf = (r: typeof imported) => r.quads.filter((q) => q.predicate === RDF_TYPE).map((q) => `${q.subject} ${q.object}`).sort();
    expect(typesOf(importBundle(exported))).toEqual(typesOf(imported));
  });
});

describe('schema:isPartOf and schema:url on export', () => {
  it('keeps an explicit isPartOf producer value', () => {
    const files = [IDX_V02(), { path: 'reports/q.md', content: '---\ntype: Metric\nisPartOf: FY2026 reporting\n---\n\nbody\n' }];
    const first = importBundle(files);
    const exported = exportBundle(first);
    expect(parseDocument('reports/q.md', exported.find((f) => f.path === 'reports/q.md')!.content).frontmatter.isPartOf).toBe('FY2026 reporting');
    expect(quadsToNQuads(importBundle(exported).quads.filter((q) => q.predicate === SCHEMA_IS_PART_OF))).toBe(
      quadsToNQuads(first.quads.filter((q) => q.predicate === SCHEMA_IS_PART_OF)),
    );
  });

  it('omits only the folder edge emitFolderHierarchy infers, which the option re-derives', () => {
    const files = [IDX_V02(), { path: 'reports/q.md', content: '---\ntype: Metric\nisPartOf: FY2026 reporting\n---\n\nbody\n' }];
    const first = importBundle(files, { emitFolderHierarchy: true });
    expect(objs(first.quads, SCHEMA_IS_PART_OF, 'urn:okf:reports/q').sort()).toEqual(['"FY2026 reporting"', 'urn:okf:reports']);
    const exported = exportBundle(first);
    expect(parseDocument('reports/q.md', exported.find((f) => f.path === 'reports/q.md')!.content).frontmatter.isPartOf).toBe('FY2026 reporting');
    expect(quadsToNQuads(importBundle(exported, { emitFolderHierarchy: true }).quads.filter((q) => q.predicate === SCHEMA_IS_PART_OF))).toBe(
      quadsToNQuads(first.quads.filter((q) => q.predicate === SCHEMA_IS_PART_OF)),
    );
  });

  it('writes a resource that is not an IRI back by value, not as a quoted term', () => {
    const files = [IDX_V02(), { path: 'a.md', content: '---\ntype: Metric\nresource: tables/orders\n---\n\nbody\n' }];
    const first = importBundle(files);
    const exported = exportBundle(first);
    expect(parseDocument('a.md', exported.find((f) => f.path === 'a.md')!.content).frontmatter.resource).toBe('tables/orders');
    expect(objs(importBundle(exported).quads, SCHEMA_URL, 'urn:okf:a')).toEqual(['"tables/orders"']);
  });
});

describe('export depends only on which triples the graph holds', () => {
  // A store returns rows in its own order; two nodes holding the same graph,
  // on any backend, must export the same bundle.
  const acme = loadBundleDir(fileURLToPath(new URL('./fixtures/acme_retail', import.meta.url)));
  const mixed = bundle(
    [
      'type: Metric',
      'title: Revenue',
      'tags: [revenue, finance, headline]',
      'zeta: last',
      'alpha: first',
      'authors: [human:b, human:a]',
      'runtime: [second, first]',
      'executor: { resource: https://x.example/run, retry: 2, backoff: linear }',
    ].join('\n'),
    '# Citations\n\n[1] [b](https://b.example/)\n[2] [a](https://a.example/)\n',
  );
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

  it('exports byte-identically from rows in any order', () => {
    for (const bundleFiles of [files, acme, mixed]) {
      const imported = importBundle(bundleFiles);
      const direct = exportBundle(imported);
      for (const seed of [7, 42, 2026]) {
        expect(exportBundle(exportInputFromQuads(shuffled(imported.quads, seed)))).toEqual(direct);
        expect(exportBundle(exportInputFromQuads([...imported.quads].reverse()))).toEqual(direct);
      }
    }
  });

  it('orders the collections RDF keeps no order for, and leaves a single JSON value as written', () => {
    const fm = exportedFrontmatter(mixed);
    expect(fm.tags).toEqual(['finance', 'headline', 'revenue']);
    expect(fm.authors).toEqual(['human:a', 'human:b']);
    // producer keys follow the known keys, in canonical order
    const keys = Object.keys(fm);
    expect(keys.indexOf('alpha')).toBeLessThan(keys.indexOf('zeta'));
    expect(keys.indexOf('type')).toBeLessThan(keys.indexOf('alpha'));
    // a family field kept verbatim as one JSON literal keeps its own order
    expect(fm.runtime).toEqual(['second', 'first']);
    // extension keys follow the family's own fields, in canonical order
    expect(Object.keys(fm.executor as object)).toEqual(['resource', 'backoff', 'retry']);
    const body = exportBundle(importBundle(mixed)).find((f) => f.path === 'metrics/revenue.md')!.content;
    expect(body.indexOf('https://a.example/')).toBeLessThan(body.indexOf('https://b.example/'));
  });

  it('exports the same value for a single-valued field that holds two, whichever arrives first', () => {
    const concept = (quads: Quad[]) => ({ concepts: [{ conceptId: 'x', iri: 'urn:okf:x', quads }] });
    const typed: Quad = { subject: 'urn:okf:x', predicate: RDF_TYPE, object: 'http://schema.org/Thing' };
    const a: Quad = { subject: 'urn:okf:x', predicate: SCHEMA_NAME, object: '"Alpha"' };
    const b: Quad = { subject: 'urn:okf:x', predicate: SCHEMA_NAME, object: '"Beta"' };
    const titleOf = (quads: Quad[]) => parseDocument('x.md', exportBundle(concept(quads)).find((f) => f.path === 'x.md')!.content).frontmatter.title;
    expect(titleOf([typed, a, b])).toBe(titleOf([b, typed, a]));
  });
});

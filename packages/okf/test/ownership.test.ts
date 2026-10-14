import { describe, it, expect } from 'vitest';
import {
  exportBundle,
  exportInputFromQuads,
  importBundle,
  parseDocument,
  GENID_TAGS,
  OKF_GENERATED_AT,
  OKF_LEGACY_TIMESTAMP,
  OKF_NS,
  OKF_PRODUCER_DATE_MODIFIED,
  SCHEMA_DATE_MODIFIED,
  RDF_JSON,
  SCHEMA_NS,
  YamlTimestamp,
} from '../src/index.js';
import type { Quad } from '../src/index.js';
import { normalizeOwnership } from '../src/families/ownership.js';
import { DT, IRI, bundle, node } from './helpers/okf-v02-fixtures.js';

// A graph written before values were marked is read as one written now:
// `normalizeOwnership` adds the marker of every owner the graph leaves
// unnamed, and the family readers read declared ownership alone.
const ctx = { iriBase: 'urn:okf:', conceptIris: new Set([IRI]) };
const DATE_MARKERS: readonly string[] = [OKF_GENERATED_AT, OKF_PRODUCER_DATE_MODIFIED, OKF_LEGACY_TIMESTAMP];
const isMarker = (q: Quad) => q.predicate.startsWith(OKF_NS + 'keptVerbatim.') || DATE_MARKERS.includes(q.predicate);
const imported = (yaml: string) => importBundle(bundle(`type: Metric\n${yaml}`)).quads;
const onConcept = (quads: readonly Quad[]) => quads.filter((q) => q.subject === IRI);
const markersOf = (quads: readonly Quad[]) => quads.filter(isMarker).map((q) => `${q.predicate} ${q.object}`).sort();
const normalized = (quads: readonly Quad[]) => normalizeOwnership(onConcept(quads), (n) => quads.filter((q) => q.subject === n), ctx);
const frontmatterOf = (quads: readonly Quad[]) => {
  const file = exportBundle(exportInputFromQuads(quads)).find((f) => f.path === 'metrics/revenue.md')!;
  return parseDocument(file.path, file.content).frontmatter;
};
const STAMP = DT('2026-01-01T00:00:00Z');

describe('ownership is made explicit before the families are decoded', () => {
  it('names the owners of an unmarked graph with the markers the encoder writes', () => {
    // The legacy timestamp is named too, which the encoder leaves unmarked.
    for (const [yaml, timestamp] of [
      ['generated: [a]', false],
      ['usage_window: [{ from: 2026-06-01T00:00:00Z }]', false],
      ['generated: { by: human:a, at: [2026-06-30T00:00:00Z] }', false],
      ["timestamp: '2026-01-01T00:00:00Z'\ndateModified: urn:producer:x", true],
      ["generated: [a]\ntimestamp: '2026-01-01T00:00:00Z'\ndateModified: true", true],
    ] as const) {
      const marked = imported(yaml);
      const expected = [...markersOf(onConcept(marked)), ...(timestamp ? [`${OKF_LEGACY_TIMESTAMP} ${STAMP}`] : [])].sort();
      expect(markersOf(normalized(marked.filter((q) => !isMarker(q))).conceptQuads), yaml).toEqual(expected);
    }
  });

  it('adds only the unmarked legacy timestamp to a graph written now', () => {
    for (const [yaml, added] of [
      ['generated: { by: human:a, at: 2026-06-30T00:00:00Z }\ndateModified: urn:producer:x', []],
      ["timestamp: '2026-01-01T00:00:00Z'", [`${OKF_LEGACY_TIMESTAMP} ${STAMP}`]],
      // a producer value on the timestamp's term: the graph names the timestamp itself
      ["timestamp: '2026-01-01T00:00:00Z'\ndateModified: 2026-01-01T00:00:00Z", []],
    ] as const) {
      const marked = imported(yaml);
      const out = normalized(marked).conceptQuads;
      expect(markersOf(out.slice(onConcept(marked).length)), yaml).toEqual(added);
    }
  });

  it('passes every quad of the graph on as the same object', () => {
    const concept = onConcept(imported("generated: [a]\ntimestamp: '2026-01-01T00:00:00Z'").filter((q) => !isMarker(q)));
    const out = normalizeOwnership(concept, () => [], ctx).conceptQuads;
    concept.forEach((q, i) => expect(out[i]).toBe(q));
  });

  it('keeps an owner the graph names, and infers none beside it', () => {
    // `okf:legacyTimestamp` names the timestamp, so an unmarked date beside it is a producer value.
    const graph = [
      ...imported("timestamp: '2026-01-01T00:00:00Z'\ndateModified: 2026-01-01T00:00:00Z"),
      { subject: IRI, predicate: SCHEMA_DATE_MODIFIED, object: DT('2026-03-03T00:00:00Z') },
    ];
    const fm = frontmatterOf(graph);
    expect(fm.timestamp).toBe('2026-01-01T00:00:00Z');
    expect((fm.dateModified as YamlTimestamp[]).map((d) => d.lexical)).toEqual(['2026-01-01T00:00:00Z', '2026-03-03T00:00:00Z']);
  });

  it('reads a graph marked in part, its kept values marked and its dates not', () => {
    const marked = imported("generated: [a]\ntimestamp: '2026-01-01T00:00:00Z'\ndateModified: urn:producer:x");
    expect(frontmatterOf(marked.filter((q) => !DATE_MARKERS.includes(q.predicate)))).toEqual(frontmatterOf(marked));
  });

  it("reads an unmarked entry node's two values for one nested family as the last, as for any single value", () => {
    // Only a merged graph holds two: two imports whose `usage_window` differs.
    const marked = importBundle(bundle("type: Metric\nsources:\n  - { resource: 'https://x.example/s', usage_window: Q2 }")).quads;
    const merged = [...marked.filter((q) => !isMarker(q)), { subject: node(GENID_TAGS.source, 0), predicate: SCHEMA_NS + 'usageWindow', object: '"Q3"' }];
    expect(frontmatterOf(merged).sources).toEqual([{ resource: 'https://x.example/s', usage_window: 'Q3' }]);
    expect(frontmatterOf(marked.filter((q) => !isMarker(q))).sources).toEqual([{ resource: 'https://x.example/s', usage_window: 'Q2' }]);
  });

  // Only a merged or hand-edited graph reaches these, and each reads as it did
  // before ownership was normalized: fields beat a kept value, a declared
  // marker beats an inferred one, and a value kept verbatim has no `at`.
  const json = (value: unknown) => `"${JSON.stringify(value).replaceAll('"', '\\"')}"^^<${RDF_JSON}>`;
  const extra = (predicate: string, value: unknown): Quad => ({ subject: IRI, predicate, object: json(value) });
  const unmarkedGenerated = imported('generated: [a]').filter((q) => !isMarker(q));
  for (const [name, graph, expected] of [
    ['two unmarked kept arrays name no owner', [...unmarkedGenerated, extra(SCHEMA_NS + 'generated', ['b'])], { Generated: [['a'], ['b']] }],
    ['a list family reads an array as entries, never as a value it kept', [...onConcept(imported('')), extra(SCHEMA_NS + 'sources', ['x'])], { Sources: ['x'] }],
    ['a declared kept value beats an unmarked one beside it', [...imported('generated: [a]'), extra(SCHEMA_NS + 'generated', ['b'])], { generated: ['a'], Generated: ['b'] }],
    ['a declared kept single value beats an unmarked array beside it', [...imported('usage_window: Q2'), extra(SCHEMA_NS + 'usageWindow', ['x'])], { usage_window: 'Q2', usageWindow: ['x'] }],
    ['a kept generated has no at, marked', [...imported('generated: [a]'), extra(SCHEMA_DATE_MODIFIED, ['x'])], { generated: ['a'], dateModified: ['x'] }],
    ['a kept generated has no at, unmarked', [...unmarkedGenerated, extra(SCHEMA_DATE_MODIFIED, ['x'])], { generated: ['a'], dateModified: ['x'] }],
  ] as const) {
    it(`keeps today's precedence: ${name}`, () => {
      const { type: _type, ...fm } = frontmatterOf(graph);
      expect(fm).toEqual(expected);
    });
  }
});


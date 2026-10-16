import { describe, it, expect } from 'vitest';
import {
  exportBundle,
  exportInputFromQuads,
  importBundle,
  parseDocument,
  OKF_GENERATED_AT,
  OKF_LEGACY_TIMESTAMP,
  OKF_NS,
  OKF_PRODUCER_DATE_MODIFIED,
  RDF_JSON,
  RDF_TYPE,
  SCHEMA_DATE_MODIFIED,
  SCHEMA_NS,
  XSD_BOOLEAN,
  XSD_DATE_TIME,
  YamlTimestamp,
} from '../src/index.js';
import type { Quad } from '../src/index.js';
import { normalizeOwnership } from '../src/families/ownership.js';
import { DT, IRI, bundle } from './helpers/okf-v02-fixtures.js';

// Only the values on schema:dateModified may be unnamed: the legacy timestamp
// of a graph written now, and every one of a graph the v0.1 mapper wrote.
// `normalizeOwnership` names their owners; every other value is read by its
// marker alone.
const DATE_MARKERS: readonly string[] = [OKF_GENERATED_AT, OKF_PRODUCER_DATE_MODIFIED, OKF_LEGACY_TIMESTAMP];
const isMarker = (q: Quad) => q.predicate.startsWith(OKF_NS + 'keptVerbatim.') || DATE_MARKERS.includes(q.predicate);
const imported = (yaml: string) => importBundle(bundle(`type: Metric\n${yaml}`)).quads;
const onConcept = (quads: readonly Quad[]) => quads.filter((q) => q.subject === IRI);
const markersOf = (quads: readonly Quad[]) => quads.filter(isMarker).map((q) => `${q.predicate} ${q.object}`).sort();
const frontmatterOf = (quads: readonly Quad[]) => {
  const file = exportBundle(exportInputFromQuads(quads)).find((f) => f.path === 'metrics/revenue.md')!;
  const { type: _type, ...fm } = parseDocument(file.path, file.content).frontmatter;
  return fm;
};
const STAMP = DT('2026-01-01T00:00:00Z');
const typed = (lexical: string, datatype: string) => `"${lexical}"^^<${datatype}>`;
const json = (value: unknown) => `"${JSON.stringify(value).replaceAll('"', '\\"')}"^^<${RDF_JSON}>`;
const triple = (predicate: string, object: string): Quad => ({ subject: IRI, predicate, object });

// A concept as the v0.1 mapper (testnet-canary) wrote it: no marker, every
// timestamp typed xsd:dateTime in ISO form, a list one triple per item, a
// mapping as plain JSON text, and the v0.2 families producer keys like any other.
const v01 = (...triples: Quad[]): Quad[] => [triple(RDF_TYPE, SCHEMA_NS + 'Metric'), ...triples];

describe('ownership is made explicit before the families are decoded', () => {
  it('names only the legacy timestamp a graph written now leaves unmarked', () => {
    for (const [yaml, added] of [
      ['generated: { by: human:a, at: 2026-06-30T00:00:00Z }\ndateModified: urn:producer:x', []],
      ["timestamp: '2026-01-01T00:00:00Z'", [`${OKF_LEGACY_TIMESTAMP} ${STAMP}`]],
      // a producer value on the timestamp's term: the graph names the timestamp itself
      ["timestamp: '2026-01-01T00:00:00Z'\ndateModified: 2026-01-01T00:00:00Z", []],
      ['generated: [a]', []],
    ] as const) {
      const concept = onConcept(imported(yaml));
      expect(markersOf(normalizeOwnership(concept).slice(concept.length)), yaml).toEqual(added);
    }
  });

  it('names the dates of a graph the v0.1 mapper wrote by what each owner writes', () => {
    const stamp = typed('2026-01-01T00:00:00.000Z', XSD_DATE_TIME);
    const quads = v01(triple(SCHEMA_DATE_MODIFIED, stamp), triple(SCHEMA_DATE_MODIFIED, 'urn:producer:x'), triple(SCHEMA_DATE_MODIFIED, typed('true', XSD_BOOLEAN)));
    expect(markersOf(normalizeOwnership(quads))).toEqual([
      `${OKF_LEGACY_TIMESTAMP} ${stamp}`,
      `${OKF_PRODUCER_DATE_MODIFIED} ${typed('true', XSD_BOOLEAN)}`,
      `${OKF_PRODUCER_DATE_MODIFIED} urn:producer:x`,
    ].sort());
  });

  it('exports a graph the v0.1 mapper wrote with its timestamp and producer keys, and no family', () => {
    expect(frontmatterOf(v01(
      triple(SCHEMA_DATE_MODIFIED, typed('2026-06-30T14:00:00.000Z', XSD_DATE_TIME)),
      triple(SCHEMA_DATE_MODIFIED, 'urn:producer:x'),
      // `generated: [a]`, a producer key to v0.1, its list flattened
      triple(SCHEMA_NS + 'generated', '"a"'),
      // a mapping, as plain JSON text
      triple(SCHEMA_NS + 'owner', '"{\\"team\\":\\"f\\"}"'),
    ))).toEqual({ timestamp: '2026-06-30T14:00:00.000Z', dateModified: 'urn:producer:x', Generated: 'a', owner: '{"team":"f"}' });
    // The v0.1 mapper typed even text that is no time.
    expect(frontmatterOf(v01(triple(SCHEMA_DATE_MODIFIED, typed('soon', XSD_DATE_TIME))))).toEqual({ timestamp: 'soon' });
  });

  it('keeps an owner the graph names, and infers none beside it', () => {
    // `okf:legacyTimestamp` names the timestamp, so an unmarked date beside it is a producer value.
    const graph = [
      ...imported("timestamp: '2026-01-01T00:00:00Z'\ndateModified: 2026-01-01T00:00:00Z"),
      triple(SCHEMA_DATE_MODIFIED, DT('2026-03-03T00:00:00Z')),
    ];
    const fm = frontmatterOf(graph);
    expect(fm.timestamp).toBe('2026-01-01T00:00:00Z');
    expect((fm.dateModified as YamlTimestamp[]).map((d) => d.lexical)).toEqual(['2026-01-01T00:00:00Z', '2026-03-03T00:00:00Z']);
  });

  // A value the encoder keeps for a family carries its marker; without one it
  // is a producer value, whatever its shape.
  for (const [name, graph, expected] of [
    ['an unmarked array on a family predicate is a producer value', [...onConcept(imported('')), triple(SCHEMA_NS + 'generated', json(['b']))], { Generated: ['b'] }],
    ['a declared kept value beats an unmarked one beside it', [...imported('generated: [a]'), triple(SCHEMA_NS + 'generated', json(['b']))], { generated: ['a'], Generated: ['b'] }],
    ['a declared kept single value beats an unmarked array beside it', [...imported('usage_window: Q2'), triple(SCHEMA_NS + 'usageWindow', json(['x']))], { usage_window: 'Q2', usageWindow: ['x'] }],
    ['an unmarked array on dateModified is a producer value, never generated.at', [...onConcept(imported('')), triple(SCHEMA_DATE_MODIFIED, json(['x']))], { dateModified: ['x'] }],
    ['a kept generated has no at', [...imported('generated: [a]'), triple(SCHEMA_DATE_MODIFIED, json(['x']))], { generated: ['a'], dateModified: ['x'] }],
  ] as const) {
    it(name, () => {
      expect(frontmatterOf(graph)).toEqual(expected);
    });
  }
});

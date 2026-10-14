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
  SCHEMA_DATE_MODIFIED,
  SCHEMA_NS,
  XSD_BOOLEAN,
} from '../src/index.js';
import type { Quad } from '../src/index.js';
import { timestampQuads } from '../src/families/generated.js';
import { generatedAtOf, lastModifiedOf, timestampIsProducerKey } from '../src/frontmatter-keys.js';
import { IRI, bundle, exportedFrontmatter, objs, DT, semantic, shuffled } from './helpers/okf-v02-fixtures.js';

// `generated.at` and the v0.1 `timestamp` share `schema:dateModified` (§13.1):
// export has to give each value back to the key it came from.
const roundTrip = (yaml: string) => {
  const files = bundle(`type: Metric\n${yaml}`);
  const first = importBundle(files);
  const second = importBundle(exportBundle(first));
  return { files, first, second };
};
const messages = (r: ReturnType<typeof importBundle>) => r.warnings.map((w) => w.message);

describe('a last-modified time and a legacy timestamp both survive a round trip', () => {
  // `generated.at` supersedes the v0.1 `timestamp` (§13.1), which is then kept
  // as a producer key: export must write both back, so neither date replaces
  // the other, and each comes back under the key it was written with.
  for (const [name, at, timestamp] of [
    ['a quoted timestamp', '2026-06-30T00:00:00Z', "'2026-01-01T00:00:00Z'"],
    ['an unquoted timestamp', '2026-06-30T00:00:00Z', '2026-01-01T00:00:00Z'],
    ['an invalid generated.at', 'soon', "'2026-01-01T00:00:00Z'"],
  ]) {
    it(`keeps generated.at and the timestamp beside it, with ${name}`, () => {
      const { files, first, second } = roundTrip(`generated: { at: ${at} }\ntimestamp: ${timestamp}`);
      expect(semantic(second.quads)).toBe(semantic(first.quads));
      expect(messages(second)).toEqual(messages(first));
      const fm = exportedFrontmatter(files);
      expect(Object.keys(fm.generated as object)).toEqual(['at']);
      expect('timestamp' in fm).toBe(true);
    });
  }

  it('writes a lone timestamp back as itself, and a lone generated.at inside generated', () => {
    // The legacy `timestamp` is the unmarked value (a v0.1 import);
    // `generated.at` is named by its own predicate, so it is written back where
    // it was, with no actor invented for it.
    for (const [yaml, expected] of [
      ["timestamp: '2026-05-28T22:44:47+00:00'", { timestamp: '2026-05-28T22:44:47+00:00' }],
      ['generated: { at: 2026-06-30T00:00:00Z }', { generated: { at: '2026-06-30T00:00:00Z' } }],
      ["generated: { by: human:a }\ntimestamp: '2026-01-01T00:00:00Z'", { generated: { by: 'human:a' }, timestamp: '2026-01-01T00:00:00Z' }],
    ] as const) {
      const { files, first, second } = roundTrip(yaml);
      expect(semantic(second.quads)).toBe(semantic(first.quads));
      const { type: _type, ...fm } = exportedFrontmatter(files);
      expect(fm).toEqual(expected);
    }
  });

  it('reads a blank generated.at as missing, so the timestamp beside it is the last-modified time', () => {
    const { first, second } = roundTrip("generated: { at: '' }\ntimestamp: '2026-01-01T00:00:00Z'");
    const c = first.concepts.find((x) => x.conceptId === 'metrics/revenue')!;
    expect(objs(c.quads, SCHEMA_DATE_MODIFIED)).toEqual([DT('2026-01-01T00:00:00Z')]);
    expect(c.trust.generatedAt).toBe('2026-01-01T00:00:00Z');
    expect(semantic(second.quads)).toBe(semantic(first.quads));
  });
});

describe('a structured generated.at stays inside generated through a round trip', () => {
  // A mapping or list where `generated.at` expects one time is kept verbatim as
  // rdf:JSON. It is no time the legacy `timestamp` could carry, so export
  // writes it back inside `generated`, and a timestamp beside it as itself.
  const STRUCTURED = ['[2026-06-30T00:00:00Z]', '{ when: 2026-06-30T00:00:00Z }'];
  for (const at of STRUCTURED) {
    for (const timestamp of [null, "'2026-01-01T00:00:00Z'"]) {
      it(`keeps at: ${at}${timestamp ? ' and the timestamp beside it' : ''}`, () => {
        const yaml = `generated: { at: ${at} }${timestamp ? `\ntimestamp: ${timestamp}` : ''}`;
        const { files, first, second } = roundTrip(yaml);
        expect(semantic(second.quads)).toBe(semantic(first.quads));
        expect(messages(second)).toEqual(messages(first));
        const fm = exportedFrontmatter(files);
        expect(typeof (fm.generated as Record<string, unknown>).at).toBe('object');
        expect('timestamp' in fm).toBe(timestamp !== null);
      });
    }
  }

  it('keeps both values when generated also names its actor', () => {
    const { files, first, second } = roundTrip("generated: { by: human:a, at: [2026-06-30T00:00:00Z] }\ntimestamp: '2026-01-01T00:00:00Z'");
    const c = first.concepts.find((x) => x.conceptId === 'metrics/revenue')!;
    expect(objs(c.quads, SCHEMA_DATE_MODIFIED)).toHaveLength(2);
    expect(semantic(second.quads)).toBe(semantic(first.quads));
    const fm = exportedFrontmatter(files);
    expect(fm.generated).toMatchObject({ by: 'human:a', at: ['2026-06-30T00:00:00Z'] });
    expect(fm.timestamp).toBe('2026-01-01T00:00:00Z');
    expect(objs(second.concepts.find((x) => x.conceptId === 'metrics/revenue')!.quads, SCHEMA_DATE_MODIFIED)).toContain(DT('2026-01-01T00:00:00Z'));
  });
});

describe('one codec owns the generated / timestamp rule', () => {
  it('decides precedence once, for the mapper, the summary and the producer-key check', () => {
    const iri = 'urn:okf:x';
    const cases: Array<{ fm: Record<string, unknown>; supersedes: boolean; lastModified: string }> = [
      { fm: { generated: { at: '2026-06-30T00:00:00Z' }, timestamp: '2026-01-01T00:00:00Z' }, supersedes: true, lastModified: '2026-06-30T00:00:00Z' },
      { fm: { timestamp: '2026-01-01T00:00:00Z' }, supersedes: false, lastModified: '2026-01-01T00:00:00Z' },
      { fm: { generated: { at: '' }, timestamp: '2026-01-01T00:00:00Z' }, supersedes: false, lastModified: '2026-01-01T00:00:00Z' },
      { fm: { generated: { at: ['2026-06-30T00:00:00Z'] }, timestamp: '2026-01-01T00:00:00Z' }, supersedes: false, lastModified: '2026-01-01T00:00:00Z' },
    ];
    for (const { fm, supersedes, lastModified } of cases) {
      expect(generatedAtOf(fm) !== null).toBe(supersedes);
      expect(timestampIsProducerKey(fm)).toBe(supersedes);
      expect(timestampQuads(iri, fm, fm.timestamp).map((q) => q.predicate)).toEqual([supersedes ? SCHEMA_NS + 'timestamp' : SCHEMA_DATE_MODIFIED]);
      expect(lastModifiedOf(fm)).toBe(lastModified);
    }
  });
});

describe('a generated value kept verbatim stays itself beside a timestamp and a Timestamp producer key', () => {
  it('keeps the array, the legacy timestamp and the producer value apart', () => {
    // `generated: [a]` is no mapping, so no `generated.at` supersedes the
    // timestamp: the schema:timestamp beside it is the `Timestamp` producer
    // key's, not the sign of a generated.at.
    const { files, first, second } = roundTrip("generated: [a]\ntimestamp: '2026-01-01T00:00:00Z'\nTimestamp: producer-value");
    expect(semantic(second.quads)).toBe(semantic(first.quads));
    expect(messages(second)).toEqual(messages(first));
    const c = second.concepts.find((x) => x.conceptId === 'metrics/revenue')!;
    expect(objs(c.quads, SCHEMA_NS + 'generated')).toEqual([`"[\\"a\\"]"^^<${RDF_JSON}>`]);
    expect(objs(c.quads, SCHEMA_DATE_MODIFIED)).toEqual([DT('2026-01-01T00:00:00Z')]);
    expect(objs(c.quads, SCHEMA_NS + 'timestamp')).toEqual(['"producer-value"']);
    const fm = exportedFrontmatter(files);
    expect(fm.generated).toEqual(['a']);
    expect(fm.timestamp).toBe('2026-01-01T00:00:00Z');
    expect(fm.Timestamp).toBe('producer-value');
  });
});

describe('a producer key named dateModified keeps its value beside generated and the timestamp', () => {
  // schema:dateModified carries generated.at, the legacy timestamp, and a
  // producer key named `dateModified`: each value names its owner, so every
  // value comes back under its own key.
  for (const yaml of [
    'generated: [a]\ndateModified: { note: producer }',
    'generated: { by: human:a, at: 2026-06-30T00:00:00Z }\ndateModified: 2026-01-01T00:00:00Z',
    'generated: { by: human:a, at: [2026-06-30T00:00:00Z] }\ndateModified: { note: producer }',
  ]) {
    it(`keeps every value of ${yaml.replace('\n', ' + ')}`, () => {
      const { files, first, second } = roundTrip(yaml);
      expect(semantic(second.quads)).toBe(semantic(first.quads));
      expect(messages(second)).toEqual(messages(first));
      expect('dateModified' in exportedFrontmatter(files)).toBe(true);
    });
  }

  it('keeps the kept generated array and its marker beside a JSON dateModified', () => {
    const { first, second } = roundTrip('generated: [a]\ndateModified: { note: producer }');
    for (const r of [first, second]) {
      const c = r.concepts.find((x) => x.conceptId === 'metrics/revenue')!;
      expect(objs(c.quads, SCHEMA_NS + 'generated')).toEqual([`"[\\"a\\"]"^^<${RDF_JSON}>`]);
      expect(objs(c.quads, SCHEMA_DATE_MODIFIED)).toEqual([`"{\\"note\\":\\"producer\\"}"^^<${RDF_JSON}>`]);
    }
  });
});

describe('each value on schema:dateModified names its owner', () => {
  const AT = DT('2026-06-30T00:00:00Z');
  const concept = (r: ReturnType<typeof importBundle>) => r.concepts.find((x) => x.conceptId === 'metrics/revenue')!;

  it('keeps generated.at and an IRI or boolean dateModified apart, kinds and summary unchanged', () => {
    for (const [producer, term, value] of [
      ['urn:producer:x', 'urn:producer:x', 'urn:producer:x'],
      ['true', `"true"^^<${XSD_BOOLEAN}>`, true],
    ] as const) {
      const { files, first, second } = roundTrip(`generated: { by: human:a, at: 2026-06-30T00:00:00Z }\ndateModified: ${producer}`);
      for (const r of [first, second]) {
        const c = concept(r);
        expect(objs(c.quads, SCHEMA_DATE_MODIFIED).sort()).toEqual([AT, term].sort());
        expect(objs(c.quads, OKF_GENERATED_AT)).toEqual([AT]);
        expect(objs(c.quads, OKF_PRODUCER_DATE_MODIFIED)).toEqual([term]);
        expect(c.trust.generatedAt).toBe('2026-06-30T00:00:00Z');
      }
      expect(semantic(second.quads)).toBe(semantic(first.quads));
      const fm = exportedFrontmatter(files);
      expect(fm.generated).toEqual({ by: 'human:a', at: '2026-06-30T00:00:00Z' });
      expect(fm.dateModified).toBe(value);
    }
  });

  it('writes the legacy timestamp unmarked, as v0.1 did, and names it where a producer value holds its term', () => {
    const okfOn = (r: ReturnType<typeof importBundle>) => r.quads.filter((q) => q.subject === IRI && q.predicate.startsWith(OKF_NS));
    expect(okfOn(roundTrip("timestamp: '2026-01-01T00:00:00Z'").first)).toEqual([]);
    expect(okfOn(roundTrip("timestamp: '2026-01-01T00:00:00Z'\ndateModified: 2026-02-02T00:00:00Z").first).map((q) => q.predicate)).toEqual([OKF_PRODUCER_DATE_MODIFIED]);
    const { first } = roundTrip("timestamp: '2026-01-01T00:00:00Z'\ndateModified: 2026-01-01T00:00:00Z");
    const stamp = DT('2026-01-01T00:00:00Z');
    expect(objs(first.quads, SCHEMA_DATE_MODIFIED)).toEqual([stamp]);
    expect(objs(first.quads, OKF_LEGACY_TIMESTAMP)).toEqual([stamp]);
    expect(objs(first.quads, OKF_PRODUCER_DATE_MODIFIED)).toEqual([stamp]);
  });

  // Each owner's value comes back under its own key, the summary unchanged,
  // whatever order the rows come in: generated.at, the timestamp and producer
  // values on one term, structured values included.
  for (const yaml of [
    'generated: { by: human:a, at: 2026-06-30T00:00:00Z }\ndateModified: 2026-06-30T00:00:00Z',
    'generated: { by: human:a, at: soon }\ndateModified: soon',
    'generated: { by: human:a, at: { when: 2026-06-30T00:00:00Z } }\ndateModified: { when: 2026-06-30T00:00:00Z }',
    'generated: { by: human:a, at: [] }\ndateModified: []',
    'generated: { at: [2026-06-30T00:00:00Z] }\ntimestamp: 2026-01-01T00:00:00Z\ndateModified: 2026-01-01T00:00:00Z',
    'timestamp: 2026-01-01T00:00:00Z\ndateModified: 2026-01-01T00:00:00Z',
    'timestamp: yesterday\ndateModified: yesterday',
    'timestamp: 2026-01-01T00:00:00Z\ndateModified: [2026-01-01T00:00:00Z, urn:x]',
    'generated: [a]\ntimestamp: 2026-01-01T00:00:00Z\ndateModified: 2026-02-02',
    'dateModified: 2026-01-01T00:00:00Z',
    "timestamp: ['2026-01-01T00:00:00Z']",
    'timestamp: { a: 1 }\ndateModified: { a: 1 }',
    'generated: { by: human:a, at: [2026-06-30T00:00:00Z] }\ntimestamp: [2026-06-30T00:00:00Z]',
  ]) {
    it(`gives every value back to its key: ${yaml.replaceAll('\n', ' + ')}`, () => {
      const { files, first, second } = roundTrip(yaml);
      expect(semantic(second.quads)).toBe(semantic(first.quads));
      expect(concept(second).trust).toEqual(concept(first).trust);
      const fm = exportedFrontmatter(files);
      for (const key of yaml.split('\n').map((line) => line.split(':')[0])) expect(key in fm, key).toBe(true);
      const direct = exportBundle(first);
      for (const seed of [7, 42, 2026]) expect(exportBundle(exportInputFromQuads(shuffled(first.quads, seed)))).toEqual(direct);
    });
  }
});

describe('the dates of a graph the v0.1 mapper wrote read back by what each owner writes', () => {
  // The v0.1 mapper marked no value on schema:dateModified: its timestamp and
  // its producer values are told apart by what each can write.
  const DATE_MARKERS: readonly string[] = [OKF_GENERATED_AT, OKF_PRODUCER_DATE_MODIFIED, OKF_LEGACY_TIMESTAMP];
  const unmarked = (quads: readonly Quad[]) => quads.filter((q) => !DATE_MARKERS.includes(q.predicate));
  const graphOf = (yaml: string) => unmarked(importBundle(bundle(`type: Metric\n${yaml}`)).quads);
  const exportOf = (quads: readonly Quad[]) => exportBundle(exportInputFromQuads(quads));
  const frontmatterOf = (quads: readonly Quad[]) => {
    const file = exportOf(quads).find((f) => f.path === 'metrics/revenue.md')!;
    return parseDocument(file.path, file.content).frontmatter;
  };

  it('reads a time as the legacy timestamp and a value of any other kind as a producer value', () => {
    expect(frontmatterOf(graphOf("timestamp: '2026-01-01T00:00:00Z'\ndateModified: urn:producer:x"))).toMatchObject({ timestamp: '2026-01-01T00:00:00Z', dateModified: 'urn:producer:x' });
    expect(frontmatterOf(graphOf("timestamp: '2026-01-01T00:00:00Z'\ndateModified: hello"))).toMatchObject({ timestamp: '2026-01-01T00:00:00Z', dateModified: 'hello' });
  });

  it('reads text a store returns as xsd:string as the timestamp, the same literal as plain text', () => {
    const plain = '"yesterday"';
    const graph = graphOf('timestamp: yesterday').map((q) =>
      q.predicate === SCHEMA_DATE_MODIFIED && q.object === plain ? { ...q, object: '"yesterday"^^<http://www.w3.org/2001/XMLSchema#string>' } : q,
    );
    expect(objs(graph, SCHEMA_DATE_MODIFIED)).not.toContain(plain);
    expect(frontmatterOf(graph)).toMatchObject({ timestamp: 'yesterday' });
    expect('dateModified' in frontmatterOf(graph)).toBe(false);
  });

  it('never reads a timestamp beside a generated.at that gives a time, as when a v0.1 import is merged with one written now', () => {
    const marked = importBundle(bundle('type: Metric\ngenerated: { by: human:a, at: 2026-06-30T00:00:00Z }')).quads;
    const graph = [...marked, { subject: IRI, predicate: SCHEMA_DATE_MODIFIED, object: DT('2026-01-01T00:00:00Z') }];
    const fm = frontmatterOf(graph);
    expect(fm.generated).toEqual({ by: 'human:a', at: '2026-06-30T00:00:00Z' });
    expect('timestamp' in fm).toBe(false);
    expect(objs(importBundle(exportOf(graph)).quads, OKF_PRODUCER_DATE_MODIFIED)).toEqual([DT('2026-01-01T00:00:00Z')]);
  });
});

describe('a legacy timestamp given as a list or mapping is kept whole, with a warning', () => {
  // A list or mapping gives no time: it is kept as one rdf:JSON value, named
  // as the timestamp's, and no last-modified time is made of it.
  const WARNING = '`timestamp` should be a single value, not a mapping or list (§13.1); kept verbatim';
  const concept = (r: ReturnType<typeof importBundle>) => r.concepts.find((x) => x.conceptId === 'metrics/revenue')!;
  const json = (value: unknown) => `"${JSON.stringify(value).replaceAll('"', '\\"')}"^^<${RDF_JSON}>`;
  for (const [yaml, value] of [
    ["['2026-01-01T00:00:00Z']", ['2026-01-01T00:00:00Z']],
    ['{ when: 2026-01-01T00:00:00Z }', { when: '2026-01-01T00:00:00Z' }],
    ['[]', []],
  ] as const) {
    it(`keeps timestamp: ${yaml}`, () => {
      const { files, first, second } = roundTrip(`timestamp: ${yaml}`);
      const c = concept(first);
      expect(objs(c.quads, SCHEMA_DATE_MODIFIED)).toEqual([json(value)]);
      expect(objs(c.quads, OKF_LEGACY_TIMESTAMP)).toEqual([json(value)]);
      expect(c.trust.generatedAt).toBeNull();
      expect(messages(first)).toContain(WARNING);
      expect(exportedFrontmatter(files).timestamp).toEqual(value);
      expect(semantic(second.quads)).toBe(semantic(first.quads));
      expect(messages(second)).toEqual(messages(first));
    });
  }

  it('leaves a scalar timestamp as it was, and a structured one a producer key once generated.at supersedes it', () => {
    const scalar = concept(roundTrip("timestamp: '2026-01-01T00:00:00Z'").first);
    expect(objs(scalar.quads, SCHEMA_DATE_MODIFIED)).toEqual([DT('2026-01-01T00:00:00Z')]);
    expect(objs(scalar.quads, OKF_LEGACY_TIMESTAMP)).toEqual([]);
    const { first } = roundTrip('generated: { by: human:a, at: 2026-06-30T00:00:00Z }\ntimestamp: [a, b]');
    const c = concept(first);
    expect(objs(c.quads, SCHEMA_NS + 'timestamp').sort()).toEqual(['"a"', '"b"']);
    expect(objs(c.quads, OKF_LEGACY_TIMESTAMP)).toEqual([]);
    expect(c.trust.generatedAt).toBe('2026-06-30T00:00:00Z');
    expect(messages(first)).not.toContain(WARNING);
  });
});


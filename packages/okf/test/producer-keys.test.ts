import { describe, it, expect } from 'vitest';
import {
  exportBundle,
  exportInputFromQuads,
  importBundle,
  keptVerbatimPredicate,
  okfExtensionKey,
  parseDocument,
  OKF_GENERATED_AT,
  OKF_LEGACY_TIMESTAMP,
  OKF_NS,
  OKF_PRODUCER_DATE_MODIFIED,
  mapFrontmatter,
  OKF_RESOURCE,
  OKF_SOURCE,
  OKF_STATUS,
  PROV_WAS_DERIVED_FROM,
  RDF_JSON,
  RDF_TYPE,
  SCHEMA_NAME,
  SCHEMA_NS,
  V02_FAMILY_KEYS,
} from '../src/index.js';
import { readsAsProducerKey } from '../src/frontmatter-keys.js';
import { genericQuads } from '../src/terms.js';
import { IRI, bundle, exportedFrontmatter, objs, semantic, shuffled } from './helpers/okf-v02-fixtures.js';
import type { Quad } from '../src/index.js';

// A producer key is kept as `schema:<camelKey>`, so `Sources` lands on the
// predicate `sources` would read back as. Export must write it back under a
// key the importer reads as a producer key, never over the family or base
// field of the same name.
const roundTrip = (yaml: string) => {
  const files = bundle(`type: Metric\n${yaml}`);
  const first = importBundle(files);
  const second = importBundle(exportBundle(first));
  const concept = (r: typeof first) => r.concepts.find((c) => c.conceptId === 'metrics/revenue')!;
  return { files, first: concept(first), second: concept(second) };
};

describe('a producer key never overwrites a family or base field of the same name', () => {
  it('keeps sources and a Sources producer key, with the Source node and its lineage', () => {
    const { files, first, second } = roundTrip('sources: [{ resource: https://example.org/source }]\nSources: producer-value');
    expect(semantic(second.quads)).toBe(semantic(first.quads));
    for (const c of [first, second]) {
      const [node] = objs(c.quads, OKF_SOURCE);
      expect(objs(c.quads, OKF_RESOURCE, node)).toEqual(['https://example.org/source']);
      expect(objs(c.quads, PROV_WAS_DERIVED_FROM)).toEqual(['https://example.org/source']);
      expect(objs(c.quads, SCHEMA_NS + 'sources')).toEqual(['"producer-value"']);
    }
    const fm = exportedFrontmatter(files);
    expect(fm.sources).toEqual([{ resource: 'https://example.org/source' }]);
    expect(fm.Sources).toBe('producer-value');
  });

  it('keeps every other collision: families, base fields and the legacy timestamp', () => {
    for (const yaml of [
      'Status: draft',
      'status: draft\nStatus: x',
      'title: Real\nType: x\nTitle: y\nTags: z\nResource: w',
      "Timestamp: '2026-01-01T00:00:00Z'",
      'Generated: { by: human:h }',
      'Verified: { by: human:a }',
      'sources: nope\nSources: x',
    ]) {
      const { first, second } = roundTrip(yaml);
      expect(semantic(second.quads), yaml).toBe(semantic(first.quads));
    }
    const { second } = roundTrip('status: draft\nStatus: x\ntitle: Real\nTitle: y');
    expect(objs(second.quads, OKF_STATUS)).toEqual(['"draft"']);
    expect(objs(second.quads, SCHEMA_NAME)).toEqual(['"Real"']);
    expect(objs(second.quads, RDF_TYPE)).toEqual(['http://schema.org/Metric']);
  });

  it('writes the legacy timestamp back as itself when a generated.at supersedes it', () => {
    const fm = exportedFrontmatter(bundle("type: Metric\ngenerated: { by: human:a, at: 2026-06-30T00:00:00Z }\ntimestamp: '2026-01-01T00:00:00Z'"));
    expect(fm.timestamp).toBe('2026-01-01T00:00:00Z');
    expect('Timestamp' in fm).toBe(false);
  });
});

describe('a family list kept verbatim survives a producer value on its predicate', () => {
  // `generated: [a]` is one rdf:JSON array on schema:generated, and
  // `Generated: x` a plain value beside it: the array is the family's, the
  // rest is the producer key's, and both come back.
  for (const [family, producer, yaml] of [
    ['generated', 'Generated', 'generated: [a]\nGenerated: x'],
    ['generated', 'Generated', 'generated: []\nGenerated: x'],
    ['executor', 'Executor', 'executor: [/policies/revenue-recognition.md]\nExecutor: x'],
    ['attester', 'Attester', 'attester: [{ resource: https://x.example/a }]\nAttester: x'],
  ]) {
    it(`keeps ${yaml.split('\n')[0]} beside ${producer}: x`, () => {
      const { files, first, second } = roundTrip(yaml);
      expect(semantic(second.quads)).toBe(semantic(first.quads));
      expect(second.warnings).toEqual(first.warnings);
      const fm = exportedFrontmatter(files);
      expect(Array.isArray(fm[family])).toBe(true);
      expect(fm[producer]).toBe('x');
    });
  }
});

describe('a family list kept verbatim survives an empty producer list on its predicate', () => {
  // A producer key's empty list is one `[]` (rdf:JSON) too: the family's
  // non-empty array is still the family's, and both terms come back.
  for (const [family, producer, list] of [
    ['generated', 'Generated', '[a]'],
    ['executor', 'Executor', '[/policies/revenue-recognition.md]'],
    ['attester', 'Attester', '[{ resource: https://x.example/a }]'],
  ]) {
    it(`keeps ${family}: ${list} beside ${producer}: []`, () => {
      const { files, first, second } = roundTrip(`${family}: ${list}\n${producer}: []`);
      expect(semantic(second.quads)).toBe(semantic(first.quads));
      const terms = objs(first.quads, SCHEMA_NS + family);
      expect(terms).toHaveLength(2);
      expect(terms).toContain(`"[]"^^<${RDF_JSON}>`);
      for (const term of terms) expect(objs(second.quads, SCHEMA_NS + family)).toContain(term);
      const fm = exportedFrontmatter(files);
      expect(Array.isArray(fm[family]) && (fm[family] as unknown[]).length).toBe(1);
      expect(fm[producer]).toEqual([]);
    });
  }
});

describe('an empty list is a value, for a producer key too', () => {
  it('keeps owners: [] and the empty item of nested: [a, []] through a round trip', () => {
    const { files, first, second } = roundTrip('owners: []\nnested: [a, []]');
    expect(semantic(second.quads)).toBe(semantic(first.quads));
    expect(objs(first.quads, SCHEMA_NS + 'owners')).toEqual([`"[]"^^<${RDF_JSON}>`]);
    const fm = exportedFrontmatter(files);
    expect(fm.owners).toEqual([]);
    expect(fm.nested).toEqual([[], 'a']);
  });
});

describe('a family value kept verbatim is marked as the family\'s', () => {
  const marker = (family: string) => keptVerbatimPredicate(family);

  it('writes the marker beside the queryable copy, with the same term', () => {
    const { first } = roundTrip('generated: [a]\nGenerated: x');
    const kept = `"[\\"a\\"]"^^<${RDF_JSON}>`;
    expect(objs(first.quads, marker('generated'))).toEqual([kept]);
    expect(objs(first.quads, SCHEMA_NS + 'generated').sort()).toEqual(['"x"', kept].sort());
  });

  it('never reads a marker as a family extension', () => {
    // `okf:<familyKey>.<key>` is an extension, so no marker may start `okf:generated.`.
    const markers = [...[...V02_FAMILY_KEYS].map(marker), OKF_GENERATED_AT, OKF_PRODUCER_DATE_MODIFIED, OKF_LEGACY_TIMESTAMP];
    for (const family of V02_FAMILY_KEYS) {
      for (const m of markers) expect(okfExtensionKey(family, m), m).toBeNull();
    }
    expect(V02_FAMILY_KEYS).not.toContain('keptVerbatim');
  });

  it('brings back what shape inference could not tell apart', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['usage_window: Q2', { usage_window: 'Q2' }],
      ['sources: nope\nSources: x', { sources: 'nope', Sources: 'x' }],
      ['Generated: []', { Generated: [] }],
    ];
    for (const [yaml, expected] of cases) {
      const { files, first, second } = roundTrip(yaml);
      expect(semantic(second.quads), yaml).toBe(semantic(first.quads));
      expect(second.warnings, yaml).toEqual(first.warnings);
      expect(exportedFrontmatter(files), yaml).toMatchObject(expected);
    }
  });

  it('still reads a graph written before values were marked', () => {
    const unmarked = (quads: Quad[]) => quads.filter((q) => !q.predicate.startsWith(OKF_NS + 'keptVerbatim.'));
    for (const yaml of ['generated: [a]\nGenerated: x', 'generated: x', 'sources: nope\nSources: x']) {
      const files = bundle(`type: Metric\n${yaml}`);
      const graph = unmarked(importBundle(files).quads);
      const exported = exportBundle(exportInputFromQuads(graph));
      expect(semantic(unmarked(importBundle(exported).quads)), yaml).toBe(semantic(graph));
    }
    // a non-empty list no producer key yields is still the family's
    const fm = parseDocument('metrics/revenue.md', exportBundle(exportInputFromQuads(unmarked(importBundle(bundle('type: Metric\ngenerated: [a]')).quads))).find((f) => f.path === 'metrics/revenue.md')!.content).frontmatter;
    expect(fm.generated).toEqual(['a']);
  });

  it('exports every collision the same from rows in any order', () => {
    for (const yaml of [
      'sources: [{ resource: https://example.org/source }]\nSources: producer-value',
      'generated: [a]\nGenerated: x',
      'generated: [a]\nGenerated: []',
      'sources: nope\nSources: x',
      'title: Real\nType: x\nTitle: y',
      "generated: [a]\ntimestamp: '2026-01-01T00:00:00Z'\nTimestamp: producer-value",
    ]) {
      const imported = importBundle(bundle(`type: Metric\n${yaml}`));
      const direct = exportBundle(imported);
      for (const seed of [7, 42, 2026]) expect(exportBundle(exportInputFromQuads(shuffled(imported.quads, seed))), yaml).toEqual(direct);
    }
  });
});

describe('the exporter and the importer agree on which keys are producer keys', () => {
  it('lands a value on schema:<camelKey> exactly when readsAsProducerKey says so', () => {
    // A list of mappings: no base field or family maps it the generic way.
    const value = [{ a: 1 }];
    const keys = ['type', 'title', 'description', 'tags', 'resource', 'timestamp', ...V02_FAMILY_KEYS];
    for (const key of [...keys, 'owner', 'Sources', 'Status', 'Generated', 'usageWindow', 'staleAfter', 'isPartOf']) {
      for (const generatedAt of [false, true]) {
        const frontmatter: Record<string, unknown> = {
          type: 'Metric',
          ...(generatedAt ? { generated: { by: 'human:a', at: '2026-06-30T14:00:00Z' } } : {}),
          [key]: value,
        };
        const quads = mapFrontmatter(IRI, frontmatter).quads;
        const generic = genericQuads(IRI, key, value).every((g) => quads.some((q) => q.predicate === g.predicate && q.object === g.object));
        expect(generic, `${key}${generatedAt ? ' with generated.at' : ''}`).toBe(readsAsProducerKey(key, frontmatter));
      }
    }
  });
});

import { describe, it, expect } from 'vitest';
import {
  exportBundle,
  importBundle,
  mapFrontmatter,
  OKF_RESOURCE,
  OKF_SOURCE,
  OKF_STATUS,
  PROV_WAS_DERIVED_FROM,
  RDF_TYPE,
  SCHEMA_NAME,
  SCHEMA_NS,
  V02_FAMILY_KEYS,
} from '../src/index.js';
import { readsAsProducerKey } from '../src/mapping.js';
import { genericQuads } from '../src/terms.js';
import { IRI, bundle, exportedFrontmatter, objs, semantic } from './helpers/okf-v02-fixtures.js';

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

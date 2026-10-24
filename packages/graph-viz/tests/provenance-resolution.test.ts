import { describe, expect, it } from 'vitest';
import { GraphModel } from '../src/core/graph-model.js';
import { MetadataExtractor } from '../src/core/metadata-extractor.js';
import { ProvenanceResolver } from '../src/core/provenance-resolver.js';

const prov = 'http://www.w3.org/ns/prov#';
const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const vocab = 'https://guardiankg.org/vocab/';
const triple = (subject: string, predicate: string, object: string) => ({ subject, predicate, object });

describe('provenance resolution', () => {
  it.each([false, true])('resolves typed derivation sources with metadata routing=%s', metadata => {
    const model = new GraphModel(metadata ? [`${prov}wasDerivedFrom`] : []);
    model.addTriples([
      triple('urn:item', `${prov}wasDerivedFrom`, 'https://example.test/source'),
      triple('urn:item', `${prov}wasDerivedFrom`, 'urn:not-a-source'),
      triple('https://example.test/source', rdfType, `${vocab}DataSource`),
      triple('https://example.test/source', 'http://schema.org/name', 'Source name'),
      triple('urn:not-a-source', rdfType, 'urn:OtherType'),
    ]);
    new ProvenanceResolver().resolve(model);
    expect(model.nodes.get('urn:item')?.provenance).toMatchObject({ sources: ['https://example.test/source'], sourceNames: ['Source name'] });
  });

  it('deduplicates sources across edges, metadata and direct source properties while keeping names aligned', () => {
    const model = new GraphModel();
    model.addTriples([
      triple('urn:item', `${prov}wasDerivedFrom`, 'https://example.test/first'),
      triple('https://example.test/first', rdfType, `${prov}Agent`),
      triple('https://example.test/first', 'http://xmlns.com/foaf/0.1/name', 'First'),
      triple('https://example.test/second', rdfType, `${vocab}DataSource`),
    ]);
    const node = model.nodes.get('urn:item')!;
    node.metadata.set(`${prov}wasDerivedFrom`, [{ value: 'https://example.test/first' }, { value: 'https://example.test/second' }, { value: 'urn:missing' }]);
    node.properties.set(`${vocab}dataSource`, [{ value: 'https://example.test/first' }, { value: 'https://example.test/external' }]);
    node.metadata.set('http://umanitek.ai/dkg/vocab/dataSource', [{ value: 'https://example.test/second' }]);
    new ProvenanceResolver().resolve(model);
    expect(node.provenance?.sources).toEqual(['https://example.test/first', 'https://example.test/second', 'https://example.test/external']);
    expect(node.provenance?.sourceNames).toEqual(['First', 'second', 'external']);
  });

  it('resolves generator identity, timestamp and hash, then clears stale provenance on recomputation', () => {
    const extractor = new MetadataExtractor({ predicates: ['urn:custom'] });
    extractor.addPredicates(['urn:custom', 'urn:another']);
    expect(extractor.isMetadata('urn:another')).toBe(true);
    expect(extractor.isMetadata('urn:ordinary')).toBe(false);
    expect(extractor.predicates.filter(p => p === 'urn:custom')).toEqual(['urn:custom']);
    const model = new GraphModel(extractor.predicates);
    model.addTriples([
      triple('urn:item', `${prov}wasGeneratedBy`, 'https://example.test/generator'),
      triple('urn:item', `${prov}generatedAtTime`, '2026-01-01T00:00:00Z'),
      triple('urn:item', `${vocab}contentHash`, 'hash123'),
      triple('https://example.test/generator', 'https://schema.org/name', 'Generator'),
    ]);
    const resolver = new ProvenanceResolver();
    resolver.resolve(model);
    const node = model.nodes.get('urn:item')!;
    expect(node.provenance).toEqual({ sources: [], sourceNames: [], contentHash: 'hash123',
      generatedAt: '2026-01-01T00:00:00Z', generatedBy: 'https://example.test/generator', generatedByName: 'Generator' });
    node.metadata.clear();
    node.properties.clear();
    resolver.resolve(model);
    expect(node.provenance).toEqual({ sources: [], sourceNames: [], contentHash: undefined, generatedAt: undefined });
  });

  it('uses property fallback and a URI basename when the generating agent is absent', () => {
    const model = new GraphModel();
    model.addTriple(triple('urn:item', 'urn:label', 'item'));
    const node = model.nodes.get('urn:item')!;
    node.properties.set(`${prov}wasGeneratedBy`, [{ value: 'https://example.test/missing-agent' }]);
    node.properties.set(`${prov}generatedAtTime`, [{ value: '2026-01-02T00:00:00Z' }]);
    new ProvenanceResolver().resolve(model);
    expect(node.provenance).toMatchObject({ generatedByName: 'missing-agent', generatedAt: '2026-01-02T00:00:00Z' });
  });
});

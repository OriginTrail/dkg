import { describe, expect, it } from 'vitest';
import { schemaTypeColors } from '../src/ui/views/schema-type-colors.js';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const S = 'http://schema.org/';
const typed = (n: number, t: string) => Array.from({ length: n }, (_, i) => ({ subject: `urn:${t}:${i}`, predicate: RDF, object: S + t }));

describe('schema.org type colours (C8)', () => {
  it('colours the six most common types, busiest first; the rest and Thing are neutral', () => {
    const triples = [...typed(12, 'Person'), ...typed(8, 'Organization'), ...typed(7, 'Place'), ...typed(6, 'Event'),
      ...typed(5, 'CreativeWork'), ...typed(4, 'Product'), ...typed(3, 'Dataset'), ...typed(9, 'Thing')];
    const c = schemaTypeColors(triples, (n) => `slot${n}`, 'grey');
    expect(['Person', 'Organization', 'Place', 'Event', 'CreativeWork', 'Product'].map(t => c[S + t]))
      .toEqual(['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6']);
    expect(c[S + 'Dataset']).toBe('grey');
    expect(c[S + 'Thing']).toBe('grey');
  });
  it('counts distinct subjects and ignores non-schema.org types', () => {
    const triples = [
      { subject: 'urn:a', predicate: RDF, object: S + 'Person' },
      { subject: 'urn:a', predicate: RDF, object: S + 'Person' },
      { subject: 'urn:b', predicate: RDF, object: '<http://dkg.io/ontology/code/File>' },
    ];
    const c = schemaTypeColors(triples, (n) => `slot${n}`, 'grey');
    expect(Object.keys(c)).toEqual([S + 'Person']);
  });
});

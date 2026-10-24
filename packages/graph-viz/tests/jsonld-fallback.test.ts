import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseJsonLd } from '../src/parsers/jsonld.js';
import { parseTripleArray } from '../src/parsers/triples.js';

const converter = vi.hoisted(() => vi.fn());
vi.mock('jsonld', () => ({ default: { toRDF: converter } }));
afterEach(() => { vi.restoreAllMocks(); converter.mockReset(); });

describe('optional JSON-LD converter fallback', () => {
  it('preserves flat graph values, references, datatypes and languages when expansion is unavailable', async () => {
    converter.mockRejectedValue(new Error('optional converter unavailable'));
    const document = { '@graph': [null, false, 4, {
      '@id': 'urn:item', '@type': ['urn:TypeA', 'urn:TypeB'], '@context': { ignored: 'urn:ignored' },
      'urn:reference': { '@id': 'urn:other' },
      'urn:values': ['', 0, false, { '@value': 'bonjour', '@language': 'fr' },
        { '@value': '42', '@type': 'http://www.w3.org/2001/XMLSchema#integer' }, null, { unsupported: true }],
    }] };
    const before = structuredClone(document);
    const triples = await parseJsonLd(document);
    expect(triples).toEqual([
      { subject: 'urn:item', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:TypeA' },
      { subject: 'urn:item', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'urn:TypeB' },
      { subject: 'urn:item', predicate: 'urn:reference', object: 'urn:other' },
      ...['', '0', 'false'].map(object => ({ subject: 'urn:item', predicate: 'urn:values', object })),
      { subject: 'urn:item', predicate: 'urn:values', object: 'bonjour', datatype: undefined, language: 'fr' },
      { subject: 'urn:item', predicate: 'urn:values', object: '42', datatype: 'http://www.w3.org/2001/XMLSchema#integer', language: undefined },
    ]);
    expect(document).toEqual(before);
    expect(converter).toHaveBeenCalledExactlyOnceWith(document, { format: 'application/n-quads' });
  });

  it('assigns separate blank subjects to anonymous nodes and retains scalar types', async () => {
    converter.mockRejectedValue(new Error('optional converter unavailable'));
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.25).mockReturnValueOnce(0.5);
    const triples = await parseJsonLd({ '@graph': [{ '@type': 'urn:Type', 'urn:name': 'first' }, { 'urn:name': 'second' }] });
    expect(triples).toHaveLength(3);
    expect(triples[0].subject).toMatch(/^_:b\w+$/);
    expect(triples[1].subject).toBe(triples[0].subject);
    expect(triples[2].subject).not.toBe(triples[0].subject);
    expect(triples[2]).toMatchObject({ predicate: 'urn:name', object: 'second' });
  });

  it('parses JSON strings but rejects malformed JSON before invoking expansion', async () => {
    converter.mockRejectedValue(new Error('optional converter unavailable'));
    await expect(parseJsonLd('{broken')).rejects.toBeInstanceOf(SyntaxError);
    expect(converter).not.toHaveBeenCalled();
    await expect(parseJsonLd('{"@id":"urn:s","urn:p":"value"}')).resolves.toEqual([
      { subject: 'urn:s', predicate: 'urn:p', object: 'value' },
    ]);
  });
});

describe('raw triple input formats', () => {
  it('normalizes mixed tuple, shorthand and RDF inputs without dropping RDF metadata', () => {
    const rdf = { subject: 'urn:s', predicate: 'urn:language', object: 'hola', language: 'es', graph: 'urn:g' };
    const input = [rdf, { s: 'urn:s', p: 'urn:zero', o: '0' }, ['urn:s', 'urn:empty', ''] as [string, string, string]];
    const before = structuredClone(input);
    expect(parseTripleArray(input)).toEqual([rdf, { subject: 'urn:s', predicate: 'urn:zero', object: '0' },
      { subject: 'urn:s', predicate: 'urn:empty', object: '' }]);
    expect(input).toEqual(before);
    expect(parseTripleArray([])).toEqual([]);
  });
});

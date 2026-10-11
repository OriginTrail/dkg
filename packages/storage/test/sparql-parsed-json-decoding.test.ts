import { describe, expect, it } from 'vitest';
import { decodeSparqlJsonQueryResult, parseSparqlJsonSelectResponse, SparqlJsonResultsShapeError } from '../src/sparql-json-query-result.js';

const response = (term: unknown) => ({ head: { vars: ['value'] }, results: { bindings: [{ value: term }] } });

describe('privately parsed JSON SELECT decoding', () => {
  it('uses its captured JSON parser even if application code replaces the global parser', () => {
    const original = JSON.parse;
    let calls = 0;
    const foreign = { type: 'uri' };
    Object.defineProperty(foreign, 'value', { enumerable: true, get() { calls++; return 'urn:foreign'; } });
    const text = JSON.stringify(response({ type: 'uri', value: 'urn:test:owned' }));
    let result;
    try {
      JSON.parse = () => response(foreign);
      result = decodeSparqlJsonQueryResult(text, 'select');
    } finally { JSON.parse = original; }
    expect(result).toMatchObject({ bindings: [{ value: 'urn:test:owned' }] });
    expect(calls).toBe(0);
  });
  it.each([
    { type: 'uri', value: 'urn:test:value' },
    { type: 'bnode', value: 'node' },
    { type: 'bnode', value: 'x·y.z' },
    // Results labels are response-local, not SPARQL source tokens: `ª` is
    // outside the SPARQL BLANK_NODE_LABEL grammar but a valid results label.
    { type: 'bnode', value: 'ª' },
    { type: 'literal', value: 'quotes " and slash \\ and \n' },
    { type: 'literal', value: 'bonjour', 'xml:lang': 'fr' },
    { type: 'typed-literal', value: '42', datatype: 'urn:test:number' },
    { type: 'literal', value: 'plain', datatype: 'http://www.w3.org/2001/XMLSchema#string' },
  ])('matches the fully reflective decoder for valid terms', term => {
    const input = response(term);
    expect(decodeSparqlJsonQueryResult(JSON.stringify(input), 'select')).toEqual({ type: 'bindings', ...parseSparqlJsonSelectResponse(input) });
  });

  it.each([
    null, [], { type: 'uri' }, { value: 'x' }, { type: 'uri', value: 1 },
    { type: 'uri', value: 'relative' }, { type: 'uri', value: 'urn:x', extra: true },
    { type: 'uri', value: 'urn:bad>' }, { type: 'bnode', value: 'bad.' },
    { type: 'unsupported', value: 'x' }, { type: 'typed-literal', value: '42' },
    { type: 'literal', value: 'x', datatype: 'relative' },
    { type: 'literal', value: 'x', 'xml:lang': 'not valid' },
    { type: 'literal', value: 'x', datatype: 'urn:d', 'xml:lang': 'en' },
  ])('retains the reflective decoder rejection domain for malformed terms', term => {
    const input = response(term);
    expect(() => parseSparqlJsonSelectResponse(input)).toThrow(SparqlJsonResultsShapeError);
    expect(() => decodeSparqlJsonQueryResult(JSON.stringify(input), 'select')).toThrow(SparqlJsonResultsShapeError);
  });

  it('keeps a results label outside the SPARQL grammar usable, and consistent within the response', () => {
    const text = JSON.stringify({
      head: { vars: ['a', 'b'] },
      results: {
        bindings: [
          { a: { type: 'bnode', value: 'ª' }, b: { type: 'bnode', value: 'ª' } },
          { a: { type: 'bnode', value: 'ª' }, b: { type: 'bnode', value: 'node' } },
        ],
      },
    });
    const result = decodeSparqlJsonQueryResult(text, 'select');
    expect(result).toMatchObject({
      type: 'bindings',
      bindings: [{ a: '_:ª', b: '_:ª' }, { a: '_:ª', b: '_:node' }],
    });
  });

  it.each([
    {}, [], null, { head: {}, results: { bindings: [] } },
    { head: { vars: ['v', 'v'] }, results: { bindings: [] } },
    { head: { vars: [1] }, results: { bindings: [] } },
    { head: { vars: ['v'] }, results: { bindings: {} } },
    { head: { vars: ['v'] }, results: { bindings: [null] } },
    { head: { vars: ['v'] }, results: { bindings: [{ extra: { type: 'uri', value: 'urn:x' } }] } },
  ])('retains envelope, row, and variable shape checks', input => {
    expect(() => decodeSparqlJsonQueryResult(JSON.stringify(input), 'select')).toThrow(SparqlJsonResultsShapeError);
  });

  it('decodes a __proto__ variable as an ordinary column on both readers', () => {
    const text = '{"head":{"vars":["__proto__","v"]},"results":{"bindings":'
      + '[{"__proto__":{"type":"uri","value":"urn:test:proto"},"v":{"type":"uri","value":"urn:test:v"}}]}}';
    const reflective = parseSparqlJsonSelectResponse(JSON.parse(text));
    const fast = decodeSparqlJsonQueryResult(text, 'select') as { bindings: Array<Record<string, string>> };
    for (const bindings of [reflective.bindings, fast.bindings]) {
      expect(Object.keys(bindings[0])).toEqual(['__proto__', 'v']);
      expect(bindings[0]['__proto__']).toBe('urn:test:proto');
      expect(bindings[0]['v']).toBe('urn:test:v');
    }
  });

  it('keeps the row prototype invariant whether or not __proto__ is declared', () => {
    const withProto = '{"head":{"vars":["__proto__","v"]},"results":{"bindings":'
      + '[{"__proto__":{"type":"uri","value":"urn:test:proto"},"v":{"type":"uri","value":"urn:test:v"}}]}}';
    const withoutProto = '{"head":{"vars":["v"]},"results":'
      + '{"bindings":[{"v":{"type":"uri","value":"urn:test:v"}}]}}';
    const rowsFor = (text: string) => [
      parseSparqlJsonSelectResponse(JSON.parse(text)).bindings[0],
      (decodeSparqlJsonQueryResult(text, 'select') as { bindings: Array<Record<string, string>> }).bindings[0],
    ];
    // head.vars is endpoint-controlled, so a declared __proto__ column must not
    // change the shape of the rows the decoder hands back to every caller.
    for (const row of [...rowsFor(withProto), ...rowsFor(withoutProto)]) {
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(() => String(row)).not.toThrow();
    }
  });

  it('reports a non-object response as such instead of a missing head field', () => {
    for (const body of ['null', '3', '"text"']) {
      expect(() => decodeSparqlJsonQueryResult(body, 'select'))
        .toThrow('SPARQL JSON response must be an object');
      expect(() => parseSparqlJsonSelectResponse(JSON.parse(body)))
        .toThrow('SPARQL JSON response must be an object');
    }
  });

  it('does not borrow missing fields from Object.prototype', () => {
    let calls = 0;
    let failure: unknown;
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
    Object.defineProperty(Object.prototype, 'value', { configurable: true, get() { calls++; throw new Error('inherited getter'); } });
    try {
      try { decodeSparqlJsonQueryResult('{"head":{"vars":["v"]},"results":{"bindings":[{"v":{"type":"uri"}}]}}', 'select'); }
      catch (error) { failure = error; }
    } finally {
      if (previous) Object.defineProperty(Object.prototype, 'value', previous);
      else delete (Object.prototype as Record<string, unknown>).value;
    }
    expect(failure).toBeInstanceOf(SparqlJsonResultsShapeError);
    expect(calls).toBe(0);
  });

  it('keeps untrusted object entrypoints reflective and accessor-free', () => {
    let calls = 0;
    const term = { type: 'literal' };
    Object.defineProperty(term, 'value', { enumerable: true, get() { calls++; return 'x'; } });
    expect(() => parseSparqlJsonSelectResponse(response(term))).toThrow(SparqlJsonResultsShapeError);
    expect(calls).toBe(0);
  });

  it('keeps sparse/adorned arrays rejected at the untrusted object boundary', () => {
    const sparse = Array(1);
    const adorned = Object.assign([], { extra: true });
    for (const bindings of [sparse, adorned]) {
      expect(() => parseSparqlJsonSelectResponse({ head: { vars: ['v'] }, results: { bindings } })).toThrow(SparqlJsonResultsShapeError);
    }
  });
});

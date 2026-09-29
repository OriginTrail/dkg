import { describe, expect, it } from 'vitest';
import {
  decodeSparqlTsvSelectResult,
  SparqlTsvResultsShapeError,
} from '../src/sparql-tsv-query-result.js';
import { decodeSparqlJsonQueryResult } from '../src/sparql-json-query-result.js';
import { SparqlResultsShapeError } from '../src/sparql-results-shape-error.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#';

describe('SPARQL TSV SELECT decoding', () => {
  it('decodes every supported RDF term shape into the JSON-path contract', () => {
    const result = decodeSparqlTsvSelectResult(
      '\uFEFF?iri\t?blank\t?plain\t?lang\t?typed\t?int\t?decimal\t?double\t?bool\t?missing\r\n'
      + '<urn:test:iri>\t_:b0\t"line\\ntext"\t"bonjour"@fr\t"7"^^<urn:test:type>\t42\t-1.5\t2.0E3\ttrue\t\r\n',
    );

    expect(result.variables).toEqual([
      'iri', 'blank', 'plain', 'lang', 'typed',
      'int', 'decimal', 'double', 'bool', 'missing',
    ]);
    expect(result.bindings).toEqual([{
      iri: 'urn:test:iri',
      blank: '_:b0',
      plain: '"line\\ntext"',
      lang: '"bonjour"@fr',
      typed: '"7"^^<urn:test:type>',
      int: `"42"^^<${XSD}integer>`,
      decimal: `"-1.5"^^<${XSD}decimal>`,
      double: `"2.0E3"^^<${XSD}double>`,
      bool: `"true"^^<${XSD}boolean>`,
    }]);
  });

  it('preserves a __proto__ variable without changing the row prototype', () => {
    const result = decodeSparqlTsvSelectResult('?__proto__\t?v\n<urn:proto>\t<urn:v>\n');
    expect(result.bindings[0]?.['__proto__']).toBe('urn:proto');
    expect(result.bindings[0]?.v).toBe('urn:v');
    expect(Object.getPrototypeOf(result.bindings[0])).toBe(Object.prototype);
  });

  it('accepts and canonicalizes single-quoted Turtle short literals', () => {
    const result = decodeSparqlTsvSelectResult(
      "?plain\t?lang\t?typed\n'plain'\t'bonjour'@fr\t'7'^^<urn:test:type>\n",
    );
    expect(result.bindings).toEqual([{
      plain: '"plain"',
      lang: '"bonjour"@fr',
      typed: '"7"^^<urn:test:type>',
    }]);
  });

  it('normalizes equivalent JSON and TSV rows to the same public shape', () => {
    const tsv = decodeSparqlTsvSelectResult(
      '?iri\t?blank\t?literal\n<urn:test:i>\t_:b0\t\'bonjour\'@fr\n',
    );
    const json = decodeSparqlJsonQueryResult(JSON.stringify({
      head: { vars: ['iri', 'blank', 'literal'] },
      results: { bindings: [{
        iri: { type: 'uri', value: 'urn:test:i' },
        blank: { type: 'bnode', value: 'b0' },
        literal: { type: 'literal', value: 'bonjour', 'xml:lang': 'fr' },
      }] },
    }), 'select');
    expect(tsv).toEqual(json);
  });

  it('supports zero-column result sets without inventing a binding', () => {
    expect(decodeSparqlTsvSelectResult('\n').bindings).toEqual([]);
    expect(decodeSparqlTsvSelectResult('\n\n').bindings).toEqual([{}]);
  });

  it.each([
    ['?v\t?v\n<urn:a>\t<urn:b>\n', 'must not contain duplicates'],
    ['v\n<urn:a>\n', 'must be a variable'],
    ['?a\t?b\n<urn:a>\n', 'has 1 columns; expected 2'],
    ['?v\nnot-an-rdf-term\n', 'is not a valid RDF term'],
  ])('rejects malformed endpoint output', (text, message) => {
    expect(() => decodeSparqlTsvSelectResult(text))
      .toThrow(message);
  });

  it('uses a stable typed error class', () => {
    expect(() => decodeSparqlTsvSelectResult('?v\nbad\n'))
      .toThrow(SparqlTsvResultsShapeError);
    expect(() => decodeSparqlTsvSelectResult('?v\nbad\n'))
      .toThrow(SparqlResultsShapeError);
  });

  it.each([
    '?v\n<relative>\n',
    '?v\n<urn:test:\\q>\n',
    '?v\n"x"^^<relative>\n',
    '?v\n"x"^^<urn:test:\\q>\n',
    '?v\n<urn:test:valid>\n<relative>\n',
  ])('rejects unsafe value and datatype IRIs without cache bypass', (text) => {
    expect(() => decodeSparqlTsvSelectResult(text))
      .toThrow(SparqlTsvResultsShapeError);
  });
});

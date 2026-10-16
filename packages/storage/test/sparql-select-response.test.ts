import { describe, expect, it } from 'vitest';
import {
  decodeSparqlQueryResponse,
  resolveSelectResultFormat,
  sparqlResultsAccept,
} from '../src/sparql-select-response.js';

const JSON_SELECT = JSON.stringify({
  head: { vars: ['s'] },
  results: { bindings: [{ s: { type: 'uri', value: 'urn:test:one' } }] },
});
const TSV_SELECT = '?s\n<urn:test:one>\n';
const JSON_ASK = JSON.stringify({ head: {}, boolean: true });
const JSON_TYPE = 'application/sparql-results+json; charset=utf-8';

describe('resolveSelectResultFormat', () => {
  it('defaults to compact TSV for managed Oxigraph and to JSON for generic endpoints', () => {
    expect(resolveSelectResultFormat(undefined, true)).toBe('tsv');
    expect(resolveSelectResultFormat(undefined, false)).toBe('json');
  });

  it('keeps an explicit choice on either kind of endpoint', () => {
    for (const managedOxigraph of [true, false]) {
      expect(resolveSelectResultFormat('json', managedOxigraph)).toBe('json');
      expect(resolveSelectResultFormat('tsv', managedOxigraph)).toBe('tsv');
    }
  });

  it.each([null, '', 'xml', 'TSV', 1])('rejects %j', (value) => {
    expect(() => resolveSelectResultFormat(value, true)).toThrow('selectResultFormat must be json or tsv');
  });
});

describe('sparqlResultsAccept', () => {
  it('asks for TSV only for a SELECT in TSV format', () => {
    expect(sparqlResultsAccept(false, 'tsv')).toBe('text/tab-separated-values');
    expect(sparqlResultsAccept(true, 'tsv')).toBe('application/sparql-results+json');
    expect(sparqlResultsAccept(false, 'json')).toBe('application/sparql-results+json');
    expect(sparqlResultsAccept(true, 'json')).toBe('application/sparql-results+json');
  });
});

describe('decodeSparqlQueryResponse', () => {
  const asJson = decodeSparqlQueryResponse(JSON_SELECT, JSON_TYPE, { isAsk: false, format: 'json' });

  it('decodes the same SELECT from TSV and from JSON', () => {
    expect(asJson).toMatchObject({ type: 'bindings' });
    for (const contentType of ['text/tab-separated-values', 'text/tab-separated-values; charset=utf-8', 'text/plain', null]) {
      expect(decodeSparqlQueryResponse(TSV_SELECT, contentType, { isAsk: false, format: 'tsv' })).toEqual(asJson);
    }
  });

  it('falls back to JSON when a generic endpoint ignores Accept and answers JSON', () => {
    for (const contentType of [JSON_TYPE, 'Application/SPARQL-Results+JSON']) {
      expect(decodeSparqlQueryResponse(JSON_SELECT, contentType, { isAsk: false, format: 'tsv' })).toEqual(asJson);
    }
  });

  it('decodes JSON when JSON was requested, whatever the response type says', () => {
    for (const contentType of ['text/tab-separated-values', null]) {
      expect(decodeSparqlQueryResponse(JSON_SELECT, contentType, { isAsk: false, format: 'json' })).toEqual(asJson);
    }
  });

  it('decodes an ASK answer as JSON even when the format is TSV', () => {
    expect(decodeSparqlQueryResponse(JSON_ASK, null, { isAsk: true, format: 'tsv' })).toMatchObject({ type: 'boolean', value: true });
  });
});

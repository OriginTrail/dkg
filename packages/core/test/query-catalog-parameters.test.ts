import { describe, expect, it } from 'vitest';
import {
  assertQueryCatalogTemplate,
  normalizeQueryCatalogParameters,
  parseQueryCatalogParameters,
  renderQueryCatalogTemplate,
} from '../src/query-catalog-parameters.js';

const parameters = [{
  name: 'configurationId',
  type: 'string' as const,
  label: 'Configuration ID',
}];

describe('query catalog parameters', () => {
  it('parses parameter metadata and safely renders a SPARQL term', () => {
    const parsed = parseQueryCatalogParameters(JSON.stringify(parameters));
    expect(renderQueryCatalogTemplate(
      'SELECT * WHERE { ?record <urn:configuration> {{configurationId}} }',
      parsed,
      { configurationId: '748387" } UNION { ?s ?p ?o' },
    )).toContain('"748387\\" } UNION { ?s ?p ?o"');
  });

  it('renders integer, number, boolean, and IRI values by declared type', () => {
    const definitions = normalizeQueryCatalogParameters([
      { name: 'count', type: 'integer' },
      { name: 'threshold', type: 'number' },
      { name: 'enabled', type: 'boolean' },
      { name: 'predicate', type: 'iri' },
    ]);
    expect(renderQueryCatalogTemplate(
      'ASK { ?s {{predicate}} ?o . FILTER({{count}} > {{threshold}} && {{enabled}}) }',
      definitions,
      { count: '15', threshold: '2.5', enabled: false, predicate: 'https://example.com/value' },
    )).toBe('ASK { ?s <https://example.com/value> ?o . FILTER(15 > 2.5 && false) }');
  });

  it('rejects missing, unknown, unsafe, and undeclared parameters', () => {
    expect(() => renderQueryCatalogTemplate('ASK { BIND({{configurationId}} AS ?id) }', parameters, {}))
      .toThrow(/Missing required query parameter/);
    expect(() => renderQueryCatalogTemplate(
      'ASK { BIND({{configurationId}} AS ?id) }',
      parameters,
      { configurationId: '748387', typo: 'x' },
    )).toThrow(/Unknown query parameter/);
    expect(() => renderQueryCatalogTemplate(
      'ASK { ?s {{predicate}} ?o }',
      [{ name: 'predicate', type: 'iri' }],
      { predicate: 'https://example.com/> } UNION { ?s ?p ?o' },
    )).toThrow(/safe absolute IRI/);
    expect(() => assertQueryCatalogTemplate(
      'ASK { BIND({{shipmentId}} AS ?id) }',
      parameters,
    )).toThrow(/undeclared query parameter/);
  });
});

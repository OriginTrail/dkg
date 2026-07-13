import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { escapeNQuadsLiteral } from '../src/rdf-literal-escape.js';

describe('RDF binding literal escaping', () => {
  it('escapes every forbidden C0 control and DEL while preserving Unicode', () => {
    expect(escapeNQuadsLiteral(
      'quote:" slash:\\ b:\b t:\t n:\n f:\f r:\r nul:\u0000 vt:\u000B us:\u001F del:\u007F café Δ',
    )).toBe(
      'quote:\\" slash:\\\\ b:\\b t:\\t n:\\n f:\\f r:\\r nul:\\u0000 vt:\\u000B us:\\u001F del:\\u007F café Δ',
    );
  });

  it('returns exact valid N-term bindings after an Oxigraph round trip', async () => {
    const store = new OxigraphStore();
    const lexical = 'line1\nline2\tcontrol:\u0001 del:\u007F café Δ';
    const object = `"${escapeNQuadsLiteral(lexical)}"`;
    await store.insert([{
      subject: 'urn:test:subject',
      predicate: 'http://schema.org/name',
      object,
      graph: 'urn:test:graph',
    }]);

    const result = await store.query(
      'SELECT ?o WHERE { GRAPH <urn:test:graph> { <urn:test:subject> <http://schema.org/name> ?o } }',
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') expect(result.bindings).toEqual([{ o: object }]);
  });
});

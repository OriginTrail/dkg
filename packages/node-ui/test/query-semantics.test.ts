import { describe, expect, it } from 'vitest';
import { normalizeQueryExecutionResponse } from '../src/ui/query-api.js';

describe('the semantics a query was answered with', () => {
  const sparql = 'SELECT ?s WHERE { ?s ?p ?o }';
  const empty = { type: 'bindings', bindings: [] };

  it('keeps the semantics the daemon states', () => {
    for (const semantics of ['merged', 'per-asset'] as const) {
      expect(normalizeQueryExecutionResponse({ result: empty, semantics }, sparql)).toEqual({ result: empty, semantics });
    }
  });

  it('leaves out a missing or unknown value, and still normalizes the result', () => {
    expect(normalizeQueryExecutionResponse({ result: empty }, sparql)).toEqual({ result: empty });
    expect(normalizeQueryExecutionResponse({ result: empty, semantics: 'joined' }, sparql)).toEqual({ result: empty });
    expect(normalizeQueryExecutionResponse({ results: { bindings: [] }, semantics: 'merged' }, 'ASK { ?s ?p ?o }'))
      .toEqual({ result: { type: 'boolean', value: false }, semantics: 'merged' });
    expect(normalizeQueryExecutionResponse(null, 'CONSTRUCT WHERE { ?s ?p ?o }')).toEqual({ result: { type: 'quads', quads: [] } });
  });
});

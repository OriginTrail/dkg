import { describe, expect, it } from 'vitest';
import { parseEntityOperation, parseIndexRequest, parseReadinessRequest, parseSearchRequest } from '../src/entity-search/requests.js';

const spec = { contextGraphId: 'catalog', view: 'verifiable-memory', textPredicates: ['urn:text'] };
const read = { contextGraphId: 'catalog', indexId: 'a'.repeat(64), query: 'ocean' };
describe('normalized entity operation contracts', () => {
  it('preserves defaults and distinct preparation and read deadline ceilings', () => {
    expect(parseIndexRequest(spec)).toMatchObject({ restart: false, types: [], timeoutMs: 30_000 });
    expect(parseReadinessRequest(read)).toMatchObject({ warmup: false, timeoutMs: 2_000 });
    expect(parseReadinessRequest({ ...read, warmup: true })).toMatchObject({ warmup: true, timeoutMs: 30_000 });
    expect(parseSearchRequest({ ...read, limit: null, timeoutMs: null })).toMatchObject({ limit: 5, timeoutMs: 2_000 });
    expect(parseSearchRequest({ ...read, limit: 20, timeoutMs: 5_000 })).toMatchObject({ limit: 20, timeoutMs: 5_000 });
    expect(parseEntityOperation('index', spec).kind).toBe('index');
    expect(parseEntityOperation('readiness', read).kind).toBe('readiness');
    expect(parseEntityOperation('search', read).kind).toBe('search');
  });
  it.each([null, [], 42, 'query', { ...read, indexId: 1 }, { ...read, query: '' }, { ...read, query: 'x'.repeat(6001) },
    { ...read, limit: '5' }, { ...read, limit: 0 }, { ...read, limit: 21 }, { ...read, timeoutMs: 5001 },
    { ...read, timeoutMs: 0 }, { ...read, timeoutMs: 1.5 }, { ...read, warmup: 'true' }, { ...read, restart: null }])(
    'rejects invalid search input before dispatch: %j', input => {
      expect(() => parseSearchRequest(input)).toThrow('ENTITY_INVALID_REQUEST');
    });
  it('keeps readiness preparation explicit and rejects oversized preparation deadlines', () => {
    expect(() => parseReadinessRequest({ ...read, timeoutMs: 5001 })).toThrow('ENTITY_INVALID_REQUEST');
    expect(() => parseReadinessRequest({ ...read, warmup: true, timeoutMs: 30_001 })).toThrow('ENTITY_INVALID_REQUEST');
    expect(() => parseIndexRequest({ ...spec, timeoutMs: 30_001 })).toThrow('ENTITY_INVALID_REQUEST');
  });
});

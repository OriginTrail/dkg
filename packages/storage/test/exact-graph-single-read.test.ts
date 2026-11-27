import { describe, expect, it, vi } from 'vitest';
import { BlazegraphStore, readExactGraph, type QueryOptions, type QueryResult } from '../src/index.js';

const graph = 'urn:test:single-read';
const row = { s: 'urn:s', p: 'urn:p', o: '"value"' };

describe('bounded exact graph verification', () => {
  function fixture(rows: Record<string, string>[], count = rows.length) {
    const store = new BlazegraphStore('http://store.test/query');
    const query = vi.spyOn(store, 'query').mockImplementation(async (sparql): Promise<QueryResult> => {
      if (sparql.includes('COUNT(*)')) return { type: 'bindings', bindings: [{ count: String(count) }] };
      return { type: 'bindings', bindings: rows };
    });
    return { store, query };
  }

  it('verifies a bounded payload then checks the live count without a preflight scan', async () => {
    const { store, query } = fixture([row]);
    await expect(readExactGraph(store, graph, { expectedQuadCount: 1, profile: 'bounded-single-result' }))
      .resolves.toEqual([{ subject: row.s, predicate: row.p, object: row.o, graph }]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![0]).toContain('LIMIT 2');
    expect(query.mock.calls[1]![0]).toContain('COUNT(*)');
  });

  it.each([
    { name: 'missing row', rows: [], expected: 1, actual: 0 },
    { name: 'overflow sentinel', rows: [row, { ...row, s: 'urn:extra' }], expected: 1, actual: 2 },
    { name: 'unexpected row in an empty graph', rows: [row], expected: 0, actual: 1 },
  ])('rejects $name from the bounded response without trusting COUNT', async ({ rows, expected, actual }) => {
    const { store, query } = fixture(rows, expected);
    await expect(readExactGraph(store, graph, { expectedQuadCount: expected, profile: 'bounded-single-result' }))
      .rejects.toMatchObject({ code: 'QUAD_COUNT_MISMATCH', expected, actual });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toContain(`LIMIT ${expected + 1}`);
  });

  it.each([0, 2])('rejects a graph changing to %i rows after the payload query', async actual => {
    const { store, query } = fixture([row], actual);
    await expect(readExactGraph(store, graph, { expectedQuadCount: 1, profile: 'bounded-single-result' }))
      .rejects.toMatchObject({ code: 'QUAD_COUNT_MISMATCH', expected: 1, actual });
    expect(query.mock.calls.map(([sparql]) => sparql.includes('COUNT(*)'))).toEqual([false, true]);
  });

  it('verifies an empty graph with a one-row overflow sentinel and final count', async () => {
    const { store, query } = fixture([]);
    await expect(readExactGraph(store, graph, { expectedQuadCount: 0, profile: 'bounded-single-result' }))
      .resolves.toEqual([]);
    expect(query.mock.calls[0]![0]).toContain('LIMIT 1');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('rejects cancellation while the payload is being read', async () => {
    const { store, query } = fixture([row]);
    const controller = new AbortController();
    query.mockImplementation(async (_sparql: string, options?: QueryOptions) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort(new Error('cancelled verification'));
      return { type: 'bindings', bindings: [row] };
    });
    await expect(readExactGraph(store, graph, { expectedQuadCount: 1, profile: 'bounded-single-result',
      queryOptions: { signal: controller.signal } }))
      .rejects.toThrow('cancelled verification');
    expect(query).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDkgQueryAdapter } from '../src/semantic-runtime-query-adapter.js';

afterEach(() => vi.unstubAllEnvs());

function fixture(result: unknown = { value: true }, entries = ['status']) {
  const rows = entries.map((slug, index) => ({
    q: `urn:dkg:profile:demo:query:${slug}-${index}`,
    scopeGraph: 'did:dkg:context-graph:demo/network',
    catalog: 'urn:dkg:profile:demo:catalog:operations',
    name: slug,
    sparql: 'ASK { ?s ?p ?o }',
    executionView: 'verifiable-memory',
    catalogName: 'Operations',
  }));
  const agent = {
    canReadContextGraph: vi.fn(async () => true),
    query: vi.fn(async (_query: string, options: any) => options.source === 'semantic-runtime-query-catalog'
      ? { bindings: options.view === 'verifiable-memory' ? rows : [] }
      : result),
    store: { query: vi.fn(async () => ({ type: 'bindings', bindings: [] })) },
  };
  return { agent, adapter: createDkgQueryAdapter(agent as any, 'demo', '0xcaller') };
}

describe('semantic runtime saved-query adapter boundaries', () => {
  it.each([null, {}, { selector: '' }, { selector: ' status' }, { selector: 'x'.repeat(513) }])(
    'rejects invalid selectors before query dispatch: %j', (input) => {
      const { adapter, agent } = fixture();
      expect(() => adapter.validateInput(input)).toThrow('INVALID_QUERY_SELECTOR');
      expect(agent.query).not.toHaveBeenCalled();
    },
  );

  it.each([null, [], { 'invalid-key': 'value' }, { limit: 3 }, { q: 'x'.repeat(4097) },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, 'value']))])(
    'rejects invalid or unbounded query parameters: %j', (parameters) => {
      expect(() => fixture().adapter.validateInput({ selector: 'status', parameters }))
        .toThrow('INVALID_QUERY_PARAMETERS');
    },
  );

  it('validates bounded named parameters and pure-read reconciliation', async () => {
    const { adapter } = fixture();
    expect(adapter.validateInput({ selector: 'status' })).toEqual({ selector: 'status', parameters: {} });
    expect(adapter.validateInput({ selector: 'status', parameters: { query_1: 'bounded' } }))
      .toEqual({ selector: 'status', parameters: { query_1: 'bounded' } });
    await expect(adapter.reconcile({} as any)).resolves.toMatchObject({ status: 'not_applied' });
    expect(adapter.couldHaveReachedTarget(new Error('failed'))).toBe(false);
  });

  it('denies graph access before reading either the catalog or query data', async () => {
    const { adapter, agent } = fixture();
    agent.canReadContextGraph.mockResolvedValue(false);
    await expect(adapter.dispatch({} as any, { selector: 'status' }))
      .rejects.toThrow('QUERY_CONTEXT_GRAPH_ACCESS_DENIED');
    expect(agent.query).not.toHaveBeenCalled();
    expect(agent.store.query).not.toHaveBeenCalled();
  });

  it.each([
    [[], 'missing', 'QUERY_CATALOG_ENTRY_NOT_FOUND'],
    [['status', 'status'], 'status', 'QUERY_SELECTOR_AMBIGUOUS'],
  ] as const)('rejects missing or ambiguous catalog entries', async (entries, selector, error) => {
    const { adapter, agent } = fixture(undefined, [...entries]);
    await expect(adapter.dispatch({} as any, { selector })).rejects.toThrow(error);
    expect(agent.query.mock.calls.every(([, options]) => options.source === 'semantic-runtime-query-catalog')).toBe(true);
  });

  it.each([
    { value: false }, { type: 'boolean', value: true },
    { bindings: [] }, { type: 'bindings', bindings: [] },
    { quads: [] }, { type: 'quads', quads: [] },
  ])('returns bounded DKG query result shapes: %j', async (result) => {
    const { adapter } = fixture(result);
    const output = await adapter.dispatch({} as any, { selector: 'urn:dkg:profile:demo:query:status-0' });
    expect(output.status).toBe('succeeded');
    expect(JSON.parse(output.output as string).result).toEqual(result);
    expect(output.evidenceRef).toMatch(/^urn:sr:adapter-output:[a-f0-9]{64}$/);
  });

  it.each([
    [null, 'QUERY_RESULT_INVALID'], [42, 'QUERY_RESULT_INVALID'], [{}, 'QUERY_RESULT_INVALID'],
    [{ type: 'boolean', bindings: [] }, 'QUERY_RESULT_INVALID'],
    [{ bindings: Array(1001).fill({}) }, 'QUERY_RESULT_TOO_LARGE'],
    [{ quads: Array(1001).fill({}) }, 'QUERY_RESULT_TOO_LARGE'],
  ])('rejects invalid or excessive query output', async (result, error) => {
    await expect(fixture(result).adapter.dispatch({} as any, { selector: 'status' }))
      .rejects.toThrow(error as string);
  });

  it('emits paired timing evidence even when graph authorization fails', async () => {
    vi.stubEnv('SEMANTIC_RUNTIME_TRACE_ADAPTER_TIMING', '1');
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { adapter, agent } = fixture();
    agent.canReadContextGraph.mockResolvedValue(false);
    try {
      await expect(adapter.dispatch({ effectId: 'effect-query' } as any, { selector: 'status' })).rejects.toThrow();
      expect(log.mock.calls.map(([line]) => JSON.parse(line.split(' ').slice(1).join(' ')).phase))
        .toEqual(['start', 'finish']);
    } finally { log.mockRestore(); }
  });
});

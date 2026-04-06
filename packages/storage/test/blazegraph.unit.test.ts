/**
 * BlazegraphStore unit tests with mocked fetch (03 §16 — graph isolation via GRAPH IRIs;
 * no live Blazegraph required).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';

describe('BlazegraphStore (mocked HTTP)', () => {
  const baseUrl = 'http://blaze.test/sparql';

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strips trailing slash from endpoint URL', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 200 }));
    const s = new BlazegraphStore(`${baseUrl}/`);
    await s.insert([{ subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"o"', graph: 'http://ex.org/g' }]);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toBe(baseUrl);
  });

  it('insert is a no-op for empty quad list', async () => {
    const s = new BlazegraphStore(baseUrl);
    await s.insert([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('insert POSTs N-Quads with correct content type', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const s = new BlazegraphStore(baseUrl);
    await s.insert([
      {
        subject: 'http://ex.org/s',
        predicate: 'http://ex.org/p',
        object: '"o"',
        graph: 'http://ex.org/g',
      },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe(baseUrl);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('text/x-nquads');
    expect(String(init?.body)).toContain('<http://ex.org/s>');
    expect(String(init?.body)).toContain('<http://ex.org/g>');
  });

  it('insert throws on HTTP error with body snippet', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('bad request', { status: 400, statusText: 'Bad Request' }),
    );
    const s = new BlazegraphStore(baseUrl);
    await expect(
      s.insert([
        { subject: 'http://a', predicate: 'http://b', object: '"c"', graph: 'http://g' },
      ]),
    ).rejects.toThrow(/Blazegraph insert failed \(400\)/);
  });

  it('SELECT query parses JSON bindings (graph isolation query)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          head: { vars: ['name'] },
          results: {
            bindings: [
              {
                name: { type: 'literal', value: 'Alice' },
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const s = new BlazegraphStore(baseUrl);
    const r = await s.query(
      'SELECT ?name WHERE { GRAPH <http://ctx/1> { ?s <http://schema.org/name> ?name } }',
    );
    expect(r.type).toBe('bindings');
    if (r.type === 'bindings') {
      expect(r.bindings).toHaveLength(1);
      expect(r.bindings[0].name).toBe('"Alice"');
    }
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(init?.body)).toMatch(/^query=/);
  });

  it('ASK query returns boolean result', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ boolean: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const s = new BlazegraphStore(baseUrl);
    const r = await s.query('ASK { GRAPH <http://g1> { ?s ?p ?o } }');
    expect(r.type).toBe('boolean');
    if (r.type === 'boolean') expect(r.value).toBe(true);
  });

  it('query throws when SPARQL endpoint returns error', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('syntax error', { status: 500 }),
    );
    const s = new BlazegraphStore(baseUrl);
    await expect(s.query('SELECT * WHERE { ?s ?p ?o }')).rejects.toThrow(/Blazegraph query failed/);
  });

  it('CONSTRUCT returns quads from n-quads body', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        '<http://s> <http://p> "o" <http://g> .\n',
        { status: 200, headers: { 'Content-Type': 'text/x-nquads' } },
      ),
    );
    const s = new BlazegraphStore(baseUrl);
    const r = await s.query('CONSTRUCT WHERE { ?s ?p ?o }');
    expect(r.type).toBe('quads');
    if (r.type === 'quads') {
      expect(r.quads.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('dropGraph sends SPARQL UPDATE', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    await s.dropGraph('http://ex.org/g1');
    expect(globalThis.fetch).toHaveBeenCalled();
    const call = vi.mocked(globalThis.fetch).mock.calls.find((c) =>
      String(c[1]?.body).includes('DROP%20SILENT%20GRAPH'),
    );
    expect(call).toBeDefined();
  });

  it('delete is a no-op for empty quad list', async () => {
    const s = new BlazegraphStore(baseUrl);
    await s.delete([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('delete sends SPARQL UPDATE DELETE DATA', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    await s.delete([
      { subject: 'http://s', predicate: 'http://p', object: '"o"', graph: 'http://g' },
    ]);
    const call = vi.mocked(globalThis.fetch).mock.calls.find((c) =>
      decodeURIComponent(String(c[1]?.body)).includes('DELETE DATA'),
    );
    expect(call).toBeDefined();
  });

  it('sparql update errors surface on delete failure', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('fail', { status: 500 }));
    const s = new BlazegraphStore(baseUrl);
    await expect(
      s.delete([{ subject: 'http://a', predicate: 'http://b', object: '"c"', graph: 'http://g' }]),
    ).rejects.toThrow(/Blazegraph update failed/);
  });

  it('deleteByPattern returns count delta from before/after COUNT', async () => {
    let call = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (body.startsWith('query=')) {
        call++;
        return new Response(
          JSON.stringify({
            head: { vars: ['c'] },
            results: { bindings: [{ c: { type: 'literal', value: call === 1 ? '5' : '2' } }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(null, { status: 200 });
    });
    const s = new BlazegraphStore(baseUrl);
    const removed = await s.deleteByPattern({ graph: 'http://g', subject: 'http://s' });
    expect(removed).toBe(3);
  });

  it('deleteBySubjectPrefix returns count delta', async () => {
    let call = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (body.startsWith('query=')) {
        call++;
        return new Response(
          JSON.stringify({
            head: { vars: ['c'] },
            results: { bindings: [{ c: { type: 'literal', value: call === 1 ? '10' : '4' } }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(null, { status: 200 });
    });
    const s = new BlazegraphStore(baseUrl);
    const removed = await s.deleteBySubjectPrefix('http://graph', 'http://prefix');
    expect(removed).toBe(6);
  });

  it('countQuads without graph uses UNION COUNT pattern', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          head: { vars: ['c'] },
          results: { bindings: [{ c: { type: 'literal', value: '99' } }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const s = new BlazegraphStore(baseUrl);
    const n = await s.countQuads();
    expect(n).toBe(99);
    const body = decodeURIComponent(String(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body));
    expect(body).toContain('UNION');
  });

  it('hasGraph uses ASK scoped to graph IRI', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ boolean: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const s = new BlazegraphStore(baseUrl);
    expect(await s.hasGraph('http://g')).toBe(false);
  });

  it('listGraphs maps binding ?g to IRIs', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          head: { vars: ['g'] },
          results: {
            bindings: [
              { g: { type: 'uri', value: 'http://g1' } },
              { g: { type: 'uri', value: 'http://g2' } },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const s = new BlazegraphStore(baseUrl);
    const graphs = await s.listGraphs();
    expect(graphs).toEqual(['http://g1', 'http://g2']);
  });

  it('CONSTRUCT failure throws Blazegraph construct failed', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('bad', { status: 502 }));
    const s = new BlazegraphStore(baseUrl);
    await expect(s.query('CONSTRUCT WHERE { ?s ?p ?o }')).rejects.toThrow(/Blazegraph construct failed/);
  });

  it('createGraph and close are no-ops', async () => {
    const s = new BlazegraphStore(baseUrl);
    await expect(s.createGraph('http://any')).resolves.toBeUndefined();
    await expect(s.close()).resolves.toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

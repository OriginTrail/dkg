import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteSparqlSource } from '../src/data-sources/remote-sparql-source.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('remote SPARQL response boundaries', () => {
  it.each([
    { literal: '""', datatype: undefined, language: undefined },
    { literal: '""^^<http://www.w3.org/2001/XMLSchema#string>', datatype: 'http://www.w3.org/2001/XMLSchema#string', language: undefined },
    { literal: '""@en', datatype: undefined, language: 'en' },
  ])('preserves empty literal $literal and its metadata in CONSTRUCT results', async ({ literal, datatype, language }) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`<urn:s> <urn:p> ${literal} .`)));
    const source = new RemoteSparqlSource({ endpoint: 'http://endpoint.test/sparql' });
    const result = await source.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');
    expect(result.triples).toEqual([{ subject: 'urn:s', predicate: 'urn:p', object: '', datatype, language }]);
  });

  it('maps only declared and bound SELECT variables and resolves the namespace URL', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ head: { vars: ['s', 'optional'] }, results: {
      bindings: [{ s: { type: 'uri', value: 'urn:s' }, ignored: { value: 'private' } }, { optional: { type: 'literal', value: '' } }],
    } })));
    vi.stubGlobal('fetch', fetcher);
    const source = new RemoteSparqlSource({ endpoint: 'http://endpoint.test/', namespace: 'kb' });
    await expect(source.select('SELECT ?s ?optional WHERE {}')).resolves.toEqual({ variables: ['s', 'optional'], bindings: [{ s: 'urn:s' }, { optional: '' }] });
    expect(fetcher.mock.calls[0][0]).toBe('http://endpoint.test/namespace/kb/sparql');
    expect(source.name).toBe('SPARQL: http://endpoint.test/namespace/kb/sparql');
  });

  it.each([{}, { head: { vars: ['s'] } }])('handles an empty result envelope (%j)', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    const source = new RemoteSparqlSource({ endpoint: 'http://endpoint.test' });
    const result = await source.select('SELECT ?s WHERE {}');
    expect(result.bindings).toEqual([]);
    await expect(source.tripleCount()).resolves.toBe(0);
  });

  it('returns the numeric count rather than the wire-format literal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"head":{"vars":["count"]},"results":{"bindings":[{"count":{"value":"42"}}]}}')));
    await expect(new RemoteSparqlSource({ endpoint: 'http://endpoint.test' }).tripleCount()).resolves.toBe(42);
  });

  it('aborts a stalled request at the configured deadline and releases the timer', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const source = new RemoteSparqlSource({ endpoint: 'http://endpoint.test', timeoutMs: 25 });
    const rejection = expect(source.select('SELECT * WHERE {}')).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('clears its request timer after HTTP success=%s', async success => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: success ? 200 : 503, statusText: success ? 'OK' : 'Unavailable' })));
    const request = new RemoteSparqlSource({ endpoint: 'http://endpoint.test' }).select('SELECT * WHERE {}');
    if (success) await expect(request).resolves.toEqual({ variables: [], bindings: [] });
    else await expect(request).rejects.toThrow('SPARQL query failed: 503 Unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps remote sources read-only', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await new RemoteSparqlSource({ endpoint: 'http://endpoint.test' }).loadNTriples('<urn:s> <urn:p> <urn:o> .');
    expect(fetcher).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('read-only'));
  });
});

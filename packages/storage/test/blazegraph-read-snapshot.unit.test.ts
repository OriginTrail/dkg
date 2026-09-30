/** Read-only Blazegraph snapshot lifecycle with mocked HTTP. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';

const baseUrl = 'http://blaze.test/sparql';
let fetchCalls: [input: string | URL | Request, init?: RequestInit][];
let originalFetch: typeof globalThis.fetch;

function setFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push([input, init]);
    return handler(input, init);
  }) as typeof fetch;
}

function blazeSelectResponse(): Response {
  return new Response(JSON.stringify({
    head: { vars: ['name'] },
    results: { bindings: [{ name: { type: 'literal', value: 'Alice' } }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function blazeListGraphsResponse(): Response {
  return new Response(JSON.stringify({
    head: { vars: ['g'] },
    results: { bindings: [{ g: { type: 'uri', value: 'http://g1' } }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('Blazegraph read snapshot lifecycle (mocked HTTP)', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
    setFetch(async () => new Response(null, { status: 200 }));
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('pins related reads to one read-only transaction and releases it', async () => {
    setFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/tx?timestamp=-1')) {
        return new Response('<xml><tx txId="12345" readOnly="true"/></xml>', { status: 201 });
      }
      if (url.endsWith('/tx/12345?ABORT')) return new Response(null, { status: 200 });
      return String(fetchCalls.at(-1)?.[1]?.body).includes('SELECT DISTINCT ?g')
        ? blazeListGraphsResponse() : blazeSelectResponse();
    });
    const store = new BlazegraphStore(baseUrl);
    await store.withReadSnapshot(async (snapshot) => {
      await Promise.all([
        snapshot.query('SELECT ?name WHERE { ?name ?p ?o }'),
        snapshot.query('SELECT ?name WHERE { ?name ?p ?o }'),
      ]);
      expect(await snapshot.listGraphs()).toEqual(['http://g1']);
      expect(await snapshot.listGraphsByPrefix?.('http://g')).toEqual(['http://g1']);
    });
    const urls = fetchCalls.map(([input]) => String(input));
    expect(urls[0]).toBe('http://blaze.test/tx?timestamp=-1');
    expect(urls.filter((url) => url === `${baseUrl}?timestamp=12345`)).toHaveLength(4);
    expect(fetchCalls.filter(([, init]) => String(init?.body).includes('SELECT DISTINCT ?g')))
      .toHaveLength(2);
    expect(urls.at(-1)).toBe('http://blaze.test/tx/12345?ABORT');
  });

  it('sends snapshot-bound CONSTRUCT through the pinned HTTP endpoint', async () => {
    setFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/tx?timestamp=-1')) {
        return new Response('<tx txId="12346" readOnly="true"/>', { status: 201 });
      }
      return new Response(null, { status: 200 });
    });
    const store = new BlazegraphStore(baseUrl);
    const result = await store.withReadSnapshot((snapshot) =>
      snapshot.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }'));
    expect(result).toMatchObject({ type: 'quads', quads: [] });
    const urls = fetchCalls.map(([input]) => String(input));
    expect(urls).toContain(`${baseUrl}?timestamp=12346`);
    expect(urls.at(-1)).toBe('http://blaze.test/tx/12346?ABORT');
  });

  it('releases a read-only transaction after a query failure', async () => {
    setFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/tx?timestamp=-1')) {
        return new Response('<xml><tx txId="22" readOnly="true"/></xml>', { status: 201 });
      }
      if (url.endsWith('/tx/22?ABORT')) return new Response(null, { status: 200 });
      return new Response('query failed', { status: 500 });
    });
    const store = new BlazegraphStore(baseUrl);
    await expect(store.withReadSnapshot((snapshot) =>
      snapshot.query('SELECT ?name WHERE { ?name ?p ?o }'),
    )).rejects.toThrow('Blazegraph query failed');
    expect(String(fetchCalls.at(-1)?.[0])).toBe('http://blaze.test/tx/22?ABORT');
  });

  it('releases a created transaction when its begin response body fails', async () => {
    setFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/tx?timestamp=-1')) {
        return new Response(new ReadableStream({
          start(controller) { controller.error(new Error('begin body unavailable')); },
        }), { status: 201, headers: { Location: 'http://blaze.test/tx/123' } });
      }
      if (url.endsWith('/tx/123?ABORT')) return new Response(null, { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const store = new BlazegraphStore(baseUrl);
    await expect(store.withReadSnapshot(async () => undefined))
      .rejects.toThrow('begin body unavailable');
    expect(String(fetchCalls.at(-1)?.[0])).toBe('http://blaze.test/tx/123?ABORT');
  });

  it('cancels snapshot creation through the caller signal', async () => {
    const controller = new AbortController();
    let beginSignal: AbortSignal | undefined;
    setFetch(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      beginSignal = init?.signal as AbortSignal;
      beginSignal.addEventListener('abort', () => reject(beginSignal?.reason), { once: true });
    }));
    const store = new BlazegraphStore(baseUrl);
    const read = vi.fn(async () => undefined);
    const pending = store.withReadSnapshot(read, controller.signal);
    await vi.waitFor(() => expect(beginSignal).toBeDefined());
    controller.abort(new Error('caller cancelled begin'));
    await expect(pending).rejects.toThrow('caller cancelled begin');
    expect(beginSignal?.aborted).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(1);
  });

  it('releases a created transaction when cancellation interrupts its begin body', async () => {
    const controller = new AbortController();
    let beginSignal: AbortSignal | undefined;
    setFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/tx?timestamp=-1')) {
        beginSignal = init?.signal as AbortSignal;
        return new Response(new ReadableStream({
          start(stream) {
            beginSignal?.addEventListener('abort', () => {
              stream.error(beginSignal?.reason);
            }, { once: true });
          },
        }), { status: 201, headers: { Location: 'http://blaze.test/tx/127' } });
      }
      if (url.endsWith('/tx/127?ABORT')) return new Response(null, { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const store = new BlazegraphStore(baseUrl);
    const read = vi.fn(async () => undefined);
    const pending = store.withReadSnapshot(read, controller.signal);
    await vi.waitFor(() => expect(beginSignal).toBeDefined());
    controller.abort(new Error('caller cancelled body'));
    await expect(pending).rejects.toThrow('caller cancelled body');
    expect(read).not.toHaveBeenCalled();
    expect(String(fetchCalls.at(-1)?.[0])).toBe('http://blaze.test/tx/127?ABORT');
  });

  it('releases a created transaction after a malformed begin response', async () => {
    setFetch(async (input) => String(input).endsWith('/tx?timestamp=-1')
      ? new Response('<tx readOnly="false"/>', {
        status: 201, headers: { Location: 'http://blaze.test/tx/124' },
      })
      : new Response(null, { status: 200 }));
    const store = new BlazegraphStore(baseUrl);
    await expect(store.withReadSnapshot(async () => undefined))
      .rejects.toThrow('read-only snapshot');
    expect(String(fetchCalls.at(-1)?.[0])).toBe('http://blaze.test/tx/124?ABORT');
  });

  it('reports release failures after a successful snapshot read', async () => {
    setFetch(async (input) => String(input).endsWith('/tx?timestamp=-1')
      ? new Response('<tx txId="125" readOnly="true"/>', { status: 201 })
      : new Response(null, { status: 503 }));
    const store = new BlazegraphStore(baseUrl);
    await expect(store.withReadSnapshot(async () => 'read result'))
      .rejects.toThrow('release failed (503)');
  });

  it('preserves the read failure when release and diagnostic logging also fail', async () => {
    setFetch(async (input) => String(input).endsWith('/tx?timestamp=-1')
      ? new Response('<tx txId="126" readOnly="true"/>', { status: 201 })
      : new Response(null, { status: 503 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('logger failed');
    });
    try {
      const store = new BlazegraphStore(baseUrl);
      await expect(store.withReadSnapshot(async () => {
        throw new Error('read failed');
      })).rejects.toThrow('read failed');
      expect(String(fetchCalls.at(-1)?.[0])).toBe('http://blaze.test/tx/126?ABORT');
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

});

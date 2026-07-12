/**
 * BlazegraphStore unit tests with mocked fetch (03 §16 — graph isolation via GRAPH IRIs;
 * no live Blazegraph required).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { getExternalStorePrioritySchedulerSnapshot } from '../src/store-priority-scheduler.js';

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function blazeSelectResponse(): Response {
  return new Response(
    JSON.stringify({
      head: { vars: ['name'] },
      results: { bindings: [{ name: { type: 'literal', value: 'Alice' } }] },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function blazeListGraphsResponse(): Response {
  return new Response(
    JSON.stringify({
      head: { vars: ['g'] },
      results: { bindings: [{ g: { type: 'uri', value: 'http://g1' } }] },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('BlazegraphStore (mocked HTTP)', () => {
  const baseUrl = 'http://blaze.test/sparql';

  let fetchCalls: [input: string | URL | Request, init?: RequestInit][];
  let originalFetch: typeof globalThis.fetch;

  function setFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
    globalThis.fetch = (async (input: any, init?: any) => {
      fetchCalls.push([input, init]);
      return handler(input, init);
    }) as typeof fetch;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
    setFetch(async () => new Response(null, { status: 200 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('strips trailing slash from endpoint URL', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(`${baseUrl}/`);
    await s.insert([{ subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"o"', graph: 'http://ex.org/g' }]);
    expect(fetchCalls[0][0]).toBe(baseUrl);
  });

  it('insert is a no-op for empty quad list', async () => {
    const s = new BlazegraphStore(baseUrl);
    await s.insert([]);
    expect(fetchCalls).toHaveLength(0);
  });

  it('insert POSTs N-Quads with correct content type', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    await s.insert([
      {
        subject: 'http://ex.org/s',
        predicate: 'http://ex.org/p',
        object: '"o"',
        graph: 'http://ex.org/g',
      },
    ]);
    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0];
    expect(url).toBe(baseUrl);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('text/x-nquads');
    expect(String(init?.body)).toContain('<http://ex.org/s>');
    expect(String(init?.body)).toContain('<http://ex.org/g>');
  });

  // ── ASCII-safe insert body (devnet pr1386-term-canon astral regression) ──
  // Blazegraph's N-Quads parser reads the body byte-wise as ASCII (charset
  // ignored) and truncates \UXXXXXXXX escapes to their low 16 bits, so the
  // adapter must ship a pure-ASCII body using \uXXXX per UTF-16 code unit
  // (astral chars as their surrogate pair). Wire-format proof lives here; the
  // live round-trip proof is in blazegraph.integration.test.ts.
  it('insert body is pure ASCII: raw astral/BMP chars become UTF-16 \\uXXXX escapes', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    await s.insert([
      // 😀 U+1F600 (surrogate pair D83D DE00), é U+00E9, 𠜎 U+2070E (pair D841 DF0E)
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"café \u{1F600}\u{2070E}"', graph: 'http://ex.org/g' },
    ]);
    const body = String(fetchCalls[0][1]?.body);
    // eslint-disable-next-line no-control-regex
    expect(body).toMatch(/^[\x00-\x7F]*$/); // nothing non-ASCII on the wire
    expect(body).toContain('"caf\\u00E9 \\uD83D\\uDE00\\uD841\\uDF0E"');
  });

  it('insert rewrites in-range \\UXXXXXXXX escapes (Blazegraph truncates them) to surrogate-pair \\uXXXX', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    await s.insert([
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"esc\\U0001F600ape"', graph: 'http://ex.org/g' },
      // BMP big-U form also folds to the single-code-unit escape.
      { subject: 'http://ex.org/s2', predicate: 'http://ex.org/p', object: '"bmp\\U000000E9"', graph: 'http://ex.org/g' },
    ]);
    const body = String(fetchCalls[0][1]?.body);
    expect(body).toContain('"esc\\uD83D\\uDE00ape"');
    expect(body).toContain('"bmp\\u00E9"');
    expect(body).not.toContain('\\U0001F600');
  });

  it('insert leaves literal-backslash \\\\U sequences and out-of-range \\U escapes untouched', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    await s.insert([
      // "\\U0001F600" in the term = ESCAPED backslash + text, NOT a \U escape.
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"lit\\\\U0001F600"', graph: 'http://ex.org/g' },
      // \UFFFFFFFF > U+10FFFF is unrepresentable — must pass through unmangled.
      { subject: 'http://ex.org/s2', predicate: 'http://ex.org/p', object: '"bad\\UFFFFFFFFx"', graph: 'http://ex.org/g' },
    ]);
    const body = String(fetchCalls[0][1]?.body);
    expect(body).toContain('"lit\\\\U0001F600"');
    expect(body).toContain('"bad\\UFFFFFFFFx"');
  });

  it('insert escapes non-ASCII in IRIs too (UCHAR is valid in IRIREF)', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    await s.insert([
      { subject: 'http://ex.org/café', predicate: 'http://ex.org/p', object: '"o"', graph: 'http://ex.org/g' },
    ]);
    const body = String(fetchCalls[0][1]?.body);
    // eslint-disable-next-line no-control-regex
    expect(body).toMatch(/^[\x00-\x7F]*$/);
    expect(body).toContain('<http://ex.org/caf\\u00E9>');
  });

  it('insert throws on HTTP error with body snippet', async () => {
    setFetch(async () => new Response('bad request', { status: 400, statusText: 'Bad Request' }));
    const s = new BlazegraphStore(baseUrl);
    await expect(
      s.insert([
        { subject: 'http://a', predicate: 'http://b', object: '"c"', graph: 'http://g' },
      ]),
    ).rejects.toThrow(/Blazegraph insert failed \(400\)/);
  });

  it('SELECT query parses JSON bindings (graph isolation query)', async () => {
    setFetch(async () => new Response(
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
    ));
    const s = new BlazegraphStore(baseUrl);
    const r = await s.query(
      'SELECT ?name WHERE { GRAPH <http://ctx/1> { ?s <http://schema.org/name> ?name } }',
    );
    expect(r.type).toBe('bindings');
    if (r.type === 'bindings') {
      expect(r.bindings).toHaveLength(1);
      expect(r.bindings[0].name).toBe('"Alice"');
    }
    const [, init] = fetchCalls[0];
    // Direct POST: raw query as the request body with application/sparql-query,
    // NOT URL-encoded form data (which would hit Jetty's maxFormContentSize cap).
    // charset=utf-8 is required — without it Jetty decodes the body ISO-8859-1
    // and non-ASCII literals in patterns never match.
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/sparql-query; charset=utf-8');
    expect(String(init?.body)).toMatch(/^SELECT /);
    expect(String(init?.body)).not.toMatch(/^query=/);
  });

  it('CONSTRUCT query carries charset=utf-8 on the request Content-Type', async () => {
    // Regression guard for the separate queryConstruct/DESCRIBE request path:
    // same ISO-8859-1 default-decode hazard as SELECT — without charset=utf-8
    // Jetty mojibakes any non-ASCII literal in the CONSTRUCT pattern/FILTER.
    setFetch(async () => new Response(
      '<http://ex.org/s> <http://schema.org/name> "caf\\u00E9" <http://ctx/1> .\n',
      { status: 200, headers: { 'Content-Type': 'text/x-nquads' } },
    ));
    const s = new BlazegraphStore(baseUrl);
    const r = await s.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <http://ctx/1> { ?s ?p ?o } }');
    expect(r.type).toBe('quads');
    const [, init] = fetchCalls[0];
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/sparql-query; charset=utf-8');
    expect(String(init?.body)).toMatch(/^CONSTRUCT /);
  });

  it('routes ack-priority adapter queries ahead of queued background fetch work', async () => {
    const before = getExternalStorePrioritySchedulerSnapshot();
    expect(before.maxConcurrent).toBeGreaterThan(1);
    expect(before.ackReservedSlots).toBeGreaterThan(0);
    const backgroundSlots = before.maxConcurrent - before.ackReservedSlots;
    const arrivals: Array<'listGraphs' | 'ack' | 'other'> = [];
    const releaseHeldListGraphs: Array<() => void> = [];
    const backgroundWork: Array<Promise<unknown>> = [];
    let listGraphRequests = 0;
    let queuedBackground: Promise<unknown> | undefined;
    let ackQuery: Promise<unknown> | undefined;

    setFetch(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (body.includes('ack-priority-probe')) {
        arrivals.push('ack');
        return blazeSelectResponse();
      }
      if (body.includes('DISTINCT') && body.includes('?g')) {
        arrivals.push('listGraphs');
        listGraphRequests++;
        if (listGraphRequests <= backgroundSlots) {
          return new Promise<Response>((resolve) => {
            releaseHeldListGraphs.push(() => resolve(blazeListGraphsResponse()));
          });
        }
        return blazeListGraphsResponse();
      }
      arrivals.push('other');
      return blazeSelectResponse();
    });

    try {
      const s = new BlazegraphStore(baseUrl);
      for (let i = 0; i < backgroundSlots; i++) {
        backgroundWork.push(s.listGraphs({
          priority: 'background',
          source: `test.background.${i}`,
        }));
      }
      await waitForCondition(
        () => arrivals.filter((kind) => kind === 'listGraphs').length === backgroundSlots,
        `background listGraphs requests did not fill non-ACK lanes; arrivals=${arrivals.join(',')}`,
      );
      const saturated = getExternalStorePrioritySchedulerSnapshot();
      expect(saturated.backgroundInflight - before.backgroundInflight).toBe(backgroundSlots);

      queuedBackground = s.listGraphs({
        priority: 'background',
        source: 'test.background.queued',
      });
      const queued = getExternalStorePrioritySchedulerSnapshot();
      expect(queued.backgroundQueued - before.backgroundQueued).toBe(1);

      ackQuery = s.query(
        'SELECT ?name WHERE { # ack-priority-probe\n?s ?p ?o }',
        { priority: 'ack', source: 'test.ack' },
      );
      await waitForCondition(
        () => arrivals.includes('ack'),
        `ACK query did not reach fetch before queued background work; arrivals=${arrivals.join(',')}`,
      );

      expect(arrivals.slice(0, backgroundSlots)).toEqual(Array(backgroundSlots).fill('listGraphs'));
      expect(arrivals[backgroundSlots]).toBe('ack');
      expect(arrivals.filter((kind) => kind === 'listGraphs')).toHaveLength(backgroundSlots);
      await ackQuery;
    } finally {
      for (const release of releaseHeldListGraphs.splice(0)) release();
      await Promise.allSettled([
        ...backgroundWork,
        ...(queuedBackground ? [queuedBackground] : []),
        ...(ackQuery ? [ackQuery] : []),
      ]);
    }
  });

  it('ASK query returns boolean result', async () => {
    setFetch(async () => new Response(JSON.stringify({ boolean: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const s = new BlazegraphStore(baseUrl);
    const r = await s.query('ASK { GRAPH <http://g1> { ?s ?p ?o } }');
    expect(r.type).toBe('boolean');
    if (r.type === 'boolean') expect(r.value).toBe(true);
  });

  it('query throws when SPARQL endpoint returns error', async () => {
    setFetch(async () => new Response('syntax error', { status: 500 }));
    const s = new BlazegraphStore(baseUrl);
    await expect(s.query('SELECT * WHERE { ?s ?p ?o }')).rejects.toThrow(/Blazegraph query failed/);
  });

  it('CONSTRUCT returns quads from n-quads body', async () => {
    setFetch(async () => new Response(
      '<http://s> <http://p> "o" <http://g> .\n',
      { status: 200, headers: { 'Content-Type': 'text/x-nquads' } },
    ));
    const s = new BlazegraphStore(baseUrl);
    const r = await s.query('CONSTRUCT WHERE { ?s ?p ?o }');
    expect(r.type).toBe('quads');
    if (r.type === 'quads') {
      expect(r.quads.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('dropGraph sends SPARQL UPDATE', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    await s.dropGraph('http://ex.org/g1');
    expect(fetchCalls.length).toBeGreaterThan(0);
    // Direct POST: raw update body with application/sparql-update (not form-encoded).
    const call = fetchCalls.find((c) =>
      String(c[1]?.body).includes('DROP SILENT GRAPH'),
    );
    expect(call).toBeDefined();
    expect((call?.[1]?.headers as Record<string, string>)['Content-Type']).toBe('application/sparql-update; charset=utf-8');
  });

  it('update POSTs raw SPARQL to the endpoint with application/sparql-update and no COUNT scans', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    const sparql = 'DELETE { GRAPH <http://ex.org/g> { ?s ?p ?o } } WHERE { GRAPH <http://ex.org/g> { ?s ?p ?o } }';
    const controller = new AbortController();
    await s.update(sparql, {
      priority: 'ack',
      source: 'test.blazegraph.update',
      signal: controller.signal,
    });
    // Exactly one HTTP call — the count-free contract: no before/after countQuads
    // (which would add SELECT COUNT round-trips, as deleteByPattern/prefix do).
    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0];
    expect(url).toBe(baseUrl);
    expect(init?.method).toBe('POST');
    // Direct POST: raw update body with application/sparql-update (not form-encoded).
    // charset=utf-8 keeps Jetty from ISO-8859-1-decoding non-ASCII literals.
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/sparql-update; charset=utf-8');
    expect(String(init?.body)).toBe(sparql);
    expect(init?.signal).toBe(controller.signal);
    expect(fetchCalls.some((c) => /\bCOUNT\b/i.test(String(c[1]?.body ?? '')))).toBe(false);
    expect(fetchCalls.some((c) => String(c[1]?.body ?? '').startsWith('SELECT'))).toBe(false);
  });

  it('update honors pre-aborted options before dispatch', async () => {
    const s = new BlazegraphStore(baseUrl);
    const controller = new AbortController();
    controller.abort(new Error('cancel update'));

    await expect(
      s.update('DELETE WHERE { GRAPH <http://ex.org/g> { ?s ?p ?o } }', {
        priority: 'ack',
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancel update');
    expect(fetchCalls).toHaveLength(0);
  });

  it('update throws on non-OK response', async () => {
    setFetch(async () => new Response('boom', { status: 500 }));
    const s = new BlazegraphStore(baseUrl);
    await expect(
      s.update('DELETE WHERE { GRAPH <http://ex.org/g> { ?s ?p ?o } }'),
    ).rejects.toThrow(/Blazegraph update failed \(500\)/);
  });

  it('delete is a no-op for empty quad list', async () => {
    const s = new BlazegraphStore(baseUrl);
    await s.delete([]);
    expect(fetchCalls).toHaveLength(0);
  });

  it('delete sends SPARQL UPDATE DELETE DATA', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    await s.delete([
      { subject: 'http://s', predicate: 'http://p', object: '"o"', graph: 'http://g' },
    ]);
    const call = fetchCalls.find((c) =>
      String(c[1]?.body).includes('DELETE DATA'),
    );
    expect(call).toBeDefined();
  });

  it('sparql update errors surface on delete failure', async () => {
    setFetch(async () => new Response('fail', { status: 500 }));
    const s = new BlazegraphStore(baseUrl);
    await expect(
      s.delete([{ subject: 'http://a', predicate: 'http://b', object: '"c"', graph: 'http://g' }]),
    ).rejects.toThrow(/Blazegraph update failed/);
  });

  it('deleteByPattern returns count delta from before/after COUNT', async () => {
    let call = 0;
    setFetch(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (body.startsWith('SELECT')) {
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

  it('deleteByPattern count branch keyed on direct-POST SELECT body', async () => {
    // Guards the direct-POST migration: count queries are sent as a raw
    // SPARQL body starting with SELECT, not as `query=...` form data.
    let sawRawSelect = false;
    setFetch(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (body.startsWith('SELECT')) {
        sawRawSelect = true;
        return new Response(
          JSON.stringify({ head: { vars: ['c'] }, results: { bindings: [{ c: { type: 'literal', value: '1' } }] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(null, { status: 200 });
    });
    const s = new BlazegraphStore(baseUrl);
    await s.deleteByPattern({ graph: 'http://g', subject: 'http://s' });
    expect(sawRawSelect).toBe(true);
  });

  it('deleteBySubjectPrefix returns count delta', async () => {
    let call = 0;
    setFetch(async (_url, init) => {
      const body = String(init?.body ?? '');
      if (body.startsWith('SELECT')) {
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
    setFetch(async () => new Response(
      JSON.stringify({
        head: { vars: ['c'] },
        results: { bindings: [{ c: { type: 'literal', value: '99' } }] },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const s = new BlazegraphStore(baseUrl);
    const n = await s.countQuads();
    expect(n).toBe(99);
    const body = String(fetchCalls[0][1]?.body);
    expect(body).toContain('UNION');
  });

  it('hasGraph uses ASK scoped to graph IRI', async () => {
    setFetch(async () => new Response(JSON.stringify({ boolean: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const s = new BlazegraphStore(baseUrl);
    expect(await s.hasGraph('http://g')).toBe(false);
  });

  it('listGraphs maps binding ?g to IRIs', async () => {
    setFetch(async () => new Response(
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
    ));
    const s = new BlazegraphStore(baseUrl);
    const graphs = await s.listGraphs();
    expect(graphs).toEqual(['http://g1', 'http://g2']);
  });

  it('CONSTRUCT failure throws Blazegraph construct failed', async () => {
    setFetch(async () => new Response('bad', { status: 502 }));
    const s = new BlazegraphStore(baseUrl);
    await expect(s.query('CONSTRUCT WHERE { ?s ?p ?o }')).rejects.toThrow(/Blazegraph construct failed/);
  });

  it('createGraph and close are no-ops', async () => {
    const s = new BlazegraphStore(baseUrl);
    await expect(s.createGraph('http://any')).resolves.toBeUndefined();
    await expect(s.close()).resolves.toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });

  it('insert throws when a literal exceeds MUTF-8 65535 limit', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    // 70 000 ASCII chars = 70 000 MUTF-8 bytes, exceeds 65 535
    const oversized = '"' + 'x'.repeat(70_000) + '"';
    await expect(s.insert([
      { subject: 'http://s1', predicate: 'http://p', object: '"small"', graph: 'http://g' },
      { subject: 'http://s2', predicate: 'http://p', object: oversized, graph: 'http://g' },
    ])).rejects.toMatchObject({ code: 'OVERSIZED_RDF_LITERAL' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('insert allows 25KB ASCII literal (under MUTF-8 limit)', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    const largeButValid = '"' + 'x'.repeat(25_000) + '"';
    await s.insert([
      { subject: 'http://s1', predicate: 'http://p', object: largeButValid, graph: 'http://g' },
    ]);
    expect(fetchCalls).toHaveLength(1);
    const body = String(fetchCalls[0][1]?.body);
    expect(body).toContain('http://s1');
  });

  it('insert keeps non-literal quads regardless of size', async () => {
    setFetch(async () => new Response(null, { status: 200 }));
    const s = new BlazegraphStore(baseUrl);
    const longUri = 'http://example.org/' + 'a'.repeat(80_000);
    await s.insert([
      { subject: longUri, predicate: 'http://p', object: '"o"', graph: 'http://g' },
    ]);
    expect(fetchCalls).toHaveLength(1);
    const body = String(fetchCalls[0][1]?.body);
    expect(body).toContain(longUri);
  });
});

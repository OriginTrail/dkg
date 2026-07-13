import { createServer, type Server, type ServerResponse } from 'node:http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  SparqlHttpStore,
  createTripleStore,
  getExternalStorePrioritySchedulerSnapshot,
  type Quad,
  type SparqlHttpSlowQueryEvent,
} from '../src/index.js';

let server: Server;
let queryUrl: string;
let updateUrl: string;
const insertedQuads: string[] = [];
/** How many times the server received a listGraphs enumeration query (old `SELECT DISTINCT ?g` scan or the new index-read `GRAPH ?g {} FILTER EXISTS`). */
let listGraphsHits = 0;
/** The most recent listGraphs enumeration query the server received — asserted on to guard the query SHAPE (index-read, not the O(#quads) scan; dkg #1597). */
let lastListGraphsQuery = '';

function respondSelect(res: ServerResponse): void {
  if (res.writableEnded) return;
  res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
  res.end(JSON.stringify({
    head: { vars: ['name'] },
    results: { bindings: [{ name: { type: 'literal', value: 'Alice' } }] },
  }));
}

function respondListGraphs(res: ServerResponse): void {
  if (res.writableEnded) return;
  res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
  res.end(JSON.stringify({
    head: { vars: ['g'] },
    results: { bindings: [{ g: { type: 'uri', value: 'http://ex.org/g1' } }] },
  }));
}

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

function emptySelectResponse(): Response {
  return new Response(JSON.stringify({
    head: { vars: [] },
    results: { bindings: [] },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/sparql-results+json' },
  });
}

async function saturateNormalStoreLanes(label: string): Promise<{
  normalSlots: number;
  fetchCalls: () => number;
  cleanup: (additional?: Array<Promise<unknown>>) => Promise<void>;
}> {
  const originalFetch = globalThis.fetch;
  const before = getExternalStorePrioritySchedulerSnapshot();
  const normalSlots = before.maxConcurrent - before.ackReservedSlots;
  const releaseFetches: Array<(response: Response) => void> = [];
  const blockers: Array<Promise<unknown>> = [];
  let fetchCalls = 0;

  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    fetchCalls++;
    return new Promise<Response>((resolve, reject) => {
      releaseFetches.push(resolve);
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof fetch;

  const cleanup = async (additional: Array<Promise<unknown>> = []) => {
    for (const release of releaseFetches.splice(0)) release(emptySelectResponse());
    await Promise.allSettled([...blockers, ...additional]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    globalThis.fetch = originalFetch;
  };

  try {
    const blockingStore = new SparqlHttpStore({
      queryEndpoint: 'http://deadline.test/query',
      timeout: 30_000,
    });
    for (let i = 0; i < normalSlots; i++) {
      blockers.push(blockingStore.query(
        `SELECT ?s WHERE { # ${label}-blocker-${i}\n?s ?p ?o }`,
        { priority: 'normal' },
      ));
    }
    await waitForCondition(
      () => fetchCalls === normalSlots,
      `normal store lanes did not fill; fetchCalls=${fetchCalls}, slots=${normalSlots}`,
    );
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    normalSlots,
    fetchCalls: () => fetchCalls,
    cleanup,
  };
}

async function outcomeWithin(work: Promise<unknown>, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise<'still-pending'>((resolve) => {
        timer = setTimeout(() => resolve('still-pending'), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const decoded = decodeURIComponent(body);
        if (req.url === '/update') {
          insertedQuads.push(decoded);
          res.writeHead(200);
          res.end();
          return;
        }
        if (req.url?.startsWith('/query')) {
          if (decoded.includes('ASK')) {
            res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
            res.end(JSON.stringify({ boolean: true }));
            return;
          }
          if (decoded.includes('COUNT(*)')) {
            res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
            res.end(JSON.stringify({
              head: { vars: ['c'] },
              results: { bindings: [{ c: { type: 'literal', value: '1' } }] },
            }));
            return;
          }
          if (decoded.includes('?g') && (decoded.includes('DISTINCT') || decoded.includes('GRAPH ?g {}'))) {
            listGraphsHits++;
            lastListGraphsQuery = decoded;
            respondListGraphs(res);
            return;
          }
          respondSelect(res);
          return;
        }
        if (req.url === '/error-update') {
          res.writeHead(500);
          res.end('Server Error');
          return;
        }
        if (req.url === '/error-query') {
          res.writeHead(500);
          res.end('Error');
          return;
        }
        res.writeHead(404);
        res.end('Not Found');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      queryUrl = `http://127.0.0.1:${port}/query`;
      updateUrl = `http://127.0.0.1:${port}/update`;
      resolve();
    });
  });
}

describe('SparqlHttpStore (test server)', () => {
  let store: SparqlHttpStore;

  beforeAll(async () => {
    await startTestServer();
    store = new SparqlHttpStore({ queryEndpoint: queryUrl, updateEndpoint: updateUrl });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('insert sends INSERT DATA to update endpoint', async () => {
    insertedQuads.length = 0;
    await store.insert([{
      subject: 'http://ex.org/s',
      predicate: 'http://ex.org/p',
      object: '"val"',
      graph: 'http://ex.org/g',
    }]);
    expect(insertedQuads.length).toBeGreaterThan(0);
    expect(insertedQuads.some(q => q.includes('INSERT'))).toBe(true);
  });

  it('sends charset=utf-8 on the query and update Content-Type (non-ASCII wire safety)', async () => {
    // Regression guard: without an explicit charset, Jetty-backed stores
    // (Blazegraph) decode the raw body as ISO-8859-1 and mojibake non-ASCII
    // query/update literals. The SPARQL protocol prescribes UTF-8.
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; contentType: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, contentType: headers['Content-Type'] ?? '' });
      const isQuery = url.includes('/query');
      return new Response(
        isQuery ? JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }) : '',
        { status: 200, headers: { 'Content-Type': 'application/sparql-results+json' } },
      );
    }) as typeof fetch;
    try {
      const charsetStore = new SparqlHttpStore({
        queryEndpoint: 'http://charset.test/query',
        updateEndpoint: 'http://charset.test/update',
      });
      await charsetStore.query('SELECT * WHERE { ?s ?p "café" }');
      await charsetStore.insert([
        { subject: 'http://ex.org/s', predicate: 'http://schema.org/name', object: '"café"', graph: '' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const queryReq = seen.find((r) => r.url.includes('/query'));
    const updateReq = seen.find((r) => r.url.includes('/update'));
    expect(queryReq?.contentType).toBe('application/sparql-query; charset=utf-8');
    expect(updateReq?.contentType).toBe('application/sparql-update; charset=utf-8');
  });

  it('rejects RDF literals above the Java MUTF-8 hard limit before update POST', async () => {
    insertedQuads.length = 0;
    await expect(store.insert([{
      subject: 'http://ex.org/s',
      predicate: 'http://schema.org/text',
      object: `"${'x'.repeat(70_000)}"`,
      graph: 'http://ex.org/g',
    }])).rejects.toMatchObject({
      code: 'OVERSIZED_RDF_LITERAL',
    });
    expect(insertedQuads).toHaveLength(0);
  });

  it('query SELECT sends query to query endpoint and parses bindings', async () => {
    const result = await store.query(
      'SELECT ?name WHERE { GRAPH <http://ex.org/g1> { <http://ex.org/alice> <http://schema.org/name> ?name } }',
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['name']).toBe('"Alice"');
    }
  });

  it('routes ack-priority adapter queries ahead of queued background HTTP work', async () => {
    const before = getExternalStorePrioritySchedulerSnapshot();
    expect(before.maxConcurrent).toBeGreaterThan(1);
    expect(before.ackReservedSlots).toBeGreaterThan(0);
    const backgroundSlots = before.maxConcurrent - before.ackReservedSlots;
    const arrivals: Array<'listGraphs' | 'ack' | 'other'> = [];
    const heldListGraphResponses: ServerResponse[] = [];
    let listGraphRequests = 0;
    let priorityServer: Server | undefined;
    const backgroundWork: Array<Promise<unknown>> = [];
    let queuedBackground: Promise<unknown> | undefined;
    let ackQuery: Promise<unknown> | undefined;

    try {
      priorityServer = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const decoded = decodeURIComponent(body);
          if (!req.url?.startsWith('/query')) {
            arrivals.push('other');
            respondSelect(res);
            return;
          }
          if (decoded.includes('ack-priority-probe')) {
            arrivals.push('ack');
            respondSelect(res);
            return;
          }
          if (decoded.includes('?g') && (decoded.includes('DISTINCT') || decoded.includes('GRAPH ?g {}'))) {
            arrivals.push('listGraphs');
            listGraphRequests++;
            if (listGraphRequests <= backgroundSlots) {
              heldListGraphResponses.push(res);
              return;
            }
            respondListGraphs(res);
            return;
          }
          arrivals.push('other');
          respondSelect(res);
        });
      });
      await new Promise<void>((resolve) => {
        priorityServer!.listen(0, '127.0.0.1', resolve);
      });
      const port = (priorityServer.address() as { port: number }).port;
      const priorityUrl = `http://127.0.0.1:${port}/query`;
      const priorityStore = new SparqlHttpStore({ queryEndpoint: priorityUrl, updateEndpoint: priorityUrl });

      for (let i = 0; i < backgroundSlots; i++) {
        backgroundWork.push(priorityStore.listGraphs({
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

      queuedBackground = priorityStore.listGraphs({
        priority: 'background',
        source: 'test.background.queued',
      });
      const queued = getExternalStorePrioritySchedulerSnapshot();
      expect(queued.backgroundQueued - before.backgroundQueued).toBe(1);

      ackQuery = priorityStore.query(
        'SELECT ?name WHERE { # ack-priority-probe\n?s ?p ?o }',
        { priority: 'ack', source: 'test.ack' },
      );
      await waitForCondition(
        () => arrivals.includes('ack'),
        `ACK query did not reach the adapter HTTP server before queued background work; arrivals=${arrivals.join(',')}`,
      );

      expect(arrivals.slice(0, backgroundSlots)).toEqual(Array(backgroundSlots).fill('listGraphs'));
      expect(arrivals[backgroundSlots]).toBe('ack');
      expect(arrivals.filter((kind) => kind === 'listGraphs')).toHaveLength(backgroundSlots);
      await ackQuery;
    } finally {
      for (const res of heldListGraphResponses.splice(0)) respondListGraphs(res);
      await Promise.allSettled([
        ...backgroundWork,
        ...(queuedBackground ? [queuedBackground] : []),
        ...(ackQuery ? [ackQuery] : []),
      ]);
      if (priorityServer) {
        await new Promise<void>((resolve, reject) => {
          priorityServer!.close((err) => (err ? reject(err) : resolve()));
        });
      }
    }
  });

  it('expires a SELECT while it is queued without dispatching it later', async () => {
    const saturation = await saturateNormalStoreLanes('select-deadline');
    let queuedQuery: Promise<unknown> | undefined;
    let fetchCallsAfterRelease = 0;

    try {
      const deadlineStore = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        timeout: 30,
      });
      const startedAt = Date.now();
      queuedQuery = deadlineStore.query(
        'SELECT ?s WHERE { # must-expire-in-queue\n?s ?p ?o }',
        { priority: 'normal' },
      );
      const outcome = await outcomeWithin(queuedQuery, 200);

      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - startedAt).toBeLessThan(200);
    } finally {
      await saturation.cleanup(queuedQuery ? [queuedQuery] : []);
      fetchCallsAfterRelease = saturation.fetchCalls();
    }
    expect(fetchCallsAfterRelease).toBe(saturation.normalSlots);
  });

  it('removes a caller-cancelled SELECT from the queue without dispatching it later', async () => {
    const saturation = await saturateNormalStoreLanes('select-caller-abort');
    const caller = new AbortController();
    const reason = new Error('caller cancelled while queued');
    let queuedQuery: Promise<unknown> | undefined;
    let fetchCallsAfterRelease = 0;

    try {
      const store = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        timeout: 30_000,
      });
      queuedQuery = store.query(
        'SELECT ?s WHERE { # caller-cancelled-in-queue\n?s ?p ?o }',
        { priority: 'normal', signal: caller.signal },
      );

      caller.abort(reason);
      const outcome = await outcomeWithin(queuedQuery, 100);

      expect(outcome).toBe(reason);
    } finally {
      await saturation.cleanup(queuedQuery ? [queuedQuery] : []);
      fetchCallsAfterRelease = saturation.fetchCalls();
    }
    expect(fetchCallsAfterRelease).toBe(saturation.normalSlots);
  });

  it('expires an UPDATE while it is queued without dispatching it later', async () => {
    const saturation = await saturateNormalStoreLanes('update-deadline');
    let queuedUpdate: Promise<unknown> | undefined;
    let fetchCallsAfterRelease = 0;

    try {
      const deadlineStore = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        updateEndpoint: 'http://deadline.test/update',
        timeout: 30,
      });
      const startedAt = Date.now();
      queuedUpdate = deadlineStore.update(
        'INSERT DATA { <http://ex.org/s> <http://ex.org/p> "value" }',
        { priority: 'normal' },
      );
      const outcome = await outcomeWithin(queuedUpdate, 200);

      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - startedAt).toBeLessThan(200);
    } finally {
      await saturation.cleanup(queuedUpdate ? [queuedUpdate] : []);
      fetchCallsAfterRelease = saturation.fetchCalls();
    }
    expect(fetchCallsAfterRelease).toBe(saturation.normalSlots);
  });

  it('keeps the UPDATE deadline active while reading an error response body', async () => {
    const originalFetch = globalThis.fetch;
    let rejectBody!: (reason?: unknown) => void;
    const body = new Promise<string>((_resolve, reject) => {
      rejectBody = reject;
    });
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      text: () => body,
    }) as Response) as typeof fetch;

    try {
      const deadlineStore = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        updateEndpoint: 'http://deadline.test/update',
        timeout: 10,
      });

      const startedAt = Date.now();
      const outcome = await outcomeWithin(deadlineStore.update(
        'INSERT DATA { <http://ex.org/s> <http://ex.org/p> "value" }',
      ), 100);
      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - startedAt).toBeLessThan(100);
    } finally {
      rejectBody(new Error('late body failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps the SELECT deadline active while reading an error response body', async () => {
    const originalFetch = globalThis.fetch;
    let rejectBody!: (reason?: unknown) => void;
    const body = new Promise<string>((_resolve, reject) => {
      rejectBody = reject;
    });
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      text: () => body,
    }) as Response) as typeof fetch;

    try {
      const deadlineStore = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        timeout: 10,
      });

      const startedAt = Date.now();
      const outcome = await outcomeWithin(deadlineStore.query(
        'SELECT ?s WHERE { ?s ?p ?o }',
      ), 100);
      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - startedAt).toBeLessThan(100);
    } finally {
      rejectBody(new Error('late body failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects promptly when SELECT JSON decoding ignores fetch abort', async () => {
    const originalFetch = globalThis.fetch;
    let rejectBody!: (reason?: unknown) => void;
    const body = new Promise<unknown>((_resolve, reject) => {
      rejectBody = reject;
    });
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: () => body,
    }) as Response) as typeof fetch;

    try {
      const deadlineStore = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        timeout: 10,
      });

      const startedAt = Date.now();
      const outcome = await outcomeWithin(deadlineStore.query(
        'SELECT ?s WHERE { ?s ?p ?o }',
      ), 100);
      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - startedAt).toBeLessThan(100);
    } finally {
      rejectBody(new Error('late JSON failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects promptly when CONSTRUCT N-Quads decoding ignores fetch abort', async () => {
    const originalFetch = globalThis.fetch;
    let rejectBody!: (reason?: unknown) => void;
    const body = new Promise<string>((_resolve, reject) => {
      rejectBody = reject;
    });
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: () => body,
    }) as Response) as typeof fetch;

    try {
      const deadlineStore = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        timeout: 10,
      });

      const startedAt = Date.now();
      const outcome = await outcomeWithin(deadlineStore.query(
        'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
      ), 100);
      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - startedAt).toBeLessThan(100);
    } finally {
      rejectBody(new Error('late N-Quads failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      globalThis.fetch = originalFetch;
    }
  });

  it('checks the SELECT deadline after synchronous result mapping', async () => {
    const originalFetch = globalThis.fetch;
    const vars = ['name'];
    const originalIterator = vars[Symbol.iterator].bind(vars);
    vars[Symbol.iterator] = () => {
      const busyUntil = Date.now() + 25;
      while (Date.now() < busyUntil) {
        // Model CPU-bound result mapping, during which a timeout callback
        // cannot run because JavaScript is still on the same event-loop turn.
      }
      return originalIterator();
    };
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        head: { vars },
        results: {
          bindings: [{ name: { type: 'literal', value: 'Alice' } }],
        },
      }),
    }) as Response) as typeof fetch;

    try {
      const deadlineStore = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        timeout: 5,
      });

      await expect(deadlineStore.query(
        'SELECT ?name WHERE { ?s ?p ?name }',
      )).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('composes caller abort signals into in-flight SELECT and CONSTRUCT fetches', async () => {
    const originalFetch = globalThis.fetch;
    const seenSignals: AbortSignal[] = [];
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal instanceof AbortSignal) seenSignals.push(init.signal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
    try {
      const signalController = new AbortController();
      const signalStore = new SparqlHttpStore({ queryEndpoint: 'http://example.test/query', timeout: 30_000 });
      const reason = new Error('caller aborted');

      const select = signalStore.query(
        'SELECT ?s WHERE { ?s ?p ?o }',
        { signal: signalController.signal },
      );
      const construct = signalStore.query(
        'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        { signal: signalController.signal },
      );
      await waitForCondition(
        () => seenSignals.length === 2,
        `caller signals did not reach both fetches; seen=${seenSignals.length}`,
      );

      expect(seenSignals).toHaveLength(2);
      expect(seenSignals.every((signal) => !signal.aborted)).toBe(true);
      signalController.abort(reason);
      expect(seenSignals.every((signal) => signal.aborted)).toBe(true);
      await expect(select).rejects.toBe(reason);
      await expect(construct).rejects.toBe(reason);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('detaches its caller abort listener after a completed operation', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      head: { vars: [] },
      results: { bindings: [] },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/sparql-results+json' },
    })) as typeof fetch;
    const caller = new AbortController();
    const addListener = vi.spyOn(caller.signal, 'addEventListener');
    const removeListener = vi.spyOn(caller.signal, 'removeEventListener');

    try {
      const signalStore = new SparqlHttpStore({
        queryEndpoint: 'http://example.test/query',
        timeout: 30_000,
      });
      await signalStore.query(
        'SELECT ?s WHERE { ?s ?p ?o }',
        { signal: caller.signal },
      );

      expect(addListener).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledTimes(1);
    } finally {
      addListener.mockRestore();
      removeListener.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects in-flight queries when the caller aborts', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch;
    try {
      const signalController = new AbortController();
      const signalStore = new SparqlHttpStore({ queryEndpoint: 'http://example.test/query', timeout: 30_000 });
      const query = signalStore.query('SELECT ?s WHERE { ?s ?p ?o }', { signal: signalController.signal });

      await new Promise((resolve) => setTimeout(resolve, 0));
      signalController.abort(new Error('caller aborted'));

      await expect(query).rejects.toThrow(/caller aborted/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits sampled slow-query events with source tags and query fingerprints', async () => {
    let clock = 0;
    const events: SparqlHttpSlowQueryEvent[] = [];
    const taggedStore = new SparqlHttpStore({
      queryEndpoint: queryUrl,
      updateEndpoint: updateUrl,
      slowQueryThresholdMs: 10,
      onSlowQuery: (event) => events.push(event),
      now: () => clock,
    });

    const pending = taggedStore.query(
      'SELECT ?name WHERE { GRAPH <http://ex.org/g1> { <http://ex.org/alice> <http://schema.org/name> ?name } }',
      { source: 'unit test/source' },
    );
    clock = 25;
    await pending;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'unit_test/source',
      operation: 'select',
      elapsedMs: 25,
      thresholdMs: 10,
      endpoint: queryUrl,
    });
    expect(events[0].queryHash).toMatch(/^[a-f0-9]{16}$/);
    expect(events[0].queryBytes).toBeGreaterThan(0);
    expect(events[0]).not.toHaveProperty('sparql');
  });

  it('honors slow-query sample rate zero', async () => {
    let clock = 0;
    const events: SparqlHttpSlowQueryEvent[] = [];
    const sampledOutStore = new SparqlHttpStore({
      queryEndpoint: queryUrl,
      updateEndpoint: updateUrl,
      slowQueryThresholdMs: 1,
      slowQuerySampleRate: 0,
      onSlowQuery: (event) => events.push(event),
      now: () => clock,
    });

    const pending = sampledOutStore.query('ASK { GRAPH <http://ex.org/g> { ?s ?p ?o } }', {
      source: 'sampled-out',
    });
    clock = 50;
    await pending;

    expect(events).toHaveLength(0);
  });

  it('does not let slow-query hook failures fail the query', async () => {
    let clock = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new SparqlHttpStore({
      queryEndpoint: queryUrl,
      updateEndpoint: updateUrl,
      slowQueryThresholdMs: 1,
      onSlowQuery: () => { throw new Error('sink down'); },
      now: () => clock,
    });

    try {
      const pending = store.query('ASK { GRAPH <http://ex.org/g> { ?s ?p ?o } }', {
        source: 'throwing-hook',
      });
      clock = 50;
      const result = await pending;
      expect(result.type).toBe('boolean');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('slow query hook failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('redacts endpoint query strings from slow-query telemetry', async () => {
    let clock = 0;
    const events: SparqlHttpSlowQueryEvent[] = [];
    const store = new SparqlHttpStore({
      queryEndpoint: `${queryUrl}?token=secret#fragment`,
      updateEndpoint: updateUrl,
      slowQueryThresholdMs: 1,
      onSlowQuery: (event) => events.push(event),
      now: () => clock,
    });

    const pending = store.query('ASK { GRAPH <http://ex.org/g> { ?s ?p ?o } }', {
      source: 'secret-endpoint',
    });
    clock = 50;
    await pending;

    expect(events).toHaveLength(1);
    expect(events[0].endpoint).toBe(queryUrl);
    expect(events[0].endpoint).not.toContain('secret');
    expect(events[0].endpoint).not.toContain('#fragment');
  });

  it('query ASK returns boolean', async () => {
    const result = await store.query('ASK { GRAPH <http://ex.org/g> { ?s ?p ?o } }');
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(true);
  });

  it('delete sends DELETE DATA to update endpoint', async () => {
    insertedQuads.length = 0;
    await store.delete([{
      subject: 'http://ex.org/s',
      predicate: 'http://ex.org/p',
      object: '"val"',
      graph: 'http://ex.org/g',
    }]);
    expect(insertedQuads.some(q => q.includes('DELETE'))).toBe(true);
  });

  it('countQuads sends COUNT query and returns number', async () => {
    const n = await store.countQuads('http://ex.org/g');
    expect(n).toBe(1);
  });

  it('hasGraph sends ASK and returns boolean', async () => {
    const has = await store.hasGraph('http://ex.org/g');
    expect(has).toBe(true);
  });

  it('listGraphs returns graph URIs from the graph-index enumeration query', async () => {
    lastListGraphsQuery = '';
    const graphs = await store.listGraphs();
    expect(graphs).toContain('http://ex.org/g1');
    // Query SHAPE guard (dkg #1597 review): the adapter MUST issue the index-read
    // form, not the O(#quads) scan and not bare `GRAPH ?g {}` (which over-lists
    // emptied graphs). Fails if listGraphsDirect is reverted to the legacy query.
    expect(lastListGraphsQuery).toContain('GRAPH ?g {}');
    expect(lastListGraphsQuery).toMatch(/FILTER\s+EXISTS/i);
    expect(lastListGraphsQuery).not.toMatch(/DISTINCT/i);
  });

  it('dropGraph sends DROP SILENT GRAPH to update endpoint', async () => {
    insertedQuads.length = 0;
    await store.dropGraph('http://ex.org/g1');
    expect(insertedQuads.some(q => q.includes('DROP'))).toBe(true);
  });

  it('deleteByPattern sends DELETE WHERE to update endpoint', async () => {
    insertedQuads.length = 0;
    await store.deleteByPattern({ subject: 'http://ex.org/s', graph: 'http://ex.org/g' });
    expect(insertedQuads.some(q => q.includes('DELETE'))).toBe(true);
  });

  it('deleteBySubjectPrefix sends DELETE with FILTER STRSTARTS', async () => {
    insertedQuads.length = 0;
    await store.deleteBySubjectPrefix('http://ex.org/g', 'http://ex.org/');
    expect(insertedQuads.some(q => q.includes('DELETE'))).toBe(true);
  });

  it('uses single URL for both endpoints when updateEndpoint omitted', async () => {
    const singleUrl = queryUrl;
    const s = new SparqlHttpStore({ queryEndpoint: singleUrl });
    const has = await s.hasGraph('http://ex.org/g');
    expect(typeof has).toBe('boolean');
  });

  it('throws on insert when server returns non-OK', async () => {
    const port = (server.address() as { port: number }).port;
    const badStore = new SparqlHttpStore({
      queryEndpoint: queryUrl,
      updateEndpoint: `http://127.0.0.1:${port}/error-update`,
    });
    await expect(
      badStore.insert([{ subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"x"', graph: '' }]),
    ).rejects.toThrow(/insert failed/);
  });

  it('throws on query when server returns non-OK', async () => {
    const port = (server.address() as { port: number }).port;
    const badStore = new SparqlHttpStore({
      queryEndpoint: `http://127.0.0.1:${port}/error-query`,
      updateEndpoint: updateUrl,
    });
    await expect(badStore.query('SELECT ?x WHERE { ?x ?y ?z }')).rejects.toThrow(/query failed/);
  });

  it('close is a no-op and stays idempotent — follow-up ops still work against the same endpoint', async () => {
    // SparqlHttpStore is stateless over HTTP, so close() is effectively a
    // no-op. The contract this test locks in: (1) close never throws and
    // resolves cleanly, (2) calling close multiple times is safe, (3) because
    // close doesn't tear down any persistent resource, a follow-up query
    // still succeeds against the same endpoint. This catches regressions
    // where someone accidentally wires close() to tear down a shared agent
    // or to set a disposed flag that would break reuse of the same instance.
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();

    const result = await store.query('SELECT ?x WHERE { ?x ?y ?z } LIMIT 1');
    expect(result.type).toBe('bindings');
  });

  describe('listGraphs()', () => {
    it('preserves adapter-local listGraphs caching for direct managedByDkg callers', async () => {
      listGraphsHits = 0;
      const store = new SparqlHttpStore({
        queryEndpoint: queryUrl,
        updateEndpoint: updateUrl,
        managedByDkg: true,
      });
      const a = await store.listGraphs();
      const b = await store.listGraphs();
      expect(a).toContain('http://ex.org/g1');
      expect(b).toContain('http://ex.org/g1');
      expect(listGraphsHits).toBe(1);

      await store.insert([{
        subject: 'http://ex.org/s',
        predicate: 'http://ex.org/p',
        object: '"v"',
        graph: 'http://ex.org/g2',
      }]);
      await expect(store.listGraphs()).resolves.toContain('http://ex.org/g1');
      expect(listGraphsHits).toBe(2);
    });

    it('does not let one aborted managed listGraphs caller poison the shared refresh', async () => {
      const originalFetch = globalThis.fetch;
      let fetchStarted!: () => void;
      let resolveFetch!: (response: Response) => void;
      let rejectFetch!: (reason?: unknown) => void;
      const started = new Promise<void>((resolve) => {
        fetchStarted = resolve;
      });
      const pendingFetch = new Promise<Response>((resolve, reject) => {
        resolveFetch = resolve;
        rejectFetch = reject;
      });
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        fetchStarted();
        init?.signal?.addEventListener('abort', () => {
          // If the shared refresh is incorrectly wired to the first caller's
          // signal, this makes the second caller observe the poisoned promise.
          rejectFetch(init.signal?.reason);
        }, { once: true });
        return pendingFetch;
      }) as typeof fetch;
      try {
        const store = new SparqlHttpStore({
          queryEndpoint: 'http://example.test/query',
          managedByDkg: true,
          timeout: 30_000,
        });
        const firstCaller = new AbortController();
        const first = store.listGraphs({ signal: firstCaller.signal });
        await started;

        firstCaller.abort(new Error('first caller aborted'));
        await expect(first).rejects.toThrow(/first caller aborted/);

        const second = store.listGraphs();
        resolveFetch(new Response(JSON.stringify({
          head: { vars: ['g'] },
          results: { bindings: [{ g: { type: 'uri', value: 'http://ex.org/g1' } }] },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        }));

        await expect(second).resolves.toEqual(['http://ex.org/g1']);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('uses GraphSetIndexStore as the only cache owner for managed factory stores', async () => {
      listGraphsHits = 0;
      const store = await createTripleStore({
        backend: 'sparql-http',
        options: {
          queryEndpoint: queryUrl,
          updateEndpoint: updateUrl,
          managedByDkg: true,
        },
        graphSetIndex: { revalidateMs: 0 },
      });
      try {
        expect(typeof store.listGraphsByPrefix).toBe('function');
        await expect(store.listGraphsByPrefix!('http://ex.org/')).resolves.toEqual([
          'http://ex.org/g1',
        ]);
        await expect(store.listGraphsByPrefix!('http://ex.org/')).resolves.toEqual([
          'http://ex.org/g1',
        ]);
        expect(listGraphsHits).toBe(2);
      } finally {
        await store.close();
      }
    });
  });
});

const liveQueryUrl = process.env.SPARQL_HTTP_TEST_QUERY_URL;
const liveUpdateUrl = process.env.SPARQL_HTTP_TEST_UPDATE_URL ?? liveQueryUrl;

if (liveQueryUrl && liveUpdateUrl) {
  describe('SparqlHttpStore (live endpoint)', () => {
    const factory = () =>
      createTripleStore({
        backend: 'sparql-http',
        options: { queryEndpoint: liveQueryUrl, updateEndpoint: liveUpdateUrl },
      });

    it('inserts and queries quads', async () => {
      const store = await factory();
      const quads: Quad[] = [{
        subject: 'http://ex.org/test/alice',
        predicate: 'http://schema.org/name',
        object: '"Alice"',
        graph: 'http://ex.org/test/g',
      }];
      await store.insert(quads);
      const result = await store.query(
        'SELECT ?name WHERE { GRAPH <http://ex.org/test/g> { <http://ex.org/test/alice> <http://schema.org/name> ?name } }',
      );
      expect(result.type).toBe('bindings');
      if (result.type === 'bindings') {
        expect(result.bindings.length).toBe(1);
        expect(result.bindings[0]['name']).toBe('"Alice"');
      }
      await store.deleteByPattern({ graph: 'http://ex.org/test/g' });
      await store.close();
    });
  });
}
// NOTE: previously this else branch registered an empty
// `it.skip('requires a running SPARQL 1.1 endpoint', () => {})` just to
// surface a skip line in the reporter. That stub had no assertion and
// wasn't exercising anything — removed. The live-endpoint `describe` above
// only runs when `SPARQL_HTTP_TEST_QUERY_URL` is set; otherwise the mock
// server tests above give full coverage of the adapter's HTTP contract.

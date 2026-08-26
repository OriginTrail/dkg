import { createServer, type Server, type ServerResponse } from 'node:http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  SparqlHttpStore,
  createTripleStore,
  getExternalStorePrioritySchedulerSnapshot,
  tryReplaceGraphAtomically,
  tryReplaceSubjectAtomically,
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
    const backgroundSlots = before.maxConcurrent
      - before.ackReservedSlots
      - (before.healthReservedSlots ?? 0)
      - (before.normalReservedSlots ?? 0);
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

  it('composes caller abort signals into SELECT and CONSTRUCT fetches', async () => {
    const originalFetch = globalThis.fetch;
    const seenSignals: AbortSignal[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal instanceof AbortSignal) seenSignals.push(init.signal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        });
      });
    }) as typeof fetch;
    try {
      const signalController = new AbortController();
      const signalStore = new SparqlHttpStore({ queryEndpoint: 'http://example.test/query', timeout: 30_000 });

      const select = signalStore.query(
        'SELECT ?s WHERE { ?s ?p ?o }',
        { signal: signalController.signal },
      );
      const construct = signalStore.query(
        'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        { signal: signalController.signal },
      );
      const selectRejected = expect(select).rejects.toThrow('caller aborted');
      const constructRejected = expect(construct).rejects.toThrow('caller aborted');

      await waitForCondition(() => seenSignals.length === 2, 'both fetches should start');
      expect(seenSignals).toHaveLength(2);
      expect(seenSignals.every((signal) => !signal.aborted)).toBe(true);
      signalController.abort(new Error('caller aborted'));
      expect(seenSignals.every((signal) => signal.aborted)).toBe(true);
      await Promise.all([selectRejected, constructRejected]);
    } finally {
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

  it('does not return a timeout until the aborted server attempt has stopped', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls > 1) {
        active -= 1;
        return new Response(JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          // Model an HTTP/server stack that needs cleanup time after receiving
          // cancellation. The adapter must keep its admission slot and caller
          // promise pending until that cleanup finishes.
          setTimeout(() => {
            active -= 1;
            reject(init.signal?.reason);
          }, 20);
        }, { once: true });
      });
    }) as typeof fetch;
    try {
      const store = new SparqlHttpStore({ queryEndpoint: 'http://example.test/query', timeout: 5 });
      await expect(store.query('SELECT ?s WHERE { ?s ?p ?o }')).rejects.toMatchObject({
        name: 'TimeoutError',
        code: 'STORE_OPERATION_TIMEOUT',
        retryable: true,
        backend: 'sparql-http',
        operation: 'query',
      });
      expect(active).toBe(0);

      await expect(store.query('SELECT ?s WHERE { ?s ?p ?o }')).resolves.toMatchObject({
        type: 'bindings',
      });
      expect(maxActive).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits complete timeout metadata for a timed-out mutation', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
      })) as typeof fetch;
    try {
      const store = new SparqlHttpStore({
        queryEndpoint: 'http://example.test/query',
        updateEndpoint: 'http://example.test/update',
        timeout: 5,
      });
      const graph = 'http://g';
      const before = store.getWriteRevision(graph);
      await expect(store.insert([
        { subject: 'http://s', predicate: 'http://p', object: '"o"', graph },
      ])).rejects.toMatchObject({
        name: 'TimeoutError',
        code: 'STORE_OPERATION_TIMEOUT',
        retryable: true,
        backend: 'sparql-http',
        operation: 'insert',
        timeoutMs: 5,
        outcome: 'indeterminate',
      });
      const after = store.getWriteRevision(graph);
      expect(after.generation).toBeGreaterThan(before.generation);
      expect(after.stable).toBe(false);
      expect(store.getWriteRevision(graph)).toEqual(after);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('notifies managed Oxigraph recovery when the client query deadline fires', async () => {
    const originalFetch = globalThis.fetch;
    const timedOutOperations: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
      })) as typeof fetch;
    try {
      const store = new SparqlHttpStore({
        queryEndpoint: 'http://managed-oxigraph.test/query',
        managedOxigraph: true,
        timeout: 5,
        onClientTimeout: (operation) => timedOutOperations.push(operation),
      });
      await expect(store.query('SELECT ?s WHERE { ?s ?p ?o }')).rejects.toMatchObject({
        code: 'STORE_OPERATION_TIMEOUT',
        backend: 'oxigraph-server',
        operation: 'query',
        timeoutMs: 5,
      });
      expect(timedOutOperations).toEqual(['query']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('classifies a concurrent write and new work during query-triggered recovery', async () => {
    const originalFetch = globalThis.fetch;
    let recovery = { recovering: false, generation: 0 };
    let fetchCalls = 0;
    let resolveQueryStarted!: () => void;
    let resolveUpdateStarted!: () => void;
    let rejectUpdate!: (error: unknown) => void;
    const queryStarted = new Promise<void>((resolve) => { resolveQueryStarted = resolve; });
    const updateStarted = new Promise<void>((resolve) => { resolveUpdateStarted = resolve; });

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchCalls += 1;
      const body = String(init?.body ?? '');
      if (recovery.generation > 0 && !recovery.recovering) {
        return new Response(JSON.stringify({ head: {}, boolean: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      }
      if (body.startsWith('INSERT')) {
        resolveUpdateStarted();
        return await new Promise<Response>((_resolve, reject) => {
          rejectUpdate = reject;
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      resolveQueryStarted();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;

    try {
      const managed = new SparqlHttpStore({
        queryEndpoint: 'http://managed-oxigraph.test/query',
        updateEndpoint: 'http://managed-oxigraph.test/update',
        managedOxigraph: true,
        timeout: 100,
        getRecoveryState: () => recovery,
        onClientTimeout: (operation) => {
          if (operation !== 'query') return;
          recovery = { recovering: true, generation: 1 };
          rejectUpdate(new TypeError('fetch failed: managed server restarted'));
        },
      });

      const query = managed.query('SELECT ?s WHERE { ?s ?p ?o }');
      const queryFailure = query.catch((error) => error);
      await queryStarted;
      const update = managed.insert([{
        subject: 'http://ex.org/s',
        predicate: 'http://ex.org/p',
        object: '"value"',
        graph: 'http://ex.org/g',
      }]);
      const updateFailure = update.catch((error) => error);
      await updateStarted;

      expect(await queryFailure).toMatchObject({
        code: 'STORE_OPERATION_TIMEOUT',
        operation: 'query',
        outcome: 'indeterminate',
      });
      expect(await updateFailure).toMatchObject({
        code: 'STORE_OPERATION_TIMEOUT',
        backend: 'oxigraph-server',
        operation: 'insert',
        outcome: 'indeterminate',
      });

      await expect(managed.query('ASK { ?s ?p ?o }')).rejects.toMatchObject({
        code: 'STORE_OPERATION_TIMEOUT',
        operation: 'query',
        outcome: 'not_started',
      });
      expect(fetchCalls).toBe(2);

      recovery = { recovering: false, generation: 1 };
      await expect(managed.query('ASK { ?s ?p ?o }')).resolves.toMatchObject({
        type: 'boolean',
        value: true,
      });
      expect(fetchCalls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('classifies an in-flight write after recovery has already completed', async () => {
    const originalFetch = globalThis.fetch;
    let recovery = { recovering: false, generation: 0 };
    let rejectWrite!: (error: unknown) => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    globalThis.fetch = (async () => await new Promise<Response>((_resolve, reject) => {
      rejectWrite = reject;
      markWriteStarted();
    })) as typeof fetch;

    try {
      const managed = new SparqlHttpStore({
        queryEndpoint: 'http://managed-oxigraph.test/query',
        updateEndpoint: 'http://managed-oxigraph.test/update',
        managedOxigraph: true,
        timeout: 5_000,
        getRecoveryState: () => recovery,
      });
      const writeFailure = managed.insert([{
        subject: 'http://ex.org/s',
        predicate: 'http://ex.org/p',
        object: '"value"',
        graph: 'http://ex.org/g',
      }]).catch((error) => error);
      await writeStarted;

      // The transport rejects only after the supervisor is healthy again.
      // The generation change is therefore the sole evidence that this
      // in-flight write crossed a recovery boundary.
      recovery = { recovering: false, generation: 1 };
      rejectWrite(new TypeError('socket closed by completed recovery'));

      expect(await writeFailure).toMatchObject({
        code: 'STORE_OPERATION_TIMEOUT',
        backend: 'oxigraph-server',
        operation: 'insert',
        outcome: 'indeterminate',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a partial managed Oxigraph SELECT response when the native deadline cancels it', async () => {
    const originalFetch = globalThis.fetch;
    const onClientTimeout = vi.fn();
    globalThis.fetch = (async () => new Response(
      '{"head":{"vars":["s"]},"results":{"bindings":[The SPARQL operation has been cancelled',
      { status: 200, headers: { 'Content-Type': 'application/sparql-results+json' } },
    )) as typeof fetch;
    try {
      const managed = new SparqlHttpStore({
        queryEndpoint: 'http://managed-oxigraph.test/query',
        managedByDkg: true,
        onClientTimeout,
      });
      await expect(managed.query('SELECT ?s WHERE { ?s ?p ?o }')).rejects.toMatchObject({
        name: 'TimeoutError',
        code: 'STORE_OPERATION_TIMEOUT',
        retryable: true,
        backend: 'oxigraph-server',
        operation: 'query',
      });
      expect(onClientTimeout).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves managed Oxigraph timeout semantics behind GraphSetIndexStore', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      'query failed\nThe SPARQL operation has been cancelled',
      { status: 500 },
    )) as typeof fetch;
    const managed = await createTripleStore({
      backend: 'sparql-http',
      options: {
        queryEndpoint: 'http://managed-oxigraph.test/query',
        managedByDkg: true,
        managedOxigraph: true,
      },
      graphSetIndex: true,
    });
    try {
      await expect(managed.query('SELECT ?s WHERE { ?s ?p ?o }')).rejects.toMatchObject({
        code: 'STORE_OPERATION_TIMEOUT',
        backend: 'oxigraph-server',
        operation: 'query',
      });
    } finally {
      await managed.close();
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects rather than parsing a partial managed Oxigraph CONSTRUCT response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      '<http://s> <http://p> "partial" <http://g> .\nThe SPARQL operation has been cancelled',
      { status: 200, headers: { 'Content-Type': 'application/n-quads' } },
    )) as typeof fetch;
    try {
      const managed = new SparqlHttpStore({
        queryEndpoint: 'http://managed-oxigraph.test/query',
        managedByDkg: true,
      });
      await expect(
        managed.query('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }'),
      ).rejects.toMatchObject({
        name: 'TimeoutError',
        code: 'STORE_OPERATION_TIMEOUT',
        retryable: true,
        backend: 'oxigraph-server',
        operation: 'construct',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a managed Oxigraph cancellation body on a non-OK response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      'query failed\nThe SPARQL operation has been cancelled',
      { status: 500 },
    )) as typeof fetch;
    try {
      const managed = new SparqlHttpStore({
        queryEndpoint: 'http://managed-oxigraph.test/query',
        managedByDkg: true,
      });
      await expect(managed.query('SELECT ?s WHERE { ?s ?p ?o }')).rejects.toMatchObject({
        code: 'STORE_OPERATION_TIMEOUT',
        backend: 'oxigraph-server',
        operation: 'query',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not apply the managed Oxigraph cancellation policy to generic endpoints', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      'query failed\nThe SPARQL operation has been cancelled',
      { status: 500 },
    )) as typeof fetch;
    try {
      const generic = new SparqlHttpStore({
        queryEndpoint: 'http://generic-sparql.test/query',
      });
      let failure: unknown;
      try {
        await generic.query('SELECT ?s WHERE { ?s ?p ?o }');
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        message: expect.stringContaining('SPARQL HTTP query failed (500)'),
      });
      expect((failure as { code?: unknown }).code).toBeUndefined();
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
      `PREFIX schema: <http://schema.org/>
       SELECT ?name WHERE { GRAPH <http://ex.org/g1> { <http://ex.org/alice> schema:name ?name } }`,
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

  it('close aborts and drains queued/in-flight HTTP work before resolving', async () => {
    const originalFetch = globalThis.fetch;
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    let cancellationSettled = false;
    let fetchCalls = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchCalls++;
      fetchStarted();
      if (fetchCalls > 1) {
        return new Response(JSON.stringify({
          head: { vars: [] },
          results: { bindings: [] },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          setTimeout(() => {
            cancellationSettled = true;
            reject(init.signal?.reason);
          }, 10);
        }, { once: true });
      });
    }) as typeof fetch;

    try {
      const closingStore = new SparqlHttpStore({
        queryEndpoint: 'http://close.test/query',
        timeout: 30_000,
      });
      const query = closingStore.query('SELECT ?s WHERE { ?s ?p ?o }');
      const rejected = expect(query).rejects.toThrow(/SparqlHttpStore closed/);
      await started;

      await closingStore.close();

      expect(cancellationSettled).toBe(true);
      await rejected;
      await expect(
        closingStore.query('SELECT ?s WHERE { ?s ?p ?o }'),
      ).resolves.toMatchObject({ type: 'bindings' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('close aborts scheduler-queued work before it reaches fetch', async () => {
    const originalFetch = globalThis.fetch;
    let firstFetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstFetchStarted = resolve;
    });
    let fetchCalls = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchCalls++;
      firstFetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          setTimeout(() => reject(init.signal?.reason), 10);
        }, { once: true });
      });
    }) as typeof fetch;

    try {
      const store = new SparqlHttpStore({
        queryEndpoint: 'http://queued-close.test/query',
        timeout: 30_000,
      });
      const active = store.query('SELECT ?s WHERE { ?s ?p ?o }', {
        priority: 'background',
        source: 'test.close.active',
      });
      const activeRejected = expect(active).rejects.toThrow(/SparqlHttpStore closed/);
      await started;

      const queued = store.query('SELECT ?o WHERE { ?s ?p ?o }', {
        priority: 'background',
        source: 'test.close.queued',
      });
      const queuedRejected = expect(queued).rejects.toThrow(/SparqlHttpStore closed/);
      await Promise.resolve();

      await store.close();

      expect(fetchCalls).toBe(1);
      await Promise.all([activeRejected, queuedRejected]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('close aborts and drains an in-flight update request', async () => {
    const originalFetch = globalThis.fetch;
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    let cancellationSettled = false;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      fetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          setTimeout(() => {
            cancellationSettled = true;
            reject(init.signal?.reason);
          }, 10);
        }, { once: true });
      });
    }) as typeof fetch;

    try {
      const store = new SparqlHttpStore({
        queryEndpoint: 'http://write-close.test/query',
        updateEndpoint: 'http://write-close.test/update',
        timeout: 30_000,
      });
      const update = store.insert([{
        subject: 'http://ex.org/s',
        predicate: 'http://ex.org/p',
        object: '"value"',
        graph: 'http://ex.org/g',
      }]);
      const updateRejected = expect(update).rejects.toThrow(/SparqlHttpStore closed/);
      await started;

      await store.close();

      expect(observedSignal?.aborted).toBe(true);
      expect(cancellationSettled).toBe(true);
      await updateRejected;
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects work admitted during close and reopens only after the drain', async () => {
    const originalFetch = globalThis.fetch;
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    let settleCancellation!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      settleCancellation = resolve;
    });
    let fetchCalls = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchCalls++;
      if (fetchCalls > 1) {
        return new Response(JSON.stringify({
          head: { vars: [] },
          results: { bindings: [] },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      }
      fetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          void cancellationGate.then(() => reject(init.signal?.reason));
        }, { once: true });
      });
    }) as typeof fetch;

    try {
      const store = new SparqlHttpStore({
        queryEndpoint: 'http://closing-generation.test/query',
        timeout: 30_000,
      });
      const active = store.query('SELECT ?s WHERE { ?s ?p ?o }');
      const activeRejected = expect(active).rejects.toThrow(/SparqlHttpStore closed/);
      await started;

      const closing = store.close();
      await expect(
        store.query('SELECT ?during WHERE { ?during ?p ?o }'),
      ).rejects.toThrow(/SparqlHttpStore closed/);
      expect(fetchCalls).toBe(1);

      settleCancellation();
      await closing;
      await activeRejected;

      await expect(
        store.query('SELECT ?after WHERE { ?after ?p ?o }'),
      ).resolves.toMatchObject({ type: 'bindings' });
      expect(fetchCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it('replaceGraph sends one staged MOVE update when the endpoint declares atomic updates', async () => {
    insertedQuads.length = 0;
    const atomicStore = new SparqlHttpStore({
      queryEndpoint: queryUrl,
      updateEndpoint: updateUrl,
      atomicUpdates: true,
    });
    await atomicStore.replaceGraph('http://ex.org/g1', [{
      subject: 'http://ex.org/new',
      predicate: 'http://ex.org/p',
      object: '"new"',
      graph: 'http://ex.org/g1',
    }]);
    expect(insertedQuads).toHaveLength(1);
    expect(insertedQuads[0]).toContain('urn:dkg:internal:atomic-graph-replace:');
    expect(insertedQuads[0]).toContain('INSERT DATA');
    // Non-SILENT: a missing staging graph must fail loudly, not report success.
    expect(insertedQuads[0]).toContain('MOVE GRAPH');
    expect(insertedQuads[0]).not.toContain('MOVE SILENT');
    expect(insertedQuads[0]).toContain('TO GRAPH <http://ex.org/g1>');
  });

  it('replaceGraph fails closed for endpoints without a declared atomicity guarantee', async () => {
    // SPARQL 1.1 only RECOMMENDS whole-request atomicity: a generic endpoint
    // could apply the staged DROP/INSERT/MOVE partially and strand the target
    // graph. The plain store must refuse the capability BEFORE sending any
    // update, so rootless KA writers take their non-atomic fallback instead.
    insertedQuads.length = 0;
    const replacement = [{
      subject: 'http://ex.org/new',
      predicate: 'http://ex.org/p',
      object: '"new"',
      graph: 'http://ex.org/g1',
    }];
    await expect(store.replaceGraph('http://ex.org/g1', replacement))
      .rejects.toMatchObject({
        name: 'UnsupportedTripleStoreCapabilityError',
        capability: 'replaceGraph',
      });
    await expect(tryReplaceGraphAtomically(store, 'http://ex.org/g1', replacement))
      .resolves.toBe(false);
    expect(insertedQuads).toHaveLength(0);

    // Daemon-owned endpoints are oxigraph-server (transactional) and keep it.
    const managedStore = new SparqlHttpStore({
      queryEndpoint: queryUrl,
      updateEndpoint: updateUrl,
      managedByDkg: true,
    });
    await expect(tryReplaceGraphAtomically(managedStore, 'http://ex.org/g1', replacement))
      .resolves.toBe(true);
    expect(insertedQuads).toHaveLength(1);
  });

  it('replaceSubject sends one subject-scoped DELETE WHERE + INSERT DATA when the endpoint declares atomic updates', async () => {
    insertedQuads.length = 0;
    const atomicStore = new SparqlHttpStore({
      queryEndpoint: queryUrl,
      updateEndpoint: updateUrl,
      atomicUpdates: true,
    });
    const ok = await tryReplaceSubjectAtomically(atomicStore, 'http://ex.org/g1', 'http://ex.org/job', [{
      subject: 'http://ex.org/job',
      predicate: 'http://ex.org/p',
      object: '"new"',
      graph: 'http://ex.org/g1',
    }]);
    expect(ok).toBe(true);
    // One HTTP update, subject-scoped: DELETE WHERE for the subject + INSERT DATA,
    // no whole-graph staging/MOVE (that would clobber the other jobs in the graph).
    expect(insertedQuads).toHaveLength(1);
    expect(insertedQuads[0]).toContain('DELETE WHERE');
    expect(insertedQuads[0]).toContain('<http://ex.org/job> ?p ?o');
    expect(insertedQuads[0]).toContain('INSERT DATA');
    expect(insertedQuads[0]).toContain('<http://ex.org/g1>');
    expect(insertedQuads[0]).not.toContain('MOVE GRAPH');
  });

  it('replaceSubject fails closed for endpoints without a declared atomicity guarantee', async () => {
    insertedQuads.length = 0;
    const replacement = [{
      subject: 'http://ex.org/job',
      predicate: 'http://ex.org/p',
      object: '"new"',
      graph: 'http://ex.org/g1',
    }];
    // A generic endpoint may apply DELETE WHERE; INSERT DATA sequentially, so the
    // adapter must refuse BEFORE sending any update → callers take the fallback.
    await expect(store.replaceSubject!('http://ex.org/g1', 'http://ex.org/job', replacement))
      .rejects.toMatchObject({
        name: 'UnsupportedTripleStoreCapabilityError',
        capability: 'replaceSubject',
      });
    await expect(tryReplaceSubjectAtomically(store, 'http://ex.org/g1', 'http://ex.org/job', replacement))
      .resolves.toBe(false);
    expect(insertedQuads).toHaveLength(0);

    // Daemon-owned endpoints are oxigraph-server (transactional) and keep it.
    const managedStore = new SparqlHttpStore({
      queryEndpoint: queryUrl,
      updateEndpoint: updateUrl,
      managedByDkg: true,
    });
    await expect(tryReplaceSubjectAtomically(managedStore, 'http://ex.org/g1', 'http://ex.org/job', replacement))
      .resolves.toBe(true);
    expect(insertedQuads).toHaveLength(1);
  });

  it('advances write generation when an atomic replace has an indeterminate remote failure', async () => {
    const graph = 'http://ex.org/possibly-committed';
    const metaGraph = 'http://ex.org/possibly-committed/meta';
    const subject = 'http://ex.org/job';
    const replacement = [{
      subject,
      predicate: 'http://ex.org/p',
      object: '"new"',
      graph,
    }];
    const cases: Array<{
      affected: string[];
      attempt(store: SparqlHttpStore): Promise<void>;
    }> = [
      {
        affected: [graph],
        attempt: (store) => store.replaceGraph(graph, replacement),
      },
      {
        affected: [graph, metaGraph],
        attempt: (store) => store.replaceGraphAndSubject(
          graph,
          replacement,
          metaGraph,
          subject,
          [{ ...replacement[0], graph: metaGraph }],
        ),
      },
      {
        affected: [graph],
        attempt: (store) => store.replaceSubject(graph, subject, replacement),
      },
    ];

    for (const testCase of cases) {
      // A fresh store per method proves each mutation independently marks all
      // of its own scopes; an earlier indeterminate failure cannot make a later
      // assertion vacuous.
      const failedStore = new SparqlHttpStore({
        queryEndpoint: queryUrl,
        updateEndpoint: updateUrl.replace('/update', '/error-update'),
        atomicUpdates: true,
      });
      const before = failedStore.getWriteRevision('');
      await expect(testCase.attempt(failedStore)).rejects.toThrow();
      for (const scope of testCase.affected) {
        const after = failedStore.getWriteRevision(scope);
        expect(after.generation).toBeGreaterThan(before.generation);
        expect(after.stable).toBe(false);
        expect(failedStore.getWriteRevision(scope)).toEqual(after);
      }
    }
  });

  it('brackets an insert at dispatch and successful remote settlement', async () => {
    const originalFetch = globalThis.fetch;
    let releaseResponse!: () => void;
    let markDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => { markDispatched = resolve; });
    const response = new Promise<Response>((resolve) => {
      releaseResponse = () => resolve(new Response('', { status: 200 }));
    });
    globalThis.fetch = (async () => {
      markDispatched();
      return response;
    }) as typeof fetch;
    try {
      const pendingStore = new SparqlHttpStore({
        queryEndpoint: 'http://pending.test/query',
        updateEndpoint: 'http://pending.test/update',
        atomicUpdates: true,
      });
      const graph = 'http://ex.org/pending-commit';
      const quads = [{
        subject: 'http://ex.org/s',
        predicate: 'http://ex.org/p',
        object: '"new"',
        graph,
      }];
      const before = pendingStore.getWriteRevision(graph);
      const inserting = pendingStore.insert(quads);
      await dispatched;
      const whilePending = pendingStore.getWriteRevision(graph);
      expect(whilePending.generation).toBeGreaterThan(before.generation);
      expect(whilePending.stable).toBe(false);
      expect(pendingStore.getWriteRevision(graph)).toEqual(whilePending);

      releaseResponse();
      await inserting;
      const settled = pendingStore.getWriteRevision(graph);
      expect(settled.generation).toBeGreaterThan(whilePending.generation);
      expect(settled.stable).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('begins a lifecycle before every public remote mutation dispatch', async () => {
    const originalFetch = globalThis.fetch;
    const graph = 'http://ex.org/tracked-dispatch';
    const metaGraph = `${graph}/meta`;
    const subject = 'http://ex.org/subject';
    const quad = {
      subject,
      predicate: 'http://ex.org/p',
      object: '"value"',
      graph,
    };
    const cases: Array<{
      name: string;
      scope: string;
      attempt(store: SparqlHttpStore): Promise<unknown>;
    }> = [
      { name: 'insert', scope: graph, attempt: (store) => store.insert([quad]) },
      { name: 'delete', scope: graph, attempt: (store) => store.delete([quad]) },
      {
        name: 'deleteByPattern',
        scope: graph,
        attempt: (store) => store.deleteByPattern({ subject, graph }),
      },
      {
        name: 'deleteBySubjectPrefix',
        scope: graph,
        attempt: (store) => store.deleteBySubjectPrefix(graph, subject),
      },
      {
        name: 'update',
        scope: graph,
        attempt: (store) => store.update('DELETE WHERE { GRAPH ?g { ?s ?p ?o } }'),
      },
      {
        name: 'replaceGraph',
        scope: graph,
        attempt: (store) => store.replaceGraph(graph, [quad]),
      },
      {
        name: 'replaceGraphAndSubject',
        scope: metaGraph,
        attempt: (store) => store.replaceGraphAndSubject(
          graph,
          [quad],
          metaGraph,
          subject,
          [{ ...quad, graph: metaGraph }],
        ),
      },
      {
        name: 'replaceSubject',
        scope: graph,
        attempt: (store) => store.replaceSubject(graph, subject, [quad]),
      },
      { name: 'dropGraph', scope: graph, attempt: (store) => store.dropGraph(graph) },
    ];

    try {
      for (const testCase of cases) {
        let markDispatched!: () => void;
        let releaseResponse!: () => void;
        const dispatched = new Promise<void>((resolve) => { markDispatched = resolve; });
        const response = new Promise<Response>((resolve) => {
          releaseResponse = () => resolve(new Response('', { status: 200 }));
        });
        globalThis.fetch = (async (input: string | URL | Request) => {
          if (String(input).includes('/query')) {
            return new Response(JSON.stringify({
              head: { vars: ['c'] },
              results: { bindings: [{ c: { type: 'literal', value: '1' } }] },
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/sparql-results+json' },
            });
          }
          markDispatched();
          return response;
        }) as typeof fetch;

        const pendingStore = new SparqlHttpStore({
          queryEndpoint: 'http://tracked.test/query',
          updateEndpoint: 'http://tracked.test/update',
          atomicUpdates: true,
        });
        const before = pendingStore.getWriteRevision(testCase.scope);
        const mutation = testCase.attempt(pendingStore);
        await dispatched;
        const pending = pendingStore.getWriteRevision(testCase.scope);
        expect(pending.generation, testCase.name).toBeGreaterThan(before.generation);
        expect(pending.stable, testCase.name).toBe(false);

        releaseResponse();
        await mutation;
        const settled = pendingStore.getWriteRevision(testCase.scope);
        expect(settled.generation, testCase.name).toBeGreaterThan(pending.generation);
        expect(settled.stable, testCase.name).toBe(true);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps raw updates globally unstable while pending and after an indeterminate failure', async () => {
    const originalFetch = globalThis.fetch;
    let releaseResponse!: () => void;
    let markDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => { markDispatched = resolve; });
    const response = new Promise<Response>((resolve) => {
      releaseResponse = () => resolve(new Response('', { status: 200 }));
    });
    globalThis.fetch = (async () => {
      markDispatched();
      return response;
    }) as typeof fetch;
    try {
      const pendingStore = new SparqlHttpStore({
        queryEndpoint: 'http://pending-update.test/query',
        updateEndpoint: 'http://pending-update.test/update',
      });
      const firstPrefix = 'http://ex.org/first/';
      const secondPrefix = 'http://ex.org/second/';
      const updating = pendingStore.update('DELETE WHERE { GRAPH ?g { ?s ?p ?o } }');
      await dispatched;

      const firstPending = pendingStore.getWriteRevision(firstPrefix);
      const secondPending = pendingStore.getWriteRevision(secondPrefix);
      expect(firstPending.stable).toBe(false);
      expect(secondPending).toEqual(firstPending);
      expect(pendingStore.getWriteRevision(firstPrefix)).toEqual(firstPending);

      releaseResponse();
      await updating;
      expect(pendingStore.getWriteRevision(firstPrefix).stable).toBe(true);
      expect(pendingStore.getWriteRevision(secondPrefix).stable).toBe(true);

      globalThis.fetch = (async () => new Response('failed', { status: 500 })) as typeof fetch;
      const failedStore = new SparqlHttpStore({
        queryEndpoint: 'http://failed-update.test/query',
        updateEndpoint: 'http://failed-update.test/update',
      });
      await expect(failedStore.update('CLEAR ALL')).rejects.toThrow(/failed \(500\)/u);
      const indeterminate = failedStore.getWriteRevision(firstPrefix);
      expect(indeterminate.stable).toBe(false);
      expect(failedStore.getWriteRevision(secondPrefix)).toEqual(indeterminate);
      expect(failedStore.getWriteRevision(firstPrefix)).toEqual(indeterminate);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps a write stable when managed recovery rejects it before dispatch', async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      const graph = 'http://ex.org/not-started';
      const recoveringStore = new SparqlHttpStore({
        queryEndpoint: 'http://managed-oxigraph.test/query',
        updateEndpoint: 'http://managed-oxigraph.test/update',
        managedOxigraph: true,
        atomicUpdates: true,
        getRecoveryState: () => ({ recovering: true, generation: 1 }),
      });
      const before = recoveringStore.getWriteRevision(graph);
      await expect(recoveringStore.replaceSubject(graph, 'http://ex.org/s', [])).rejects
        .toMatchObject({ outcome: 'not_started' });
      expect(recoveringStore.getWriteRevision(graph)).toEqual(before);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

    it('invalidates a managed listGraphs refresh at mutation dispatch and settlement', async () => {
      const originalFetch = globalThis.fetch;
      let visibleGraphs = ['http://ex.org/old'];
      let queryCalls = 0;
      let markUpdateDispatched!: () => void;
      let resolveUpdate!: () => void;
      const updateDispatched = new Promise<void>((resolve) => {
        markUpdateDispatched = resolve;
      });
      const updateResponse = new Promise<Response>((resolve) => {
        resolveUpdate = () => resolve(new Response('', { status: 200 }));
      });
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = String(init?.body ?? '');
        if (body.includes('GRAPH ?g {}')) {
          queryCalls += 1;
          return new Response(JSON.stringify({
            head: { vars: ['g'] },
            results: {
              bindings: visibleGraphs.map((value) => ({ g: { type: 'uri', value } })),
            },
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/sparql-results+json' },
          });
        }
        markUpdateDispatched();
        return updateResponse;
      }) as typeof fetch;
      try {
        const managedStore = new SparqlHttpStore({
          queryEndpoint: 'http://managed.test/query',
          updateEndpoint: 'http://managed.test/update',
          managedByDkg: true,
        });
        await expect(managedStore.listGraphs()).resolves.toEqual(['http://ex.org/old']);
        expect(queryCalls).toBe(1);

        const inserting = managedStore.insert([{
          subject: 'http://ex.org/s',
          predicate: 'http://ex.org/p',
          object: '"v"',
          graph: 'http://ex.org/new',
        }]);
        await updateDispatched;

        // The dispatch invalidates the pre-write cache. This refresh still
        // sees the old backend state and must be invalidated again at settle.
        await expect(managedStore.listGraphs()).resolves.toEqual(['http://ex.org/old']);
        expect(queryCalls).toBe(2);

        visibleGraphs = ['http://ex.org/new'];
        resolveUpdate();
        await inserting;

        await expect(managedStore.listGraphs()).resolves.toEqual(['http://ex.org/new']);
        expect(queryCalls).toBe(3);
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

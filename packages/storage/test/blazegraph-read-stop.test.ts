import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { withBlazegraphQueryId } from '../src/adapters/blazegraph-read-stop.js';

// Wire format of a Blazegraph read with a work deadline. The live suite
// (blazegraph.integration.test.ts) proves the server really stops; this one pins
// what the adapter sends, with no server.

const ENDPOINT = 'http://blazegraph.test/bigdata/namespace/kb/sparql';
const HINT = '<http://www.bigdata.com/queryHints#Query> <http://www.bigdata.com/queryHints#queryId>';

interface Sent { url: string; body: string; headers: Record<string, string> }

describe('withBlazegraphQueryId', () => {
  it.each([
    ['SELECT ?s WHERE { ?s ?p ?o }', `SELECT ?s WHERE { ${HINT} "ID" .  ?s ?p ?o }`],
    ['ASK { ?s ?p ?o }', `ASK { ${HINT} "ID" .  ?s ?p ?o }`],
    ['CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', `CONSTRUCT { ?s ?p ?o } WHERE { ${HINT} "ID" .  ?s ?p ?o }`],
    ['SELECT * WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }', `SELECT * WHERE { ${HINT} "ID" .  { SELECT ?s WHERE { ?s ?p ?o } } }`],
  ])('adds the hint to the top-level WHERE group of %s', (query, expected) => {
    expect(withBlazegraphQueryId(query, 'ID')).toEqual({ queryId: 'ID', sparql: expected });
  });

  it.each([
    'CONSTRUCT WHERE { ?s ?p ?o }',
    'DESCRIBE <urn:x>',
    'SELECT * WHERE { SELECT ?s WHERE { ?s ?p ?o } LIMIT 3 }',
    'SELECT * WHERE { ?s ?p "queryId" }',
  ])('leaves %s alone, so it stops at its server deadline only', (query) => {
    expect(withBlazegraphQueryId(query, 'ID')).toBeNull();
  });
});

describe('BlazegraphStore read with a work deadline', () => {
  const originalFetch = globalThis.fetch;
  let sent: Sent[];
  let answer: (sent: Sent, signal: AbortSignal | undefined) => Promise<Response>;

  beforeEach(() => {
    sent = [];
    answer = async () => new Response(JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }), { status: 200 });
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const request = { url: String(input), body: String(init?.body ?? ''), headers: { ...(init?.headers as Record<string, string>) } };
      sent.push(request);
      return answer(request, init?.signal ?? undefined);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends the limit as the server deadline, plus a margin, and an engine query id', async () => {
    const store = new BlazegraphStore(ENDPOINT, { timeout: 30_000 });
    await store.query('SELECT ?s WHERE { ?s ?p ?o }', { workDeadline: performance.now() + 5_000 });
    const [request] = sent;
    expect(request.url).toBe(ENDPOINT);
    expect(request.body).toMatch(new RegExp(`^SELECT \\?s WHERE \\{ ${HINT.replace(/[.?*+^$[\]\\(){}|-]/g, '\\$&')} "[0-9a-f-]{36}" \\.`));
    const serverMs = Number(request.headers['X-BIGDATA-MAX-QUERY-MILLIS']);
    expect(serverMs).toBeGreaterThan(5_500);
    expect(serverMs).toBeLessThanOrEqual(6_000);
  });

  it('keeps the wide server deadline and the plain query without a work deadline', async () => {
    const store = new BlazegraphStore(ENDPOINT, { timeout: 30_000 });
    await store.query('SELECT ?s WHERE { ?s ?p ?o }');
    expect(sent[0].body).toBe('SELECT ?s WHERE { ?s ?p ?o }');
    expect(sent[0].headers['X-BIGDATA-MAX-QUERY-MILLIS']).toBe('120000');
  });

  it('cancels the server query by its id when the caller leaves, and says it stopped it', async () => {
    answer = (_request, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const store = new BlazegraphStore(ENDPOINT, { timeout: 30_000 });
    const controller = new AbortController();
    const reason = new Error('caller left');
    const pending = store.query('SELECT ?s WHERE { ?s ?p ?o }', { workDeadline: performance.now() + 60_000, signal: controller.signal });
    await expect.poll(() => sent.length).toBe(1);
    const queryId = /"([0-9a-f-]{36})"/.exec(sent[0].body)![1];
    answer = async () => new Response('', { status: 200 });
    controller.abort(reason);
    await expect(pending).rejects.toMatchObject({ code: 'QUERY_WORK_STOPPED', outcome: 'stopped', cause: reason });
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].url).toBe(`${ENDPOINT}?cancelQuery&queryId=${queryId}`);
  });

  it('cancels nothing after the read has answered', async () => {
    const store = new BlazegraphStore(ENDPOINT, { timeout: 30_000 });
    const controller = new AbortController();
    await store.query('SELECT ?s WHERE { ?s ?p ?o }', { workDeadline: performance.now() + 60_000, signal: controller.signal });
    controller.abort(new Error('late'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
  });

  it('gives up at the work deadline when it comes before the store timeout', async () => {
    answer = (_request, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const store = new BlazegraphStore(ENDPOINT, { timeout: 30_000 });
    const startedAt = performance.now();
    await expect(store.query('SELECT ?s WHERE { ?s ?p ?o }', { workDeadline: performance.now() + 80 }))
      .rejects.toMatchObject({ code: 'QUERY_WORK_STOPPED', outcome: 'stopped' });
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    await expect.poll(() => sent.some((request) => request.url.includes('?cancelQuery&queryId='))).toBe(true);
  });
});

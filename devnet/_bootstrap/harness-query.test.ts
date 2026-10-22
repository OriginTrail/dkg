// The request `queryNode` sends and the response shapes it decodes. Every
// devnet suite that reads through `POST /api/query` goes through this helper, so
// the request body is pinned here without a devnet: a new option (`assertionName`)
// must not change what a query that does not use it sends, and the three response
// shapes and the status-and-body diagnostics must keep working for all of them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildQueryBody, queryNode, type DevnetNode, type QueryOpts } from './harness.js';

const NODE = { num: 3, apiPort: 9203, authToken: 'secret-token' } as unknown as DevnetNode;

/** The body the helper built before `assertionName`, verbatim: the oracle for "purely additive". */
function bodyBeforeAssertionName(sparql: string, opts: Omit<QueryOpts, 'assertionName'> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { sparql };
  if (opts.contextGraphId) body.contextGraphId = opts.contextGraphId;
  if (opts.view) body.view = opts.view;
  if (opts.subGraphName) body.subGraphName = opts.subGraphName;
  return body;
}

describe('buildQueryBody', () => {
  const SPARQL = 'SELECT ?s WHERE { ?s ?p ?o }';

  it('sends exactly what it sent before assertionName for every combination of the existing options', () => {
    const values = <T,>(set: T): Array<T | undefined | ''> => [undefined, '', set];
    let combinations = 0;
    for (const contextGraphId of values('devnet-test')) {
      for (const view of values('working-memory')) {
        for (const subGraphName of values('sub-1')) {
          const opts = { contextGraphId, view, subGraphName } as Omit<QueryOpts, 'assertionName'>;
          expect(JSON.stringify(buildQueryBody(SPARQL, opts))).toBe(JSON.stringify(bodyBeforeAssertionName(SPARQL, opts)));
          combinations += 1;
        }
      }
    }
    expect(combinations).toBe(27);
    expect(JSON.stringify(buildQueryBody(SPARQL))).toBe(JSON.stringify({ sparql: SPARQL }));
  });

  it('pins the body of a query that sets every existing option', () => {
    expect(JSON.stringify(buildQueryBody(SPARQL, { contextGraphId: 'cg', view: 'shared-working-memory', subGraphName: 'sg' })))
      .toBe('{"sparql":"SELECT ?s WHERE { ?s ?p ?o }","contextGraphId":"cg","view":"shared-working-memory","subGraphName":"sg"}');
  });

  it('forwards assertionName after the existing options, and only when it is set', () => {
    expect(JSON.stringify(buildQueryBody(SPARQL, { contextGraphId: 'agent-context', view: 'working-memory', assertionName: 'chat-turns' })))
      .toBe('{"sparql":"SELECT ?s WHERE { ?s ?p ?o }","contextGraphId":"agent-context","view":"working-memory","assertionName":"chat-turns"}');
    expect(buildQueryBody(SPARQL, { subGraphName: 'sg', assertionName: 'a' })).toEqual({ sparql: SPARQL, subGraphName: 'sg', assertionName: 'a' });
    expect(buildQueryBody(SPARQL, { assertionName: '' })).toEqual({ sparql: SPARQL });
    expect(buildQueryBody(SPARQL, { assertionName: undefined })).toEqual({ sparql: SPARQL });
  });
});

describe('queryNode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stub `fetch` with one canned answer and capture what `queryNode` sends. */
  function answering(status: number, json: unknown) {
    const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(json), { status });
    }));
    return requests;
  }

  const ROW = { s: '<urn:a>', o: '"1"' };

  it.each([
    ['the current daemon shape (result.bindings)', { result: { bindings: [ROW] } }],
    ['SPARQL 1.1 JSON (results.bindings)', { results: { bindings: [ROW] } }],
    ['the legacy flat shape (bindings)', { bindings: [ROW] }],
  ])('returns the bindings of %s', async (_label, json) => {
    answering(200, json);

    await expect(queryNode(NODE, 'SELECT ?s ?o WHERE { ?s ?p ?o }')).resolves.toEqual([ROW]);
  });

  it('sends the built body to /api/query with the node bearer token, assertionName included', async () => {
    const requests = answering(200, { result: { bindings: [] } });
    const opts = { contextGraphId: 'agent-context', view: 'working-memory', assertionName: 'chat-turns' };

    await queryNode(NODE, 'SELECT ?s WHERE { ?s ?p ?o }', opts);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://127.0.0.1:9203/api/query');
    expect(requests[0].headers.Authorization).toBe('Bearer secret-token');
    expect(requests[0].body).toEqual(buildQueryBody('SELECT ?s WHERE { ?s ?p ?o }', opts));
    expect(requests[0].body).toHaveProperty('assertionName', 'chat-turns');
  });

  it('keeps assertionName out of the request of a query that does not set it', async () => {
    const requests = answering(200, { bindings: [] });

    await queryNode(NODE, 'SELECT ?s WHERE { ?s ?p ?o }', { contextGraphId: 'devnet-test', view: 'verifiable-memory' });

    expect(requests[0].body).toEqual({ sparql: 'SELECT ?s WHERE { ?s ?p ?o }', contextGraphId: 'devnet-test', view: 'verifiable-memory' });
    expect(requests[0].body).not.toHaveProperty('assertionName');
  });

  it('fails with the node, the status and the body when the query is refused', async () => {
    answering(500, { error: 'store is down' });

    await expect(queryNode(NODE, 'SELECT ?s WHERE { ?s ?p ?o }'))
      .rejects.toThrow('query on node3 failed (500): {"error":"store is down"}');
  });

  it('throws on a 200 it does not recognise instead of reading it as zero rows', async () => {
    answering(200, { unexpected: 'shape' });

    await expect(queryNode(NODE, 'SELECT ?s WHERE { ?s ?p ?o }'))
      .rejects.toThrow('unrecognised /api/query response shape on node3: {"unexpected":"shape"}');
  });
});

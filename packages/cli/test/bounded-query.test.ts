import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { boundSelect, boundedResult } from '../src/daemon/bounded-query.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../../query/src/dkg-query-engine.js';
import { handleBoundedQueryRoutes } from '../src/daemon/routes/bounded-query.js';
import { requestAuthentication } from './_helpers/request-authentication.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function context(agent: Record<string, unknown>, payload: Record<string, unknown> = {}) {
  const req = Object.assign(new EventEmitter(), {
    method: 'POST', aborted: false,
    __dkgPrebufferedBody: Buffer.from(JSON.stringify({ version: 1, contextGraphId: 'test', maxRows: 10,
      sparql: 'SELECT ?s WHERE { ?s <urn:p> ?o }', ...payload })),
  });
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, statusCode: 0, body: '',
    writeHead(status: number) { this.statusCode = status; return this; },
    end(body = '') { this.body = body; this.writableEnded = true; return this; },
  });
  return { ctx: { req, res, agent, path: '/api/query/bounded',
    authentication: requestAuthentication({ kind: 'anonymous' }),
  } as unknown as RequestContext, req, res };
}

describe('bounded local query contract', () => {
  it('executes a SELECT with an overflow witness instead of silently truncating a security decision', async () => {
    const store = new OxigraphStore();
    await store.insert([
      { subject: 'urn:a', predicate: 'urn:p', object: '"one"', graph: 'urn:g' },
      { subject: 'urn:b', predicate: 'urn:p', object: '"two"', graph: 'urn:g' },
    ]);
    try {
      const bounded = boundSelect('SELECT ?s WHERE { GRAPH <urn:g> { ?s <urn:p> ?o } } # trailing comment', 1);
      const result = await store.query(bounded.sparql);
      expect(result.type).toBe('bindings');
      if (result.type !== 'bindings') throw new Error('expected bindings');
      expect(boundedResult(result.bindings, 1)).toEqual({ ok: false, code: 'QUERY_RESULT_TOO_LARGE' });
      const complete = boundedResult(result.bindings, 2);
      expect(complete.ok).toBe(true);
      expect(boundedResult([], 2)).toEqual({ ok: true, result: { type: 'bindings', bindings: [] } });
    } finally { await store.close(); }
  });

  it.each([
    'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
    'SELECT * WHERE { ?s ?p ?o } OFFSET 1',
    'SELECT * WHERE { SERVICE <https://invalid.example> { ?s ?p ?o } }',
    'SELECT * FROM <urn:g> WHERE { ?s ?p ?o }',
    'DELETE WHERE { ?s ?p ?o }',
    'ASK { ?s ?p ?o }',
  ])('refuses unsupported query contracts: %s', query => {
    expect(() => boundSelect(query, 100)).toThrow();
  });

  it('keeps query scope, denial, empty success, overflow and deadline distinguishable at the route', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      { subject: 'urn:own', predicate: 'urn:p', object: '"one"', graph: 'did:dkg:context-graph:test' },
      { subject: 'urn:other', predicate: 'urn:p', object: '"two"', graph: 'did:dkg:context-graph:other' },
      { subject: 'urn:asset', predicate: 'urn:assertionGraph', object: 'did:dkg:context-graph:test/_verifiable_memory/a', graph: 'did:dkg:context-graph:test/_meta' },
      { subject: 'urn:verified', predicate: 'urn:p', object: '"verified"', graph: 'did:dkg:context-graph:test/_verifiable_memory/a' },
    ]);
    const storeRead = vi.spyOn(store, 'query');
    const agent = { query: vi.fn(engine.query.bind(engine)) };
    try {
      const read = context(agent);
      await handleBoundedQueryRoutes(read.ctx);
      expect(read.res.statusCode).toBe(200);
      const body = JSON.parse(read.res.body);
      expect(body).toMatchObject({ version: 1, resultComplete: true, coverage: 'local-only' });
      expect(body.result.bindings.map(row => row.s).sort()).toEqual(['urn:own', 'urn:verified']);
      expect(storeRead.mock.calls.some(([, opts]) => opts?.maxResponseBytes === 1024 * 1024)).toBe(true);
      const page = context(agent, { mode: 'page', maxRows: 1, sparql: 'SELECT ?s WHERE { ?s <urn:p> ?o } ORDER BY ?s' });
      await handleBoundedQueryRoutes(page.ctx);
      expect(JSON.parse(page.res.body)).toMatchObject({ mode: 'page', resultComplete: false,
        pageComplete: true, hasMore: true, nextOffset: 1, result: { bindings: [{ s: 'urn:own' }] } });
      const next = context(agent, { mode: 'page', maxRows: 1, offset: 1, sparql: 'SELECT ?s WHERE { ?s <urn:p> ?o } ORDER BY ?s' });
      await handleBoundedQueryRoutes(next.ctx);
      expect(JSON.parse(next.res.body)).toMatchObject({ pageComplete: true, hasMore: false,
        nextOffset: 2, result: { bindings: [{ s: 'urn:verified' }] } });
      const partition = context(agent, { includeContextGraphPartitions: true,
        sparql: `SELECT ?sourceGraph ?s WHERE {
          GRAPH <did:dkg:context-graph:test/_meta> { ?asset <urn:assertionGraph> ?sourceGraph }
          GRAPH ?sourceGraph { ?s <urn:p> ?value }
        }`,
      });
      await handleBoundedQueryRoutes(partition.ctx);
      expect(partition.res.statusCode, partition.res.body).toBe(200);
      expect(JSON.parse(partition.res.body).result.bindings).toEqual([
        { sourceGraph: 'did:dkg:context-graph:test/_verifiable_memory/a', s: 'urn:verified' },
      ]);
      expect(agent.query.mock.calls[0][1]).toMatchObject({ maxResponseBytes: 1024 * 1024 });
      expect(agent.query.mock.calls[0][1]).toMatchObject({ accessDenied: 'error', redactQuery: true });
      agent.query.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'QUERY_ACCESS_DENIED' }));
      const denied = context(agent);
      await handleBoundedQueryRoutes(denied.ctx);
      expect(denied.res.statusCode).toBe(403);
      expect(JSON.parse(denied.res.body).result).toBeUndefined();
      const empty = context(agent, { sparql: 'SELECT ?s WHERE { ?s <urn:absent> ?o }' });
      await handleBoundedQueryRoutes(empty.ctx);
      expect(JSON.parse(empty.res.body).result.bindings).toEqual([]);
      agent.query.mockRejectedValueOnce(Object.assign(new Error('too large'), { code: 'STORE_RESPONSE_TOO_LARGE' }));
      const oversized = context(agent);
      await handleBoundedQueryRoutes(oversized.ctx);
      expect(oversized.res.statusCode).toBe(422);
      expect(JSON.parse(oversized.res.body).code).toBe('QUERY_RESULT_TOO_LARGE');
      const timeout = context({ ...agent, query: async (_q: string, opts: { signal: AbortSignal }) => {
        await new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
      } }, { timeoutMs: 20 });
      await handleBoundedQueryRoutes(timeout.ctx);
      expect(timeout.res.statusCode).toBe(503);
      expect(JSON.parse(timeout.res.body).code).toBe('QUERY_DEADLINE_EXCEEDED');
      expect(timeout.req.listenerCount('aborted')).toBe(0);
      expect(timeout.res.listenerCount('close')).toBe(0);
    } finally { await store.close(); }
  });
});

// Real embedded execution must not return a late success before timers run.
it('rejects synchronous store results completed after the absolute deadline', async () => {
  const store = new OxigraphStore();
  await store.insert(Array.from({ length: 300 }, (_, n) => ({
    subject: `urn:s:${n}`, predicate: 'urn:p', object: '"x"', graph: 'did:dkg:context-graph:test',
  })));
  try {
    const engine = new DKGQueryEngine(store);
    const read = context({ query: engine.query.bind(engine) }, { timeoutMs: 1,
      sparql: 'SELECT (COUNT(*) AS ?n) WHERE { GRAPH <did:dkg:context-graph:test> { ?a <urn:p> ?o . ?b <urn:p> ?o } }',
    });
    await handleBoundedQueryRoutes(read.ctx);
    expect(read.res.statusCode).toBe(503);
    expect(JSON.parse(read.res.body).code).toBe('QUERY_DEADLINE_EXCEEDED');
  } finally { await store.close(); }
});

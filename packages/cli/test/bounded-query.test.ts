import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { boundSelect, boundedResult } from '../src/daemon/bounded-query.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../../query/src/dkg-query-engine.js';
import { QueryMethods } from '../../agent/src/dkg-agent-query.js';
import { LifecycleSyncMethods } from '../../agent/src/dkg-agent-lifecycle.js';
import { handleBoundedQueryRoutes } from '../src/daemon/routes/bounded-query.js';
import { requestAuthentication } from './_helpers/request-authentication.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function context(agent: Record<string, unknown>, payload: Record<string, unknown> = {}, agentAddress?: string) {
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
    authentication: requestAuthentication(agentAddress ? { kind: 'agent', agentAddress } : { kind: 'anonymous' }),
  } as unknown as RequestContext, req, res };
}

it.each([
  { maxRows: 8193 }, { timeoutMs: 2001 }, { mode: 'page', offset: 1_000_001 },
  { sparql: 'SELECT ?s WHERE { ?s ?p ?o }'.padEnd(64 * 1024 + 1) },
])('rejects an over-limit request before querying: %j', async payload => {
  const query = vi.fn();
  const read = context({ query }, payload);
  await handleBoundedQueryRoutes(read.ctx);
  expect(read.res.statusCode).toBe(400);
  expect(JSON.parse(read.res.body).code).toBe('BOUNDED_QUERY_INVALID_REQUEST');
  expect(query).not.toHaveBeenCalled();
});

it.each([
  { maxRows: 8192 }, { timeoutMs: 2000 },
  { mode: 'page', offset: 1_000_000, sparql: 'SELECT ?s WHERE { ?s ?p ?o } ORDER BY ?s' },
  { sparql: 'SELECT ?s WHERE { ?s ?p ?o }'.padEnd(64 * 1024) },
])('accepts requests exactly at a hard ceiling: %j', async payload => {
  const query = vi.fn(async () => ({ bindings: [] }));
  const read = context({ query }, payload);
  await handleBoundedQueryRoutes(read.ctx);
  expect(read.res.statusCode).toBe(200);
  expect(query).toHaveBeenCalledOnce();
});

it.each([
  { offset: 999_998, count: 3, nextOffset: 1_000_000, hasMore: true, pagingLimitReached: false },
  { offset: 999_999, count: 3, nextOffset: null, hasMore: true, pagingLimitReached: true },
  { offset: 1_000_000, count: 3, nextOffset: null, hasMore: true, pagingLimitReached: true },
  { offset: 1_000_000, count: 1, nextOffset: null, hasMore: false, pagingLimitReached: false },
])('distinguishes dataset exhaustion from the offset ceiling: $offset / $count', async example => {
  const query = vi.fn(async () => ({ bindings: Array.from({ length: example.count }, (_, n) => ({ s: `urn:${n}` })) }));
  const read = context({ query }, { mode: 'page', maxRows: 2, offset: example.offset,
    sparql: 'SELECT ?s WHERE { ?s ?p ?o } ORDER BY ?s' });
  await handleBoundedQueryRoutes(read.ctx);
  expect(read.res.statusCode).toBe(200);
  expect(JSON.parse(read.res.body)).toMatchObject({ hasMore: example.hasMore,
    nextOffset: example.nextOffset, pagingLimitReached: example.pagingLimitReached });
});

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


it.each(['complete', 'page'] as const)('executes %s queries with trailing VALUES and comments', async mode => {
  const store = new OxigraphStore();
  try {
    const read = context({ query: async (q: string) => store.query(q) }, { mode, maxRows: 1,
      offset: mode === 'page' ? 1 : 0,
      sparql: 'SELECT ?s WHERE { } ORDER BY ?s # modifier comment\nVALUES ?s { <urn:a> <urn:b> } # final comment',
    });
    await handleBoundedQueryRoutes(read.ctx);
    if (mode === 'complete') {
      expect(read.res.statusCode).toBe(422);
      expect(JSON.parse(read.res.body)).toMatchObject({ code: 'QUERY_RESULT_TOO_LARGE' });
      expect(JSON.parse(read.res.body)).not.toHaveProperty('result');
    } else {
      expect(read.res.statusCode).toBe(200);
      expect(JSON.parse(read.res.body)).toMatchObject({ result: { bindings: [{ s: 'urn:b' }] }, hasMore: false, nextOffset: 2 });
    }
  } finally { await store.close(); }
});

it.each([
  'SELECT ?s WHERE { ?s ?p ?o }',
  'SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } ORDER BY ?s } }',
])('rejects page requests without outer ordering: %s', async sparql => {
  const query = vi.fn();
  const read = context({ query }, { mode: 'page', sparql });
  await handleBoundedQueryRoutes(read.ctx);
  expect(read.res.statusCode).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

it('rejects oversized materialized bindings even below the row limit', async () => {
  const read = context({ query: async () => ({ bindings: [{ value: 'x'.repeat(1024 * 1024) }] }) });
  await handleBoundedQueryRoutes(read.ctx);
  expect(read.res.statusCode).toBe(422);
  expect(JSON.parse(read.res.body)).toMatchObject({ code: 'QUERY_RESULT_TOO_LARGE' });
  expect(JSON.parse(read.res.body)).not.toHaveProperty('result');
});

it('bounds stalled shared-memory metadata admission and prevents a late caller query', async () => {
  let release!: (value: { type: 'boolean'; value: boolean }) => void;
  const pending = new Promise<{ type: 'boolean'; value: boolean }>(resolve => { release = resolve; });
  const metadata = vi.fn(async () => pending);
  const callerQuery = vi.fn(async () => ({ bindings: [] }));
  const agent = {
    queryEngine: { query: callerQuery }, log: { info() {} },
    resolveContextGraphReadAuthority: async () => ({ outcome: 'allowed', grantScope: 'public', source: 'registered-chain', reason: 'public' }),
    resolveAcceptedRfc64SharedMemoryAuthorityV1: () => undefined,
    canUseSharedMemoryForContextGraph: LifecycleSyncMethods.prototype.canUseSharedMemoryForContextGraph,
    hasConfirmedSharedMemoryMetaState: LifecycleSyncMethods.prototype.hasConfirmedSharedMemoryMetaState,
    hasConfirmedMetaState: LifecycleSyncMethods.prototype.hasConfirmedMetaState,
    store: { query: metadata }, chain: {}, peerId: 'fixture',
    localApprovedAgentByCG: new Map(), subscribedContextGraphs: new Map(),
    isPrivateContextGraph: async () => false,
  };
  const read = context({ query: QueryMethods.prototype.query.bind(agent as never) }, {
    view: 'shared-working-memory', timeoutMs: 20,
  });
  const started = performance.now();
  await handleBoundedQueryRoutes(read.ctx);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(read.res.statusCode).toBe(503);
  expect(JSON.parse(read.res.body).code).toBe('QUERY_DEADLINE_EXCEEDED');
  expect(metadata.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  release({ type: 'boolean', value: true });
  await new Promise(resolve => setImmediate(resolve));
  expect(callerQuery).not.toHaveBeenCalled();
  expect(read.req.listenerCount('aborted')).toBe(0);
  expect(read.res.listenerCount('close')).toBe(0);
});


it.each(['finalized-name-absence-unaccepted', 'authority-circuit-open'])(
  'returns retryable 503 for unavailable authority: %s', async reason => {
    const read = context({ query: async () => { throw Object.assign(new Error('unavailable'), {
      code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE', retryable: true,
      source: 'registered-chain', reason, contextGraphId: 'test',
    }); } });
    await handleBoundedQueryRoutes(read.ctx);
    expect(read.res.statusCode).toBe(503);
    expect(JSON.parse(read.res.body)).toMatchObject({ code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE', retryable: true });
    expect(JSON.parse(read.res.body)).not.toHaveProperty('result');
  },
);


it('forwards the authenticated caller and response ceiling through scoped agent admission', async () => {
  const store = new OxigraphStore();
  const engine = new DKGQueryEngine(store);
  const storeRead = vi.spyOn(store, 'query');
  const execute = vi.spyOn(engine, 'query');
  // Explicit private authority fixture; scoped admission and the query engine
  // below are production code, including the route's identity handoff.
  const authority = vi.fn(async (_id: string, options: { callerAgentAddress?: string }) => ({
    outcome: options.callerAgentAddress === 'member' ? 'allowed' : 'denied',
    grantScope: options.callerAgentAddress === 'member' ? 'caller' : 'none',
    source: 'registered-chain', reason: 'private-roster', metadataBootstrap: 'forbidden',
  }));
  const agent = { queryEngine: engine, log: { info() {} }, peerId: 'fixture',
    resolveContextGraphReadAuthority: authority, subscribedContextGraphs: new Map() };
  const routeAgent = { query: QueryMethods.prototype.query.bind(agent as never) };
  try {
    await store.insert([{ subject: 'urn:allowed', predicate: 'urn:p', object: '"value"',
      graph: 'did:dkg:context-graph:test' }]);
    const member = context(routeAgent, {}, 'member');
    await handleBoundedQueryRoutes(member.ctx);
    expect(member.res.statusCode, member.res.body).toBe(200);
    expect(JSON.parse(member.res.body).result.bindings).toEqual([{ s: 'urn:allowed' }]);
    expect(authority.mock.calls[0][1]).toMatchObject({ callerAgentAddress: 'member' });
    const callerReads = storeRead.mock.calls.filter(([query]) => query.includes('<urn:p>'));
    expect(callerReads.length).toBeGreaterThan(0);
    for (const [, options] of callerReads) expect(options?.maxResponseBytes).toBe(1024 * 1024);
    execute.mockClear(); storeRead.mockClear();
    const outsider = context(routeAgent, {}, 'outsider');
    await handleBoundedQueryRoutes(outsider.ctx);
    expect(outsider.res.statusCode).toBe(403);
    expect(JSON.parse(outsider.res.body)).toMatchObject({ code: 'QUERY_ACCESS_DENIED' });
    expect(authority.mock.calls[1][1]).toMatchObject({ callerAgentAddress: 'outsider' });
    expect(execute).not.toHaveBeenCalled();
    expect(storeRead).not.toHaveBeenCalled();
  } finally { await store.close(); }
});

it.each(['_working_memory/agent-b/1', 'assertion/agent-b/draft', 'code/_working_memory/agent-b/1', 'code/assertion/agent-b/draft'])('excludes %s drafts and children while preserving valid CG IDs and dashboard scans', async draftTail => {
  const store = new OxigraphStore(), engine = new DKGQueryEngine(store);
  const contextGraphId = 'team/assertion/policies', root = `did:dkg:context-graph:${contextGraphId}`, draft = `${root}/${draftTail}`;
  const graphs = [draft, `${draft}/_named_graph/details`, `${root}/_shared_memory/a`, `${root}/_verifiable_memory/a`, `${root}/_shared_memory/assertion/1`, root];
  const agent = { store, queryEngine: engine, log: { info() {} }, peerId: 'fixture',
    resolveContextGraphReadAuthority: async () => ({ outcome: 'allowed', grantScope: 'public', source: 'registered-chain', reason: 'public' }),
    subscribedContextGraphs: new Map() };
  const query = QueryMethods.prototype.query.bind(agent as never);
  try {
    await store.insert([
      { graph: `${root}/_meta`, subject: 'urn:draft', predicate: 'http://dkg.io/ontology/assertionGraph', object: draft },
      { graph: `${root}/_meta`, subject: `${root}/code`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph' },
      { graph: `${root}/_meta`, subject: `${root}/code`, predicate: 'http://schema.org/name', object: '"code"' },
      ...graphs.map((graph, i) => ({ graph, subject: `urn:item:${i}`, predicate: 'urn:p', object: '"value"' })),
    ]);
    const sparql = 'SELECT ?g ?s WHERE { GRAPH ?g { ?s <urn:p> ?o } }';
    const dashboard = await query(sparql, { contextGraphId, includeContextGraphPartitions: true, callerAgentAddress: 'agent-a' });
    expect(dashboard.bindings.map(row => row.g)).toEqual(expect.arrayContaining(graphs));
    const read = context({ query }, { contextGraphId, sparql, includeContextGraphPartitions: true, excludeWorkingMemoryPartitions: false }, 'agent-a');
    await handleBoundedQueryRoutes(read.ctx);
    expect(read.res.statusCode, read.res.body).toBe(200);
    expect(JSON.parse(read.res.body).result.bindings.map(row => row.g).sort()).toEqual(graphs.slice(2).sort());
  } finally { await store.close(); }
});

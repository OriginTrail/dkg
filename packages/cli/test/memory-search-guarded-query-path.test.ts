import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

// Fan-out 2 of `POST /api/memory/search` used to call `agent.store.query`
// directly with hand-built `STRSTARTS(STR(?g), "<cg>/_working_memory")`-style
// filters. That re-implemented two things the engine already owns — which
// named graphs belong to a memory layer, and which of them the caller may read
// — and it meant the A-1 working-memory isolation `DKGAgent.query` enforces on
// the `working-memory` view never applied to this route.
//
// These tests pin the guarded path: no raw store access, one `agent.query`
// call per memory-layer view, and an agent-scoped caller pinned to its own
// working memory.

function fakeRes() {
  const res: any = { statusCode: 0, body: '', headers: {} as Record<string, string> };
  res.writeHead = (status: number, headers?: Record<string, string>) => {
    res.statusCode = status;
    if (headers) Object.assign(res.headers, headers);
  };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.end = (body: string) => { res.body = body; };
  res.once = (_e: string, _fn: () => void) => res;
  res.removeListener = (_e: string, _fn: () => void) => res;
  res.off = (_e: string, _fn: () => void) => res;
  res.destroyed = false;
  return res;
}

function fakeReq(method: string, body: unknown) {
  return {
    method,
    headers: {},
    once: (_e: string, _fn: () => void) => undefined,
    removeListener: (_e: string, _fn: () => void) => undefined,
    off: (_e: string, _fn: () => void) => undefined,
    aborted: false,
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)),
  } as any;
}

interface QueryCall {
  sparql: string;
  view?: string;
  agentAddress?: string;
  callerAgentAddress?: string;
  contextGraphId?: string;
  signal?: unknown;
  priority?: unknown;
  source?: string;
}

function buildCtx(opts: {
  body: unknown;
  authentication: RequestContext['authentication'];
  localAgents?: string[];
  bindingsFor?: (call: QueryCall) => Array<Record<string, string>> | Promise<Array<Record<string, string>>>;
}) {
  const res = fakeRes();
  const url = new URL('http://127.0.0.1/api/memory/search');
  const calls: QueryCall[] = [];
  let rawStoreQueries = 0;

  const ctx = {
    req: fakeReq('POST', opts.body),
    res,
    agent: {
      resolveContextGraphReadAuthority: async () => ({
        outcome: 'allowed' as const, source: 'registered-chain', reason: 'chain-participant', grantScope: 'caller',
      }),
      canUseSharedMemoryForContextGraph: async () => true,
      listLocalAgents: () => (opts.localAgents ?? []).map((agentAddress) => ({ agentAddress })),
      query: async (sparql: string, o: Record<string, any> = {}) => {
        const call: QueryCall = {
          sparql,
          view: o.view,
          agentAddress: o.agentAddress,
          callerAgentAddress: o.callerAgentAddress,
          contextGraphId: o.contextGraphId,
          signal: o.signal,
          priority: o.priority,
          source: o.source,
        };
        calls.push(call);
        return { bindings: opts.bindingsFor ? await opts.bindingsFor(call) : [] };
      },
      // Must stay untouched — any hit here is a regression to the bypass.
      store: {
        query: async () => {
          rawStoreQueries += 1;
          return { type: 'bindings' as const, bindings: [] };
        },
      },
    },
    embeddingProvider: null,
    vectorStore: { search: async () => [] },
    path: url.pathname,
    url,
    authentication: opts.authentication,
  } as unknown as RequestContext;

  return { ctx, res, calls, rawStoreQueries: () => rawStoreQueries };
}

const CG = 'cg1';
const CALLER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';

describe('POST /api/memory/search — guarded query path', () => {
  it('never touches the raw triple store', async () => {
    const { ctx, res, calls, rawStoreQueries } = buildCtx({
      body: { query: 'anything', contextGraphId: CG },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
    });

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(rawStoreQueries()).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('fans out one guarded query per requested memory layer', async () => {
    const { ctx, calls } = buildCtx({
      body: { query: 'anything', contextGraphId: CG, memoryLayers: ['wm', 'swm', 'vm'] },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
    });

    await handleMemoryRoutes(ctx);

    expect(calls.map((c) => c.view)).toEqual([
      'working-memory',
      'shared-working-memory',
      'verifiable-memory',
    ]);
    for (const call of calls) {
      expect(call.contextGraphId).toBe(CG);
      // The engine's own authority + A-1 checks key off this, so it must be
      // threaded on every call, not just the working-memory one.
      expect(call.callerAgentAddress).toBe(CALLER);
    }
  });

  it('pins an agent-scoped caller to its own working memory', async () => {
    const { ctx, calls } = buildCtx({
      body: { query: 'anything', contextGraphId: CG, memoryLayers: ['wm'] },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
      localAgents: [CALLER, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    });

    await handleMemoryRoutes(ctx);

    // Exactly one WM call, for the caller — never a co-tenant, even though
    // another agent is registered on this node.
    expect(calls).toHaveLength(1);
    expect(calls[0].view).toBe('working-memory');
    expect(calls[0].agentAddress).toBe(CALLER);
  });

  it('spans every local agent for a node operator (cross-AGENT, not cross-CG)', async () => {
    // Scope note: this pins the FAN-OUT shape only. It does not — and cannot —
    // show that a node operator can read a context graph this node is not
    // rostered for: the fake `agent.query` below has no authority check,
    // whereas the real `DKGAgent.query` re-gates every call on node-local
    // authority. See the IMPORTANT note in the route.

    const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const { ctx, calls } = buildCtx({
      body: { query: 'anything', contextGraphId: CG, memoryLayers: ['wm'] },
      authentication: requestAuthentication({ kind: 'nodeOperator' }),
      localAgents: [CALLER, OTHER],
    });

    await handleMemoryRoutes(ctx);

    expect(calls.map((c) => c.agentAddress)).toEqual([CALLER, OTHER]);
    for (const call of calls) expect(call.view).toBe('working-memory');
  });

  it('falls back to the engine default when a node operator has no registered agents', async () => {
    // Otherwise the whole wm layer would be silently skipped.
    const { ctx, calls } = buildCtx({
      body: { query: 'anything', contextGraphId: CG, memoryLayers: ['wm'] },
      authentication: requestAuthentication({ kind: 'nodeOperator' }),
      localAgents: [],
    });

    await handleMemoryRoutes(ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0].view).toBe('working-memory');
    expect(calls[0].agentAddress).toBeUndefined();
  });

  it('sends a layer-agnostic caller query — no hand-built graph prefixes', async () => {
    const { ctx, calls } = buildCtx({
      body: { query: 'needle', contextGraphId: CG, memoryLayers: ['wm', 'swm'] },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
    });

    await handleMemoryRoutes(ctx);

    for (const call of calls) {
      // Graph resolution belongs to the engine now; re-introducing a layer
      // prefix here would re-introduce the drift this change removes.
      //
      // NB: the absence of `/assertion/` here asserts only that the ROUTE
      // stops hand-building that prefix — it is NOT a claim that
      // name-keyed working memory is out of scope. Coverage for
      // `<cg>/assertion/{addr}/{name}` moved into `resolveViewGraphs`'
      // working-memory branch (see packages/query/test/query-extra.test.ts,
      // "prefix scoped to that agent, both families"), because the engine is
      // what knows the writer-side layout. An earlier revision of this file
      // asserted the same absence while nothing else covered the family,
      // which pinned a real coverage regression as the contract.
      expect(call.sparql).not.toContain('_working_memory');
      expect(call.sparql).not.toContain('_shared_memory');
      expect(call.sparql).not.toContain('_verifiable_memory');
      expect(call.sparql).not.toContain('/assertion/');
      expect(call.sparql).toContain('GRAPH ?g');
      expect(call.sparql).toContain('"needle"');
    }
    // Identical caller query across views — only the routing differs.
    expect(new Set(calls.map((c) => c.sparql)).size).toBe(1);
  });

  it('runs every view on the background lane and cancels on caller disconnect', async () => {
    // Untrusted API reads must not occupy the store slots promotion,
    // reconciliation and SWM catch-up need, and a disconnected caller must not
    // leave orphan work behind (issue #1989). `/api/query` gets this from
    // `createStoreQueryRequestLifecycle`; this route fans out per view, so it
    // needs the same treatment strictly more.
    const { ctx, calls } = buildCtx({
      body: { query: 'anything', contextGraphId: CG, memoryLayers: ['wm', 'swm', 'vm'] },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
    });

    await handleMemoryRoutes(ctx);

    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.signal).toBeDefined();
      expect(call.priority).toBeDefined();
      expect(call.source).toBe('api.memory.search');
    }
  });

  it('dedupes an entity returned by more than one view', async () => {
    const { ctx, res } = buildCtx({
      body: { query: 'anything', contextGraphId: CG, memoryLayers: ['wm', 'swm', 'vm'] },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
      // The same entity is promoted through all three layers.
      bindingsFor: () => [{ entity: 'urn:shared', name: 'shared-entity' }],
    });

    await handleMemoryRoutes(ctx);

    const parsed = JSON.parse(res.body);
    expect(parsed.resultCount).toBe(1);
    expect(parsed.results[0].entityUri).toBe('urn:shared');
    // One 'sparql' source entry, not one per view.
    expect(parsed.results[0].sources).toEqual(['sparql']);
  });

  it('keeps a single failing view non-fatal', async () => {
    const res = fakeRes();
    const url = new URL('http://127.0.0.1/api/memory/search');
    const ctx = {
      req: fakeReq('POST', {
        query: 'anything',
        contextGraphId: CG,
        memoryLayers: ['wm', 'swm'],
      }),
      res,
      agent: {
        resolveContextGraphReadAuthority: async () => ({
        outcome: 'allowed' as const, source: 'registered-chain', reason: 'chain-participant', grantScope: 'caller',
      }),
      canUseSharedMemoryForContextGraph: async () => true,
        listLocalAgents: () => [],
        query: async (_sparql: string, o: Record<string, any> = {}) => {
          if (o.view === 'working-memory') throw new Error('store unavailable');
          return { bindings: [{ entity: 'urn:swm-hit', name: 'swm-entity' }] };
        },
        store: { query: async () => ({ type: 'bindings' as const, bindings: [] }) },
      },
      embeddingProvider: null,
      vectorStore: { search: async () => [] },
      path: url.pathname,
      url,
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
    } as unknown as RequestContext;

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.results.map((r: any) => r.entityUri)).toEqual(['urn:swm-hit']);
  });
});


describe('memory search bounded fair retrieval (#2656)', () => {
  it('does not spend a layer slot on an entity already selected from another layer', async () => {
    const { ctx, res } = buildCtx({
      body: { query: 'needle', contextGraphId: CG, limit: 3 },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
      bindingsFor: ({ view }) => [{ entity: 'urn:common', name: 'needle' },
        { entity: `urn:${view}`, name: 'needle' }],
    });
    await handleMemoryRoutes(ctx);
    expect(JSON.parse(res.body).results.map((r: any) => r.entityUri)).toEqual([
      'urn:common', 'urn:shared-working-memory', 'urn:verifiable-memory',
    ]);
  });

  it('keeps other layers when an optional vector provider and one text view fail', async () => {
    const { ctx, res } = buildCtx({
      body: { query: 'needle', contextGraphId: CG },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
      bindingsFor: ({ view }) => {
        if (view === 'working-memory') throw new Error('store unavailable');
        return [{ entity: `urn:${view}`, name: 'needle' }];
      },
    });
    ctx.embeddingProvider = { embed: async () => { throw new Error('provider unavailable'); } } as any;
    await handleMemoryRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).results.map((r: any) => r.memoryLayer)).toEqual(['swm', 'vm']);
  });

  it('retains matches from each requested layer when WM fills the entire limit', async () => {
    const { ctx, res } = buildCtx({
      body: { query: 'needle', contextGraphId: CG, limit: 3 },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
      bindingsFor: ({ view }) => Array.from({ length: 3 }, (_, n) => ({
        entity: `urn:${view}:${n}`, name: 'needle',
      })),
    });
    await handleMemoryRoutes(ctx);
    const body = JSON.parse(res.body);
    expect(body.results.map((r: any) => r.entityUri)).toEqual([
      'urn:working-memory:0', 'urn:shared-working-memory:0', 'urn:verifiable-memory:0',
    ]);
    expect(body.resultCount).toBe(body.results.length);
    expect(body.results.map((r: any) => r.memoryLayer)).toEqual(['wm', 'swm', 'vm']);
  });

  it('runs at most four text reads concurrently and visits every operator agent', async () => {
    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];
    const agents = Array.from({ length: 11 }, (_, n) => `agent-${n}`);
    const { ctx, calls } = buildCtx({
      body: { query: 'needle', contextGraphId: CG, memoryLayers: ['wm'] },
      authentication: requestAuthentication({ kind: 'nodeOperator' }), localAgents: agents,
      bindingsFor: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>(resolve => release.push(resolve));
        active--;
        return [];
      },
    });
    const pending = handleMemoryRoutes(ctx);
    try {
      await vi.waitFor(() => expect(calls.length).toBe(4), { timeout: 200 });
    } finally {
      // Drain every issued operation even when the pre-fix serial implementation fails.
      for (let i = 0; i < 12; i++) {
        release.splice(0).forEach(fn => fn());
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      await pending;
    }
    expect(maxActive).toBe(4);
    expect(calls.map(call => call.agentAddress)).toEqual(agents);
  });

  it('does not schedule another batch after a disconnected request', async () => {
    const req = Object.assign(new EventEmitter(), {
      method: 'POST', headers: {}, aborted: false,
      __dkgPrebufferedBody: Buffer.from(JSON.stringify({ query: 'needle', contextGraphId: CG, memoryLayers: ['wm'] })),
    });
    const { ctx, calls } = buildCtx({
      body: {}, authentication: requestAuthentication({ kind: 'nodeOperator' }),
      localAgents: Array.from({ length: 20 }, (_, n) => `agent-${n}`),
      bindingsFor: async () => { req.aborted = true; req.emit('aborted'); return []; },
    });
    ctx.req = req as any;
    await expect(handleMemoryRoutes(ctx)).rejects.toMatchObject({ code: 'API_QUERY_CALLER_DISCONNECTED' });
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it('aborts all four pending reads on disconnect without starting a fifth', async () => {
    const req = Object.assign(new EventEmitter(), {
      method: 'POST', headers: {}, aborted: false,
      __dkgPrebufferedBody: Buffer.from(JSON.stringify({ query: 'needle', contextGraphId: CG, memoryLayers: ['wm'] })),
    });
    const aborted: AbortSignal[] = [];
    const cleanup: Array<() => void> = [];
    const { ctx, calls } = buildCtx({
      body: {}, authentication: requestAuthentication({ kind: 'nodeOperator' }),
      localAgents: Array.from({ length: 20 }, (_, n) => `agent-${n}`),
      bindingsFor: call => new Promise((resolve, reject) => {
        const signal = call.signal as AbortSignal;
        const onAbort = () => { aborted.push(signal); reject(signal.reason); };
        signal.addEventListener('abort', onAbort, { once: true });
        cleanup.push(() => { signal.removeEventListener('abort', onAbort); resolve([]); });
      }),
    });
    ctx.req = req as any;
    const pending = handleMemoryRoutes(ctx).then(() => null, error => error);
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(4));
      req.aborted = true; req.emit('aborted');
      await vi.waitFor(() => expect(aborted).toHaveLength(4));
      expect(aborted.every(signal => signal.aborted)).toBe(true);
      expect(await pending).toMatchObject({ code: 'API_QUERY_CALLER_DISCONNECTED' });
      expect(calls).toHaveLength(4);
    } finally {
      req.aborted = true; req.emit('aborted');
      cleanup.forEach(release => release());
      await pending;
    }
  });

  it('explains refused SWM separately from an admitted empty layer', async () => {
    const { ctx, res, calls } = buildCtx({
      body: { query: 'needle', contextGraphId: CG },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
    });
    ctx.agent.canUseSharedMemoryForContextGraph = async () => false;
    await handleMemoryRoutes(ctx);
    expect(JSON.parse(res.body).unavailableLayers).toEqual([{ layer: 'swm', reason: 'read-authority' }]);
    expect(calls.map(call => call.view)).toEqual(['working-memory', 'verifiable-memory']);
  });
});


describe('memory search through real agent admission and query engine', () => {
  it('reports a refused SWM layer and searches VM root/per-id content without WM or metadata leakage', async () => {
    const store = new OxigraphStore();
    let agent: DKGAgent | undefined;
    try {
      const root = `did:dkg:context-graph:${CG}`;
      const graphs = [root, `${root}/context/7`, `${root}/_verifiable_memory/owner/7`,
        `${root}/_meta`, `${root}/_working_memory/${CALLER}/7`, `${root}/_shared_memory`];
      await store.insert(graphs.map((graph, n) => ({ graph, subject: `urn:needle:${n}`,
        predicate: 'http://schema.org/name', object: '"needle"' })));
      agent = await DKGAgent.create({ name: 'MemorySearchScope', store,
        chainAdapter: new MockChainAdapter(), listenHost: '127.0.0.1', nodeRole: 'edge',
        rfc64CatalogActivation: { enabled: false } });
      await agent.start();
      vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockResolvedValue({ outcome: 'allowed', grantScope: 'caller',
        source: 'registered-chain', reason: 'chain-participant', metadataBootstrap: 'eligible' });
      // Only public authority boundaries are overridden; the factory owns all
      // identity, query-engine, subscription and configuration initialization.
      vi.spyOn(agent, 'resolveSharedMemoryReadAdmission').mockResolvedValue({ outcome: 'denied' });
      const { ctx, res } = buildCtx({
        body: { query: 'needle', contextGraphId: CG, memoryLayers: ['swm', 'vm'] },
        authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
      });
      ctx.agent = agent;
      expect((await agent.query('SELECT ?s WHERE { GRAPH ?g { ?s <http://schema.org/name> ?o } }', { contextGraphId: CG, view: 'verifiable-memory', callerAgentAddress: CALLER })).bindings).toHaveLength(3);
      await handleMemoryRoutes(ctx);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results.map((r: any) => r.entityUri).sort()).toEqual(['urn:needle:0', 'urn:needle:1', 'urn:needle:2']);
      expect(body.results.every((r: any) => r.memoryLayer === 'vm')).toBe(true);
      expect(body.unavailableLayers).toEqual([{ layer: 'swm', reason: 'read-authority' }]);
      expect(await agent.query('SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }', {
        contextGraphId: CG, view: 'shared-working-memory', callerAgentAddress: CALLER,
      })).toEqual({ bindings: [] });
    } finally { await agent?.stop(); await store.close(); }
  });
});

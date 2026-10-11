import { describe, it, expect } from 'vitest';
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
  bindingsFor?: (call: QueryCall) => Array<Record<string, string>>;
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
        outcome: 'allowed' as const, source: 'registered-chain', reason: 'chain-participant',
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
        return { bindings: opts.bindingsFor ? opts.bindingsFor(call) : [] };
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
        outcome: 'allowed' as const, source: 'registered-chain', reason: 'chain-participant',
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

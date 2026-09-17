import { describe, it, expect } from 'vitest';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

// `POST /api/memory/search` takes `contextGraphId` straight from the request
// body, and `validateRequiredContextGraphId` only checks its SHAPE. Both
// fan-outs then serve that CG's content:
//
//   - the vector fan-out filters rows by `context_graph_id` in SQL
//     (`VectorStore.search`), so the named CG is the CG that gets ranked,
//   - the SPARQL fan-out queries that CG's memory-layer views. It runs
//     through the guarded `DKGAgent.query` path, whose own authority check
//     denies with an EMPTY result rather than a status — so the explicit
//     gate here is what produces a 403, and what covers the vector fan-out.
//
// Agent-scoped tokens are in the daemon's `validTokens` set
// (`daemon/lifecycle.ts`), so an agent token reaches this route. Without a
// gate here, an agent in CG1's roster and no other could name CG2 and read
// back its entity URIs, labels and snippets. These tests pin the gate.

function fakeRes() {
  const res: any = { statusCode: 0, body: '', headers: {} as Record<string, string> };
  res.writeHead = (status: number, headers?: Record<string, string>) => {
    res.statusCode = status;
    if (headers) Object.assign(res.headers, headers);
  };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.end = (body: string) => { res.body = body; };
  return res;
}

function fakeReq(method: string, body: unknown) {
  return {
    method,
    headers: {},
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)),
  } as any;
}

interface Probe {
  /** CG ids passed to the read-authority check, in call order. */
  readonly authorityChecks: Array<{ contextGraphId: string; callerAgentAddress?: string }>;
  /** True once the SPARQL fan-out ran, via either the guarded or raw path. */
  storeQueried: boolean;
  /** True once the vector fan-out reached the vector store. */
  vectorSearched: boolean;
}

function buildCtx(opts: {
  body: unknown;
  authentication: RequestContext['authentication'];
  readableContextGraphs: string[];
}) {
  const res = fakeRes();
  const url = new URL('http://127.0.0.1/api/memory/search');
  const probe: Probe = { authorityChecks: [], storeQueried: false, vectorSearched: false };

  const agent = {
    canReadContextGraph: async (
      contextGraphId: string,
      o: { callerAgentAddress?: string } = {},
    ) => {
      probe.authorityChecks.push({
        contextGraphId,
        callerAgentAddress: o.callerAgentAddress,
      });
      return opts.readableContextGraphs.includes(contextGraphId);
    },
    // The route fans the text search out per memory-layer view through the
    // guarded `DKGAgent.query` path.
    query: async () => {
      probe.storeQueried = true;
      return {
        bindings: [{ entity: 'urn:secret', name: 'secret-entity', desc: 'secret-desc' }],
      };
    },
    listLocalAgents: () => [{ agentAddress: '0xnode-default-agent' }],
    // Retained so a regression back to the raw-store path is still observed
    // as "retrieval ran" by the deny assertions below.
    store: {
      query: async () => {
        probe.storeQueried = true;
        return {
          type: 'bindings' as const,
          bindings: [{ entity: 'urn:secret', name: 'secret-entity', desc: 'secret-desc' }],
        };
      },
    },
  };

  const ctx = {
    req: fakeReq('POST', opts.body),
    res,
    agent,
    embeddingProvider: { embed: async () => [0.1, 0.2, 0.3] },
    vectorStore: {
      search: async () => {
        probe.vectorSearched = true;
        return [{
          entityUri: 'urn:secret-vector',
          label: 'secret-vector-label',
          similarity: 0.99,
          sourceUri: 'file://secret',
          snippet: 'secret snippet',
          memoryLayer: 'wm',
        }];
      },
    },
    path: url.pathname,
    url,
    authentication: opts.authentication,
  } as unknown as RequestContext;

  return { ctx, res, probe };
}

describe('POST /api/memory/search — context-graph read authority', () => {
  it('denies an agent-scoped caller that has no read authority for the named CG', async () => {
    const { ctx, res, probe } = buildCtx({
      body: { query: 'anything', contextGraphId: 'cg2' },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: '0x123' }),
      readableContextGraphs: ['cg1'],
    });

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(403);
    // Neither retrieval path may run — a post-hoc filter would still have
    // ranked and materialised the foreign CG's rows.
    expect(probe.storeQueried).toBe(false);
    expect(probe.vectorSearched).toBe(false);
    expect(res.body).not.toContain('secret');

    // The gate must evaluate the CG the CALLER named, under the caller's own
    // authenticated identity — not the node's default agent.
    expect(probe.authorityChecks).toEqual([
      { contextGraphId: 'cg2', callerAgentAddress: '0x123' },
    ]);
  });

  it('allows an agent-scoped caller for a CG it can read', async () => {
    const { ctx, res, probe } = buildCtx({
      body: { query: 'anything', contextGraphId: 'cg1' },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: '0x123' }),
      readableContextGraphs: ['cg1'],
    });

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(probe.storeQueried).toBe(true);
    expect(probe.vectorSearched).toBe(true);
    expect(JSON.parse(res.body).resultCount).toBeGreaterThan(0);
  });

  it('lets a node operator keep the cross-CG view', async () => {
    const { ctx, res, probe } = buildCtx({
      body: { query: 'anything', contextGraphId: 'cg2' },
      authentication: requestAuthentication({ kind: 'nodeOperator' }),
      readableContextGraphs: [],
    });

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(probe.storeQueried).toBe(true);
    // A node operator administers the box; the gate is not consulted at all.
    expect(probe.authorityChecks).toEqual([]);
  });

  it('gates an anonymous caller through node-local read authority', async () => {
    // Auth-disabled / anonymous callers carry no agent identity, so the
    // authority resolver falls back to the node's own membership. That is the
    // same contract `DKGAgent.query` applies, and it must still be CONSULTED
    // rather than skipped.
    const { ctx, res, probe } = buildCtx({
      body: { query: 'anything', contextGraphId: 'cg2' },
      authentication: requestAuthentication({ kind: 'anonymous', mode: 'disabled' }),
      readableContextGraphs: [],
    });

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(403);
    expect(probe.storeQueried).toBe(false);
    expect(probe.vectorSearched).toBe(false);
    expect(probe.authorityChecks).toEqual([
      { contextGraphId: 'cg2', callerAgentAddress: undefined },
    ]);
  });

  it('denies before the SPARQL builder runs, so a deny cannot be a silent empty 200', async () => {
    const { ctx, res } = buildCtx({
      body: { query: 'anything', contextGraphId: 'cg2', memoryLayers: ['wm'] },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: '0x123' }),
      readableContextGraphs: ['cg1'],
    });

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(403);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toContain('cg2');
    expect(parsed.results).toBeUndefined();
  });
});

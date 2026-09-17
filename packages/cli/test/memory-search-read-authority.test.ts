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

interface Decision {
  outcome: 'allowed' | 'denied' | 'unavailable';
  source: string;
  reason: string;
}

interface Probe {
  /** Args the route passed to the read-authority resolver, in call order. */
  readonly authorityChecks: Array<{ contextGraphId: string; callerAgentAddress?: string }>;
  /** Args the route passed to the shared-memory gate, in call order. */
  readonly swmChecks: Array<{ contextGraphId: string; callerAgentAddress?: string }>;
  /** True once the SPARQL fan-out ran, via either the guarded or raw path. */
  storeQueried: boolean;
  /** True once the vector fan-out reached the vector store. */
  vectorSearched: boolean;
  /** The SPARQL the route built, if it got that far. */
  sparql: string;
  /** Memory-layer views the route actually fanned out to. */
  readonly views: string[];
}

function buildCtx(opts: {
  body: unknown;
  authentication: RequestContext['authentication'];
  decisionFor: (contextGraphId: string) => Decision;
  swmAllowed?: boolean;
}) {
  const res = fakeRes();
  const url = new URL('http://127.0.0.1/api/memory/search');
  const probe: Probe = {
    authorityChecks: [], swmChecks: [], storeQueried: false, vectorSearched: false, sparql: '',
    views: [],
  };

  const agent = {
    resolveContextGraphReadAuthority: async (
      contextGraphId: string,
      o: { callerAgentAddress?: string } = {},
    ) => {
      probe.authorityChecks.push({ contextGraphId, callerAgentAddress: o.callerAgentAddress });
      return opts.decisionFor(contextGraphId);
    },
    canUseSharedMemoryForContextGraph: async (
      contextGraphId: string,
      o: { callerAgentAddress?: string } = {},
    ) => {
      probe.swmChecks.push({ contextGraphId, callerAgentAddress: o.callerAgentAddress });
      return opts.swmAllowed ?? true;
    },
    // The route fans the text search out per memory-layer view through the
    // guarded `DKGAgent.query` path.
    query: async (sparql: string, o: Record<string, any> = {}) => {
      probe.storeQueried = true;
      probe.sparql = sparql;
      if (o.view) probe.views.push(o.view);
      return {
        bindings: [{ entity: 'urn:secret', name: 'secret-entity', desc: 'secret-desc' }],
      };
    },
    listLocalAgents: () => [{ agentAddress: '0xnode-default-agent' }],
    // Retained so a regression back to the raw-store path is still observed
    // as "retrieval ran" by the deny assertions below.
    store: {
      query: async (sparql: string) => {
        probe.storeQueried = true;
        probe.sparql = sparql;
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

const ALLOW_CHAIN: Decision = { outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant' };
const DENY: Decision = { outcome: 'denied', source: 'registered-chain', reason: 'agent-not-in-chain-roster' };

describe('POST /api/memory/search — context-graph read authority', () => {
  it('denies an agent-scoped caller that has no read authority for the named CG', async () => {
    const { ctx, res, probe } = buildCtx({
      body: { query: 'anything', contextGraphId: 'cg2' },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: '0x123' }),
      decisionFor: (cg) => (cg === 'cg1' ? ALLOW_CHAIN : DENY),
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
      decisionFor: () => ALLOW_CHAIN,
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
      decisionFor: () => DENY,
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
      decisionFor: () => DENY,
    });

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(403);
    expect(probe.storeQueried).toBe(false);
    expect(probe.vectorSearched).toBe(false);
    expect(probe.authorityChecks).toEqual([
      { contextGraphId: 'cg2', callerAgentAddress: undefined },
    ]);
  });

  it('denies BEFORE the SPARQL builder runs, and emits no results key', async () => {
    // Distinct from case 1: this pins the ORDERING (gate precedes retrieval)
    // and the response SHAPE (an error body, never a `results` array a client
    // could mistake for "searched and found nothing").
    const { ctx, res, probe } = buildCtx({
      body: { query: 'anything', contextGraphId: 'cg2', memoryLayers: ['wm'] },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: '0x123' }),
      decisionFor: () => DENY,
    });

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(403);
    expect(probe.storeQueried).toBe(false);
    expect(probe.sparql).toBe('');
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toContain('cg2');
    expect(parsed.results).toBeUndefined();
    expect(parsed.resultCount).toBeUndefined();
  });

  it('serves a 503, not a 403, when the authority itself is unavailable', async () => {
    // `unavailable` means the chain RPC failed or metadata has not synced —
    // NOT that the caller is forbidden. A 403 is terminal; no client retries
    // it, so a transient blip would look like a permanent permission loss.
    const { ctx, res, probe } = buildCtx({
      body: { query: 'anything', contextGraphId: 'cg1' },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: '0x123' }),
      decisionFor: () => ({
        outcome: 'unavailable', source: 'registered-chain', reason: 'registered-authority-error',
      }),
    });

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).retryable).toBe(true);
    expect(JSON.parse(res.body).error).toContain('registered-authority-error');
    expect(probe.storeQueried).toBe(false);
    expect(probe.vectorSearched).toBe(false);
  });

  it('refuses an agent-scoped caller whose only allow is NODE-scoped', async () => {
    // The hole this route was gated for. `legacy-peer-allowlist` answers
    // "may this NODE read?" — the resolver never looked at
    // `callerAgentAddress` on that branch. An agent-scoped token must not
    // inherit it, even though the raw outcome is `allowed`.
    for (const reason of [
      'legacy-peer-allowlist',
      'legacy-peer-invitation',
      'legacy-local-agent-participant',
      'legacy-local-identity-participant',
      'legacy-subscription',
      'legacy-edge-subscription',
    ]) {
      const { ctx, res, probe } = buildCtx({
        body: { query: 'anything', contextGraphId: 'cg2' },
        authentication: requestAuthentication({ kind: 'agent', agentAddress: '0x123' }),
        decisionFor: () => ({ outcome: 'allowed', source: 'legacy-local', reason }),
      });

      await handleMemoryRoutes(ctx);

      expect(res.statusCode, `reason=${reason}`).toBe(403);
      expect(probe.storeQueried, `reason=${reason}`).toBe(false);
      expect(probe.vectorSearched, `reason=${reason}`).toBe(false);
    }
  });

  it('still honours a CALLER-scoped legacy allow for an agent principal', async () => {
    // The complement of the case above: `legacy-caller-participant` and the
    // agent-gate branches DO consult `callerAgentAddress`, so they must keep
    // working. Otherwise the fix would deny every legacy private CG outright.
    for (const reason of [
      'legacy-caller-participant',
      'local-agent-allowlist',
      'local-agent-and-peer-allowlist',
      'local-public',
    ]) {
      const { ctx, res, probe } = buildCtx({
        body: { query: 'anything', contextGraphId: 'cg1' },
        authentication: requestAuthentication({ kind: 'agent', agentAddress: '0x123' }),
        decisionFor: () => ({ outcome: 'allowed', source: 'legacy-local', reason }),
      });

      await handleMemoryRoutes(ctx);

      expect(res.statusCode, `reason=${reason}`).toBe(200);
      expect(probe.storeQueried, `reason=${reason}`).toBe(true);
    }
  });

  it('lets an anonymous caller keep a node-scoped allow', async () => {
    // A caller with no agent identity IS the node for authorization purposes,
    // so node-scoped reasons are the correct basis for it. Narrowing them
    // here would break auth-disabled self-reads.
    const { ctx, res, probe } = buildCtx({
      body: { query: 'anything', contextGraphId: 'cg1' },
      authentication: requestAuthentication({ kind: 'anonymous', mode: 'disabled' }),
      decisionFor: () => ({
        outcome: 'allowed', source: 'legacy-local', reason: 'legacy-peer-allowlist',
      }),
    });

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(probe.storeQueried).toBe(true);
  });

  it('drops the swm layer when the shared-memory gate refuses it', async () => {
    // `DKGAgent.query` applies `canUseSharedMemoryForContextGraph` on top of
    // read authority for any shared-memory read. Without it this route is
    // measurably more permissive than `/api/query` for that layer.
    const { ctx, res, probe } = buildCtx({
      body: { query: 'anything', contextGraphId: 'cg1', memoryLayers: ['wm', 'swm'] },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: '0x123' }),
      decisionFor: () => ALLOW_CHAIN,
      swmAllowed: false,
    });

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(probe.swmChecks).toEqual([
      { contextGraphId: 'cg1', callerAgentAddress: '0x123' },
    ]);
    // The wm layer still runs; only the shared-memory view is gone.
    expect(probe.views).toContain('working-memory');
    expect(probe.views).not.toContain('shared-working-memory');
  });

  it('keeps the swm layer when the shared-memory gate allows it', async () => {
    const { ctx, probe } = buildCtx({
      body: { query: 'anything', contextGraphId: 'cg1', memoryLayers: ['swm'] },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: '0x123' }),
      decisionFor: () => ALLOW_CHAIN,
      swmAllowed: true,
    });

    await handleMemoryRoutes(ctx);

    expect(probe.views).toEqual(['shared-working-memory']);
  });

  it('does not consult the shared-memory gate for a node operator', async () => {
    const { ctx, probe } = buildCtx({
      body: { query: 'anything', contextGraphId: 'cg1', memoryLayers: ['swm'] },
      authentication: requestAuthentication({ kind: 'nodeOperator' }),
      decisionFor: () => DENY,
      swmAllowed: false,
    });

    await handleMemoryRoutes(ctx);

    expect(probe.swmChecks).toEqual([]);
    expect(probe.views).toEqual(['shared-working-memory']);
  });
});

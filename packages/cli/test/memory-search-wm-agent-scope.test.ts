import { describe, it, expect } from 'vitest';
import {
  MemoryLayer,
  contextGraphLayerPrefixCandidates,
} from '@origintrail-official/dkg-core';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

// Fan-out 2 of `POST /api/memory/search` queries the triple store directly, so
// the A-1 working-memory isolation `DKGAgent.query` applies to the
// `working-memory` view never reaches it. The `wm` layer filter used the
// unscoped `<cg>/_working_memory` and `<cg>/assertion/` prefixes, which match
// EVERY agent's drafts in the context graph. These tests pin the caller-scoped
// prefixes.

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

function buildCtx(opts: {
  body: unknown;
  authentication: RequestContext['authentication'];
}) {
  const res = fakeRes();
  const url = new URL('http://127.0.0.1/api/memory/search');
  let capturedSparql = '';
  const ctx = {
    req: fakeReq('POST', opts.body),
    res,
    agent: {
      canReadContextGraph: async () => true,
      store: {
        query: async (sparql: string) => {
          capturedSparql = sparql;
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
  return { ctx, res, sparql: () => capturedSparql };
}

const CG = 'cg1';
const CALLER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('POST /api/memory/search — working-memory agent scope', () => {
  it('scopes the wm filter to the caller, not to every agent in the CG', async () => {
    const { ctx, res, sparql } = buildCtx({
      body: { query: 'anything', contextGraphId: CG, memoryLayers: ['wm'] },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
    });

    await handleMemoryRoutes(ctx);
    expect(res.statusCode).toBe(200);

    // The bare prefixes would match a co-tenant's drafts; they must be gone.
    expect(sparql()).not.toContain(`"did:dkg:context-graph:${CG}/assertion/"`);
    expect(sparql()).not.toContain(`"did:dkg:context-graph:${CG}/_working_memory"`);

    // Every emitted prefix must carry the caller's address.
    const prefixes = [...sparql().matchAll(/STRSTARTS\(STR\(\?g\), "([^"]+)"\)/g)]
      .map((m) => m[1]);
    expect(prefixes.length).toBeGreaterThan(0);
    for (const prefix of prefixes) {
      expect(prefix.toLowerCase()).toContain(CALLER.toLowerCase());
    }
    expect(prefixes.some((p) => p.toLowerCase().includes(OTHER.toLowerCase()))).toBe(false);
  });

  it('emits the canonical uniform-layout prefixes from dkg-core, not hand-built ones', async () => {
    const { ctx, sparql } = buildCtx({
      body: { query: 'anything', contextGraphId: CG, memoryLayers: ['wm'] },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
    });

    await handleMemoryRoutes(ctx);

    // Pin against the writer-side builder so a layout change cannot drift
    // this filter silently.
    for (const prefix of contextGraphLayerPrefixCandidates(
      CG,
      MemoryLayer.WorkingMemory,
      CALLER,
    )) {
      expect(sparql()).toContain(`STRSTARTS(STR(?g), "${prefix}")`);
    }
  });

  it('keeps the legacy /assertion/<addr>/ shape, in canonical and original casing', async () => {
    const { ctx, sparql } = buildCtx({
      body: { query: 'anything', contextGraphId: CG, memoryLayers: ['wm'] },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
    });

    await handleMemoryRoutes(ctx);

    // Pre-canonicalization drafts are addressed by the caller's original
    // casing; canonicalized ones by the lowercased EVM form. Both are the
    // SAME identity, so both belong in the caller's own scope.
    expect(sparql()).toContain(
      `STRSTARTS(STR(?g), "did:dkg:context-graph:${CG}/assertion/${CALLER.toLowerCase()}/")`,
    );
    expect(sparql()).toContain(
      `STRSTARTS(STR(?g), "did:dkg:context-graph:${CG}/assertion/${CALLER}/")`,
    );
  });

  it('leaves swm and vm filters untouched — those layers are CG-wide by design', async () => {
    const { ctx, sparql } = buildCtx({
      body: { query: 'anything', contextGraphId: CG, memoryLayers: ['swm', 'vm'] },
      authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER }),
    });

    await handleMemoryRoutes(ctx);

    expect(sparql()).toContain(
      `STRSTARTS(STR(?g), "did:dkg:context-graph:${CG}/_shared_memory")`,
    );
    expect(sparql()).toContain(
      `STRSTARTS(STR(?g), "did:dkg:context-graph:${CG}/_verifiable_memory")`,
    );
  });

  it('keeps the CG-wide wm prefixes for a node operator', async () => {
    // A node operator has no agent identity and already holds the cross-agent
    // view through /api/query; narrowing here would only break their tooling.
    const { ctx, sparql } = buildCtx({
      body: { query: 'anything', contextGraphId: CG, memoryLayers: ['wm'] },
      authentication: requestAuthentication({ kind: 'nodeOperator' }),
    });

    await handleMemoryRoutes(ctx);

    expect(sparql()).toContain(`STRSTARTS(STR(?g), "did:dkg:context-graph:${CG}/assertion/")`);
    expect(sparql()).toContain(
      `STRSTARTS(STR(?g), "did:dkg:context-graph:${CG}/_working_memory")`,
    );
  });
});

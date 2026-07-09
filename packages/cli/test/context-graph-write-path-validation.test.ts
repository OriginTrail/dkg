// Context-graph write-path validation — NO MOCKS.
//
// This file pins the mutation routes' fail-closed contextGraphId resolution:
// a write/create/register/invite/join target must resolve to a known, canonical,
// locally-writable context graph BEFORE any agent/publisher/storage mutation,
// otherwise the storage layer would auto-materialize a shadow graph.
//
// Two honest strategies, no fabricated daemon behaviour:
//
// 1) PURE-UNIT of the REAL resolver. The resolution logic lives in the real
//    exported `resolveRequiredWriteContextGraphId(provider, id, res, opts)`.
//    Its `provider` argument is a NARROW DATA interface
//    ({ listContextGraphs, contextGraphHasLocalContent?, contextGraphExists? })
//    — the list of context graphs the node knows about, which is DATA, not a
//    mocked service. The curated multi-node states this resolver guards
//    against — a canonical `0x<curator>/<slug>` graph coexisting with a
//    same-named bare `<slug>` shadow, a graph that is `subscribed` but not yet
//    `synced` — only ever arise on a real curated NETWORK and cannot exist on
//    a single edge daemon. So those rows are fed as real `ExistingContextGraphRow`
//    data to the real resolver, with a real captured `ServerResponse` sink. No
//    mocks: the data-provider is a plain function returning a row array (with a
//    hand-rolled call recorder where a test asserts the caller-scope arg).
//    The `opts` mirror the routes' real `writePreflightContextGraphOpts`
//    (callerAgentAddress = requestToken ? resolveAgentByToken : undefined;
//    allowLocalExactFallback = !callerAgentAddress).
//
// 2) LIVE DAEMON for the reproducible end-to-end wiring: a real edge daemon
//    (startLiveDaemon vs the shared Hardhat node) proves the real routes invoke
//    the resolver before mutating — an unknown contextGraphId is rejected with
//    CONTEXT_GRAPH_NOT_FOUND across every write route, and a real locally-created
//    graph (and its full did:dkg URI) is accepted.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ServerResponse } from 'node:http';
import { resolveRequiredWriteContextGraphId } from '../src/daemon/http-utils.js';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import {
  startLiveDaemon,
  stopLiveDaemon,
  postJson,
  getJson,
  type LiveDaemon,
} from './helpers/live-daemon.js';

// A real curated-graph shape: canonical id is `0x<curator>/<slug>`.
const CANONICAL_CG = '0xE5B8896800000000000000000000000000000000/tuesday-cg';
const CANONICAL_URI = `did:dkg:context-graph:${CANONICAL_CG}`;
const BARE_CG = 'tuesday-cg';
const BARE_URI = `did:dkg:context-graph:${BARE_CG}`;
const CALLER = '0x0000000000000000000000000000000000000001';

type Row = {
  id: string;
  uri?: string;
  name?: string;
  accessPolicy?: string;
  creator?: string;
  curator?: string;
  onChainId?: string;
  subscribed?: boolean;
  synced?: boolean;
  hasLocalContent?: boolean;
  isSystem?: boolean;
  // test-only: drive the contextGraphExists data provider
  exists?: boolean;
};

// Captured HTTP response sink. `jsonResponse` calls `res.writeHead(status)`
// then `res.end(body)`; on the success path the resolver RETURNS the id and
// never touches `res`. Real ServerResponse surface, no mock.
function captureRes(): { res: ServerResponse; out: { status?: number; body?: any } } {
  const out: { status?: number; body?: any } = {};
  const res = {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(body?: string) {
      if (typeof body === 'string' && body.length) {
        try {
          out.body = JSON.parse(body);
        } catch {
          out.body = body;
        }
      }
    },
  } as unknown as ServerResponse;
  return { res, out };
}

// Plain data-provider over a real row array — the narrow interface the real
// resolver consumes. `listCalls` records each listContextGraphs argument so a
// test can assert caller-scoping; this is a hand-rolled recorder, not a mock.
function rowProvider(rows: Row[]) {
  const listCalls: Array<{ callerAgentAddress?: string | null } | undefined> = [];
  const existsCalls: string[] = [];
  const localContentCalls: string[] = [];
  return {
    listCalls,
    existsCalls,
    localContentCalls,
    provider: {
      async listContextGraphs(opts?: { callerAgentAddress?: string | null }) {
        listCalls.push(opts);
        return rows as any;
      },
      async contextGraphHasLocalContent(id: string) {
        localContentCalls.push(id);
        return rows.some((r) => r.id === id && r.hasLocalContent === true);
      },
      async contextGraphExists(id: string) {
        existsCalls.push(id);
        return rows.some(
          (r) => r.exists !== false && (r.id === id || r.uri === `did:dkg:context-graph:${id}`),
        );
      },
    },
  };
}

function preSignedAttestationFor(address: string) {
  return {
    address,
    reservedKaId: '1',
    signature: {
      r: `0x${'11'.repeat(32)}`,
      vs: `0x${'22'.repeat(32)}`,
    },
  };
}

function routeRes() {
  const res: any = { statusCode: 0, body: '', headers: {} as Record<string, string>, writableEnded: false };
  res.writeHead = (status: number, headers?: Record<string, string>) => {
    res.statusCode = status;
    if (headers) Object.assign(res.headers, headers);
    return res;
  };
  res.setHeader = (key: string, value: string) => { res.headers[key] = value; };
  res.end = (body?: string) => {
    res.body = body ?? '';
    res.writableEnded = true;
  };
  return res;
}

// The routes' real write-preflight opts (knowledge-assets.ts:478-482 /
// context-graph.ts): unscoped when there is no agent token, scoped to the
// token-resolved agent address otherwise.
const UNSCOPED = { callerAgentAddress: undefined, allowLocalExactFallback: true } as const;
const SCOPED = { callerAgentAddress: CALLER, allowLocalExactFallback: false } as const;

describe('resolveRequiredWriteContextGraphId — write-target resolution (real resolver, real rows)', () => {
  it('accepts an exact existing canonical id (subscribed + synced ⇒ writable)', async () => {
    const { provider } = rowProvider([{ id: CANONICAL_CG, uri: CANONICAL_URI, subscribed: true, synced: true }]);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, CANONICAL_CG, res, UNSCOPED);
    expect(resolved).toBe(CANONICAL_CG);
    expect(out.status).toBeUndefined();
  });

  it('accepts an exact full DID for an existing bare id instead of treating it as a suffix-only slug', async () => {
    const { provider } = rowProvider([
      { id: CANONICAL_CG, uri: CANONICAL_URI, subscribed: true, synced: true },
      { id: BARE_CG, uri: BARE_URI, name: 'Tuesday public CG', accessPolicy: 'public', subscribed: true, synced: true },
    ]);
    const { res } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, BARE_URI, res, UNSCOPED);
    expect(resolved).toBe(BARE_CG);
  });

  it('rejects a full DID for a shadow-like bare id when a curated suffix match exists', async () => {
    const { provider } = rowProvider([
      { id: CANONICAL_CG, uri: CANONICAL_URI, subscribed: true, synced: true },
      { id: BARE_CG, uri: BARE_URI }, // bare, no curator/accessPolicy/subscribed ⇒ shadow-like
    ]);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, BARE_URI, res, UNSCOPED);
    expect(resolved).toBeNull();
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ code: 'CONTEXT_GRAPH_ID_NOT_CANONICAL', canonicalContextGraphId: CANONICAL_CG });
  });

  it('accepts an exact legitimate bare id even when a curated suffix match exists', async () => {
    const { provider } = rowProvider([
      { id: CANONICAL_CG, uri: CANONICAL_URI, subscribed: true, synced: true },
      { id: BARE_CG, uri: BARE_URI, name: 'Tuesday public CG', accessPolicy: 'public', subscribed: true, synced: true },
    ]);
    const { res } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, BARE_CG, res, UNSCOPED);
    expect(resolved).toBe(BARE_CG);
  });

  it('rejects a bare suffix match and returns the canonical id', async () => {
    const { provider } = rowProvider([
      { id: CANONICAL_CG, uri: CANONICAL_URI, subscribed: true, synced: true },
      { id: BARE_CG, uri: BARE_URI },
    ]);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, BARE_CG, res, UNSCOPED);
    expect(resolved).toBeNull();
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ code: 'CONTEXT_GRAPH_ID_NOT_CANONICAL', canonicalContextGraphId: CANONICAL_CG });
  });

  it('rejects an exact context graph that is visible but not locally synced', async () => {
    const { provider, localContentCalls } = rowProvider([
      { id: 'definition-only-cg', uri: 'did:dkg:context-graph:definition-only-cg', name: 'Definition Only CG', accessPolicy: 'public', subscribed: true, synced: false },
    ]);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, 'definition-only-cg', res, UNSCOPED);
    expect(resolved).toBeNull();
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_WRITABLE' });
    expect(localContentCalls).toContain('definition-only-cg');
  });

  it('accepts an exact locally-defined context graph before its first content write', async () => {
    const { provider, localContentCalls, existsCalls } = rowProvider([
      { id: 'fresh-local-cg', uri: 'did:dkg:context-graph:fresh-local-cg', name: 'Fresh Local CG', accessPolicy: 'public', subscribed: false, synced: false },
    ]);
    const { res } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, 'fresh-local-cg', res, UNSCOPED);
    expect(resolved).toBe('fresh-local-cg');
    expect(localContentCalls).toContain('fresh-local-cg');
    expect(existsCalls).toContain('fresh-local-cg');
  });

  it('accepts an exact visible context graph with local content even when not subscribed', async () => {
    const { provider } = rowProvider([
      { id: 'local-content-cg', uri: 'did:dkg:context-graph:local-content-cg', name: 'Local Content CG', accessPolicy: 'public', subscribed: false, synced: false, hasLocalContent: true },
    ]);
    const { res } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, 'local-content-cg', res, UNSCOPED);
    expect(resolved).toBe('local-content-cg');
  });

  it('accepts an exact bare context graph with local content when a curated suffix also exists', async () => {
    const { provider, localContentCalls } = rowProvider([
      { id: CANONICAL_CG, uri: CANONICAL_URI, subscribed: true, synced: true },
      { id: BARE_CG, uri: BARE_URI, name: BARE_CG, subscribed: false, synced: false, hasLocalContent: true },
    ]);
    const { res } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, BARE_CG, res, UNSCOPED);
    expect(resolved).toBe(BARE_CG);
    expect(localContentCalls).toContain(BARE_CG);
  });

  it('rejects an unknown contextGraphId with CONTEXT_GRAPH_NOT_FOUND', async () => {
    const { provider } = rowProvider([{ id: CANONICAL_CG, uri: CANONICAL_URI, subscribed: true, synced: true }]);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, 'missing-cg', res, UNSCOPED);
    expect(resolved).toBeNull();
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
  });

  it('allows a node-level (unscoped) preflight to an exact local graph hidden from the unscoped list via the existence fallback', async () => {
    const { provider, existsCalls } = rowProvider([{ id: 'private-local-cg', exists: true }]);
    // empty visible list, but contextGraphExists confirms the local graph
    (provider as any).listContextGraphs = async (opts?: any) => {
      void opts;
      return [];
    };
    const { res } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, 'private-local-cg', res, UNSCOPED);
    expect(resolved).toBe('private-local-cg');
    expect(existsCalls).toContain('private-local-cg');
  });

  it('does NOT use the existence fallback for an explicit (scoped) caller — hidden graph stays NOT_FOUND', async () => {
    const { provider, existsCalls } = rowProvider([{ id: 'private-hidden-cg', exists: true }]);
    (provider as any).listContextGraphs = async (opts?: any) => {
      void opts;
      return [];
    };
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, 'private-hidden-cg', res, SCOPED);
    expect(resolved).toBeNull();
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
    // allowLocalExactFallback is false for a scoped caller ⇒ existence never consulted.
    expect(existsCalls).toEqual([]);
  });

  it('lists write targets UNSCOPED (no callerAgentAddress arg) when the caller has no resolved agent', async () => {
    const { provider, listCalls } = rowProvider([{ id: 'node-cg', uri: 'did:dkg:context-graph:node-cg', subscribed: true, synced: true }]);
    const { res } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, 'node-cg', res, UNSCOPED);
    expect(resolved).toBe('node-cg');
    // resolver calls listContextGraphs() with NO argument when callerAgentAddress is falsy.
    expect(listCalls).toEqual([undefined]);
  });

  it('scopes the write-target listing to {callerAgentAddress} when the token resolved to an EVM address', async () => {
    const { provider, listCalls } = rowProvider([{ id: 'agent-cg', uri: 'did:dkg:context-graph:agent-cg', subscribed: true, synced: true }]);
    const { res } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, 'agent-cg', res, SCOPED);
    expect(resolved).toBe('agent-cg');
    expect(listCalls).toEqual([{ callerAgentAddress: CALLER }]);
  });
});

describe('context-graph write-path validation — real daemon route wiring', () => {
  let daemon: LiveDaemon;
  const LOCAL_CG = 'write-path-cg';

  beforeAll(async () => {
    daemon = await startLiveDaemon();
    const created = await postJson(daemon, '/api/context-graph/create', { id: LOCAL_CG, name: LOCAL_CG });
    expect(created.status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  });

  const QUADS = [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }];

  async function postJsonAsAgent(authToken: string, path: string, body: unknown) {
    const res = await fetch(`${daemon.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  }

  async function registerAgentClient(label: string) {
    const registered = await postJson(daemon, '/api/agent/register', {
      name: `${label}-${Date.now().toString(36)}`,
      framework: 'test',
    });
    expect(registered.status, `${label} register: ${JSON.stringify(registered.body)}`).toBeLessThan(300);
    const agentAddress = String(registered.body.agentAddress);
    const authToken = String(registered.body.authToken);
    expect(agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(authToken.length).toBeGreaterThan(0);
    return {
      agentAddress,
      authToken,
      post: (path: string, body: unknown) => postJsonAsAgent(authToken, path, body),
    };
  }

  async function createRegisteredAgentContextGraph(
    agent: Awaited<ReturnType<typeof registerAgentClient>>,
    id: string,
  ) {
    const created = await agent.post('/api/context-graph/create', { id, name: id, accessPolicy: 1 });
    expect(created.status, `agent CG create: ${JSON.stringify(created.body)}`).toBeLessThan(300);
    const registered = await agent.post('/api/context-graph/register', { id, accessPolicy: 1 });
    expect(registered.status, `agent CG register: ${JSON.stringify(registered.body)}`).toBe(200);
  }

  // ── every write route rejects an unknown contextGraphId before mutating ──
  it('rejects unknown wm/write targets with CONTEXT_GRAPH_NOT_FOUND before mutation', async () => {
    const res = await postJson(daemon, '/api/knowledge-assets/draft/wm/write', { contextGraphId: 'missing-cg', quads: QUADS });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
  });

  it('rejects unknown knowledge-asset create targets with CONTEXT_GRAPH_NOT_FOUND', async () => {
    const res = await postJson(daemon, '/api/knowledge-assets', { contextGraphId: 'missing-cg', name: 'draft' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
  });

  it('rejects unknown sub-graph creation targets with CONTEXT_GRAPH_NOT_FOUND', async () => {
    // subGraphName is validated before the CG resolution, so supply a valid
    // one to reach the contextGraphId guard under test.
    const res = await postJson(daemon, '/api/sub-graph/create', { contextGraphId: 'missing-cg', subGraphName: 'code' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
  });

  it('rejects unknown context-graph rename targets with CONTEXT_GRAPH_NOT_FOUND', async () => {
    const res = await postJson(daemon, '/api/context-graph/rename', { id: 'missing-cg', name: 'renamed' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
  });

  it('rejects unknown join-approval targets with CONTEXT_GRAPH_NOT_FOUND', async () => {
    const res = await postJson(daemon, '/api/context-graph/missing-cg/approve-join', { agentAddress: CALLER });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
  });

  it('rejects unknown join-rejection targets with CONTEXT_GRAPH_NOT_FOUND', async () => {
    const res = await postJson(daemon, '/api/context-graph/missing-cg/reject-join', { agentAddress: CALLER });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
  });

  it('rejects unknown manifest-publish targets with CONTEXT_GRAPH_NOT_FOUND', async () => {
    const res = await postJson(daemon, '/api/context-graph/missing-cg/manifest/publish', {});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
  });

  it('rejects unknown knowledge-asset create targets with CONTEXT_GRAPH_NOT_FOUND', async () => {
    const res = await postJson(daemon, '/api/knowledge-assets', { contextGraphId: 'missing-cg', name: 'draft', quads: QUADS });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
  });

  it('rejects unknown vm/publish targets with CONTEXT_GRAPH_NOT_FOUND', async () => {
    const res = await postJson(daemon, '/api/knowledge-assets/draft/vm/publish', { contextGraphId: 'missing-cg' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
  });

  // The legacy SWM-bridge publish route was removed (consolidated onto the
  // per-KA vm/publish above). Guard against accidental reintroduction: the
  // daemon must no longer recognize the route at all (route-not-found 404),
  // rather than reach a handler.
  it('no longer serves the removed /api/shared-memory/publish route (404)', async () => {
    const res = await postJson(daemon, '/api/shared-memory/publish', { contextGraphId: LOCAL_CG });
    expect(res.status).toBe(404);
  });

  // ── a real locally-created graph (and its full DID) is accepted ──
  it('accepts an exact locally-created contextGraphId for knowledge-asset create', async () => {
    const res = await postJson(daemon, '/api/knowledge-assets', { contextGraphId: LOCAL_CG, name: 'draft' });
    expect(res.status).toBe(201);
  });

  it('accepts the full did:dkg URI of a locally-created graph (normalized to the bare id) for wm/write', async () => {
    const res = await postJson(daemon, `/api/knowledge-assets/draft/wm/write`, {
      contextGraphId: `did:dkg:context-graph:${LOCAL_CG}`,
      quads: QUADS,
    });
    expect(res.status).toBe(200);
  });

  it('normalizes a full did:dkg URI on the wm/quads read path', async () => {
    const res = await getJson(
      daemon,
      `/api/knowledge-assets/draft/wm/quads?contextGraphId=${encodeURIComponent(`did:dkg:context-graph:${LOCAL_CG}`)}`,
    );
    expect(res.status).toBe(200);
  });
});

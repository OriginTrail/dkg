// Focused route tests for POST /api/context-graph/register effective
// publishPolicy resolution (#1085 / PR #1423). Extracted (R8) from the
// catch-all daemon-http-behavior-extra.test.ts so this policy matrix has its
// own home AND runs WITHOUT the daemon-spawn / hardhat harness — these are pure
// route-handler tests over an in-process `createServer` + a stub agent.
//
// The standalone /api/context-graph/register route computes the effective
// publishPolicy itself: an explicit body value wins; an omitted policy is
// rehydrated by reading the canonical `getStoredContextGraphRegistrationOptions`
// store reader LAZILY (only when the body omitted it). These tests pin the
// route's contract: body-wins without a stored read, rehydrate-on-omit, reject
// an explicit `pcaAccountId` against the EFFECTIVE policy, keep `pcaAccountId`
// explicit-only (never read/forward the stored PCA id), and stay best-effort
// (warn, don't 500) on a stored-read failure.
import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';

describe('POST /api/context-graph/register — effective publishPolicy resolution (#1085)', () => {
  async function runRegisterRouteCaptureOpts(
    body: Record<string, unknown>,
    agentOverrides: Record<string, any>,
  ): Promise<{ status: number; json: any; registerOpts: any; storedReads: Array<any[]> }> {
    const contextGraphId = String(body.id ?? body.contextGraphId);
    let registerOpts: any = null;
    const storedReads: Array<any[]> = [];
    // Wrap any per-case override of the canonical stored-options reader so we
    // always capture the (cgId) the route reads — proving it reads the resolved
    // CG id, and (via the body-wins case) that it reads LAZILY only when the
    // body omitted the policy. The wrapper stays AFTER `...restOverrides` so a
    // case override cannot drop the capture.
    const { getStoredContextGraphRegistrationOptions: overrideStored, ...restOverrides } = agentOverrides;
    const agent: any = {
      listContextGraphs: async () => [{
        id: contextGraphId,
        uri: `did:dkg:context-graph:${contextGraphId}`,
        subscribed: true,
        synced: true,
      }],
      resolveAgentByToken: () => undefined,
      registerContextGraph: async (_id: string, opts: any) => {
        registerOpts = opts;
        return { onChainId: '42', txHash: '0x' + 'ab'.repeat(32) };
      },
      ...restOverrides,
      // PR #1423 R7 — the route reads the create-time policy from the canonical
      // `getStoredContextGraphRegistrationOptions` reader (the caller-shaped
      // shared resolver was removed) and applies body-wins itself. These ROUTE
      // tests stub that reader per-case AND record its (cgId) args, so they
      // assert ROUTE behavior — including the LAZY read (no call when the body
      // supplied the policy). The wrapper stays AFTER `...restOverrides` so a
      // case override cannot drop the capture.
      getStoredContextGraphRegistrationOptions: async (...a: any[]) => {
        storedReads.push(a);
        return overrideStored
          ? overrideStored(...a)
          : { publishPolicy: undefined, publishAuthorityAccountId: undefined };
      },
    };
    const routeServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      await handleContextGraphRoutes({
        req, res, agent,
        publisherControl: {}, publisherRuntime: null, config: {}, startedAt: Date.now(),
        dashDb: {}, opWallets: {}, network: {}, tracker: {}, memoryManager: {},
        bridgeAuthToken: undefined, nodeVersion: 'test', nodeCommit: 'test',
        catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
        extractionRegistry: {}, fileStore: {}, extractionStatus: new Map(),
        assertionImportLocks: new Map(), vectorStore: {}, embeddingProvider: null,
        validTokens: new Set(), apiHost: '127.0.0.1', apiPortRef: { value: 0 },
        routePlugins: [], url, path: url.pathname, requestToken: undefined,
        requestAgentAddress: '0x0000000000000000000000000000000000000001',
      } as any);
      if (!res.writableEnded) { res.statusCode = 404; res.end(); }
    });
    try {
      await new Promise<void>((resolve) => routeServer.listen(0, '127.0.0.1', resolve));
      const address = routeServer.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      const resp = await fetch(`http://127.0.0.1:${address.port}/api/context-graph/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: resp.status, json: await resp.json(), registerOpts, storedReads };
    } finally {
      await new Promise<void>((resolve, reject) => routeServer.close((e) => (e ? reject(e) : resolve())));
    }
  }

  it('#1085 /register rehydrates the stored publishPolicy when the body omits it', async () => {
    const { status, registerOpts, storedReads } = await runRegisterRouteCaptureOpts(
      { id: 'effective-policy-cg' }, // body omits publishPolicy → route reads stored
      { getStoredContextGraphRegistrationOptions: async () => ({ publishPolicy: 0, publishAuthorityAccountId: undefined }) },
    );
    expect(status).toBe(200);
    // Body omitted the policy, so the route reads stored for the resolved CG id
    // and rehydrates the create-time policy to the chain layer.
    expect(storedReads).toEqual([['effective-policy-cg']]);
    expect(registerOpts.publishPolicy).toBe(0);
    // pcaAccountId is explicit-only — the stored PCA is never forwarded.
    expect(registerOpts.publishAuthorityAccountId).toBeUndefined();
  });

  it('#1085 /register body publishPolicy wins WITHOUT a stored read (lazy)', async () => {
    const { status, registerOpts, storedReads } = await runRegisterRouteCaptureOpts(
      { id: 'body-policy-cg', publishPolicy: 1 },
      { getStoredContextGraphRegistrationOptions: async () => ({ publishPolicy: 0, publishAuthorityAccountId: undefined }) },
    );
    expect(status).toBe(200);
    // The body decided the policy, so the route must NOT read stored at all (the
    // lazy-read contract) and the body value reaches the chain verbatim. A
    // regression that dropped the body override — reading stored and using 0 —
    // fails both assertions.
    expect(storedReads).toEqual([]);
    expect(registerOpts.publishPolicy).toBe(1);
  });

  it('#1085 explicit pcaAccountId + effective OPEN policy (rehydrated) → 400 before registerContextGraph', async () => {
    const { status, json, registerOpts, storedReads } = await runRegisterRouteCaptureOpts(
      { id: 'open-cg', pcaAccountId: '7' }, // body omits publishPolicy → reads stored
      { getStoredContextGraphRegistrationOptions: async () => ({ publishPolicy: 1, publishAuthorityAccountId: undefined }) },
    );
    // Stored policy is open (1); an explicit pcaAccountId against the EFFECTIVE
    // (rehydrated) policy is rejected at the route boundary — before register.
    expect(storedReads).toEqual([['open-cg']]);
    expect(status).toBe(400);
    expect(json.error).toMatch(/pcaAccountId is only valid for curated/);
    expect(registerOpts).toBeNull();
  });

  it('#1085 route never reads/forwards the stored publishAuthorityAccountId — explicit-only', async () => {
    const { status, registerOpts } = await runRegisterRouteCaptureOpts(
      { id: 'pca-explicit-only-cg' }, // body omits pcaAccountId + publishPolicy
      { getStoredContextGraphRegistrationOptions: async () => ({ publishPolicy: 0, publishAuthorityAccountId: 999n }) },
    );
    expect(status).toBe(200);
    expect(registerOpts.publishPolicy).toBe(0); // rehydrated
    // The store surfaced a PCA id, but the route forwards ONLY the request
    // body's pcaAccountId (absent here) — never the stored one.
    expect(registerOpts.publishAuthorityAccountId).toBeUndefined();
  });

  it('#1085 stored-read throw is best-effort AT THE ROUTE — 200, request/default policy, warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { status, registerOpts } = await runRegisterRouteCaptureOpts(
        { id: 'read-error-cg' }, // body omits publishPolicy → reads stored (which throws)
        { getStoredContextGraphRegistrationOptions: async () => { throw new Error('store down'); } },
      );
      // The store reader throws; the /register route owns the best-effort fall-
      // back — it must NOT 500. Registration proceeds with the request/default
      // policy, and the fall-back is observable (warned), not silent.
      expect(status).toBe(200);
      expect(registerOpts.publishPolicy).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

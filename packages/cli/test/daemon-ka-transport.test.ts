// SPDX-License-Identifier: Apache-2.0
// Route-level coverage of the chain-RPC transport-status mapping on the named
// KA VM publish catch (#1329 review). This route has its own catch with
// route-specific branches BEFORE the shared classifyChainRpcTransportStatus
// call, so a route regression would not be caught by the helper unit test alone.
// Driven in-process via handleKnowledgeAssetsRoutes with a stub agent — no
// daemon / storage / native deps.
import { describe, it, expect } from 'vitest';
import { ChainRpcTransportError } from '@origintrail-official/dkg-chain';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '', headers: {} };
  res.writeHead = (status: number, headers?: any) => { res.statusCode = status; if (headers) Object.assign(res.headers, headers); return res; };
  res.setHeader = (k: string, v: any) => { res.headers[k] = v; };
  res.getHeader = (k: string) => res.headers[k];
  res.end = (body?: string) => { if (body !== undefined) res.body = body; };
  return res;
}

function runKaCtx(method: string, rawPath: string, agent: any, body?: unknown) {
  const res = fakeRes();
  const req: any = { method, url: rawPath };
  if (body !== undefined) req.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  const url = new URL(`http://127.0.0.1${rawPath}`);
  const ctx = { req, res, agent, path: url.pathname, url } as unknown as RequestContext;
  return { res, done: handleKnowledgeAssetsRoutes(ctx) };
}

// A write-preflight probe that fast-accepts a public, locally-writable CG, so
// resolveRequiredWriteContextGraphId returns the id without listContextGraphs.
const ACCEPT_PROBE = {
  exists: true,
  hasLocalContent: true,
  declarationFound: true,
  accessPolicy: 'public',
  callerAuthorized: true,
};
function publishAgent(extra: Record<string, unknown>) {
  return { probeContextGraphWritePreflight: async () => ACCEPT_PROBE, ...extra };
}
function exhaustion() {
  const e: any = new Error(
    'publish transaction preparation failed on all configured RPC endpoints ' +
    '(https://rpc.example/v2/SECRETKEY, https://backup.example): boom',
  );
  e.code = 'RPC_ENDPOINTS_EXHAUSTED';
  e.rpcUrls = ['https://rpc.example/v2/SECRETKEY', 'https://backup.example'];
  return e;
}
function timeoutErr() {
  // The adapter throws a ChainRpcTransportError instance for a receipt-wait
  // timeout; the guard recognises TIMEOUT via the instance, not a bare code.
  return new ChainRpcTransportError('RPC_TIMEOUT', 'tx 0xabc timed out waiting for a receipt after 180000ms');
}

describe('knowledge-assets publish routes — transport-status mapping (#1329)', () => {
  describe('POST /api/knowledge-assets/publish (removed)', () => {
    it('→ 404 without invoking agent.publish', async () => {
      let called = false;
      const agent = publishAgent({ publish: async () => { called = true; } });
      const { res, done } = runKaCtx('POST', '/api/knowledge-assets/publish', agent, { contextGraphId: 'cg-1', quads: [] });
      await done;
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe('DIRECT_PUBLISH_ROUTE_REMOVED');
      expect(called).toBe(false);
    });
  });

  describe('POST /api/knowledge-assets/:name/vm/publish (per-KA sealed mint)', () => {
    it('→ 503 on RPC_ENDPOINTS_EXHAUSTED, sanitized', async () => {
      const agent = publishAgent({ publishFromFinalizedAssertion: async () => { throw exhaustion(); } });
      const { res, done } = runKaCtx('POST', '/api/knowledge-assets/my-ka/vm/publish', agent, { contextGraphId: 'cg-1' });
      await done;
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).code).toBe('RPC_ENDPOINTS_EXHAUSTED');
      expect(res.body).not.toContain('://');
      expect(res.body).not.toContain('SECRETKEY');
    });

    it('→ 504 on a bounded chain TIMEOUT', async () => {
      const agent = publishAgent({ publishFromFinalizedAssertion: async () => { throw timeoutErr(); } });
      const { res, done } = runKaCtx('POST', '/api/knowledge-assets/my-ka/vm/publish', agent, { contextGraphId: 'cg-1' });
      await done;
      expect(res.statusCode).toBe(504);
    });
  });
});

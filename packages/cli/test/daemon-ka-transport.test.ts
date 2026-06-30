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
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '', headers: {} };
  res.writeHead = (status: number, headers?: any) => { res.statusCode = status; if (headers) Object.assign(res.headers, headers); return res; };
  res.setHeader = (k: string, v: any) => { res.headers[k] = v; };
  res.getHeader = (k: string) => res.headers[k];
  res.end = (body?: string) => { if (body !== undefined) res.body = body; };
  return res;
}

function runKaCtx(
  method: string,
  rawPath: string,
  agent: any,
  body?: unknown,
  ctxOverrides: Partial<RequestContext> = {},
) {
  const res = fakeRes();
  const req: any = { method, url: rawPath };
  if (body !== undefined) req.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  const url = new URL(`http://127.0.0.1${rawPath}`);
  const ctx = { req, res, agent, path: url.pathname, url, ...ctxOverrides } as unknown as RequestContext;
  return { res, done: handleKnowledgeAssetsRoutes(ctx) };
}

function runMemoryCtx(method: string, rawPath: string, agent: any, body?: unknown) {
  const res = fakeRes();
  const req: any = { method, url: rawPath };
  if (body !== undefined) req.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  const url = new URL(`http://127.0.0.1${rawPath}`);
  const ctx = { req, res, agent, path: url.pathname, url } as unknown as RequestContext;
  return { res, done: handleMemoryRoutes(ctx) };
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

const FAILED_VERIFY_RESULT = {
  ok: false,
  expectedRoot: `0x${'11'.repeat(32)}`,
  actualRoot: `0x${'22'.repeat(32)}`,
  leafCount: 1,
  reason: 'root-mismatch',
};

function batchRejectionAgent(extra: Record<string, unknown> = {}) {
  const calls: Array<{ op: string; opts?: unknown }> = [];
  const agent = publishAgent({
    assertion: {
      create: async (_contextGraphId: string, _name: string, opts?: unknown) => {
        calls.push({ op: 'create', opts });
      },
      write: async (_contextGraphId: string, _name: string, _quads: unknown[], opts?: unknown) => {
        calls.push({ op: 'write', opts });
      },
      finalize: async (_contextGraphId: string, _name: string, opts?: unknown) => {
        calls.push({ op: 'finalize', opts });
      },
      promote: async (_contextGraphId: string, _name: string, opts?: unknown) => {
        calls.push({ op: 'promote', opts });
        return { shareOperationId: 'share-op-1', promotedCount: 8 };
      },
    },
    ...extra,
  });
  return { agent, calls };
}

describe('knowledge-assets publish routes — transport-status mapping (#1329)', () => {
  it('does not serve KA batch-rejection endpoints from memory routes', async () => {
    const { res, done } = runMemoryCtx(
      'POST',
      '/api/knowledge-assets/batch-rejections/report',
      { resolveAgentByToken: () => undefined },
      { contextGraphId: 'cg-1', verifyResult: { ok: false } },
    );
    await done;
    expect(res.statusCode).toBe(0);
    expect(res.body).toBe('');
  });

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

  describe('POST /api/knowledge-assets/batch-rejections/report', () => {
    it('accepts an explicit rejectedBy only when it matches the request identity', async () => {
      const { agent, calls } = batchRejectionAgent({
        peerId: 'local-peer',
        resolveAgentByToken: () => undefined,
      });
      const { res, done } = runKaCtx(
        'POST',
        '/api/knowledge-assets/batch-rejections/report',
        agent,
        {
          contextGraphId: 'cg-1',
          batchId: 'batch-1',
          verifyResult: FAILED_VERIFY_RESULT,
          rejectedBy: {
            agentAddress: '0x00000000000000000000000000000000000000AA',
            peerId: 'explicit-peer',
          },
        },
        { requestAgentAddress: '0x00000000000000000000000000000000000000aa' },
      );

      await done;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.record.rejectedBy).toEqual({
        agentAddress: '0x00000000000000000000000000000000000000aa',
        peerId: 'local-peer',
      });
      expect(calls.map((call) => call.opts)).toEqual([{}, {}, {}, {}]);
    });

    it('rejects a mismatched explicit rejectedBy before writing lifecycle state', async () => {
      const { agent, calls } = batchRejectionAgent({
        peerId: 'local-peer',
        resolveAgentByToken: () => undefined,
      });
      const { res, done } = runKaCtx(
        'POST',
        '/api/knowledge-assets/batch-rejections/report',
        agent,
        {
          contextGraphId: 'cg-1',
          batchId: 'batch-spoof',
          verifyResult: FAILED_VERIFY_RESULT,
          rejectedBy: {
            agentAddress: '0x00000000000000000000000000000000000000ee',
            peerId: 'explicit-peer',
          },
        },
        { requestAgentAddress: '0x00000000000000000000000000000000000000aa' },
      );

      await done;
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('REJECTED_BY_AGENT_MISMATCH');
      expect(calls).toEqual([]);
    });

    it('uses the authenticated agent-token identity and storage lane', async () => {
      const tokenAgentAddress = '0x00000000000000000000000000000000000000ab';
      const { agent, calls } = batchRejectionAgent({
        peerId: 'local-peer',
        resolveAgentByToken: (token?: string) => token === 'agent-token' ? tokenAgentAddress : undefined,
      });
      const { res, done } = runKaCtx(
        'POST',
        '/api/knowledge-assets/batch-rejections/report',
        agent,
        {
          contextGraphId: 'cg-1',
          batchId: 'batch-2',
          verifyResult: FAILED_VERIFY_RESULT,
        },
        {
          requestToken: 'agent-token',
          requestAgentAddress: '0x00000000000000000000000000000000000000dc',
        },
      );

      await done;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.record.rejectedBy).toEqual({
        agentAddress: tokenAgentAddress,
        peerId: 'local-peer',
      });
      expect(calls.map((call) => call.opts)).toEqual([
        { agentAddress: tokenAgentAddress },
        { agentAddress: tokenAgentAddress },
        { agentAddress: tokenAgentAddress, authorAgentAddress: tokenAgentAddress },
        { agentAddress: tokenAgentAddress, authorAgentAddress: tokenAgentAddress },
      ]);
    });

    it('falls back to unknown when no route identity is available', async () => {
      const { agent } = batchRejectionAgent({
        resolveAgentByToken: () => undefined,
      });
      const { res, done } = runKaCtx(
        'POST',
        '/api/knowledge-assets/batch-rejections/report',
        agent,
        {
          contextGraphId: 'cg-1',
          batchId: 'batch-3',
          verifyResult: FAILED_VERIFY_RESULT,
        },
        { requestAgentAddress: '' },
      );

      await done;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.record.rejectedBy).toEqual({ agentAddress: 'unknown' });
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

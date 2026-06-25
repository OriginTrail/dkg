// SPDX-License-Identifier: Apache-2.0
// Route-level coverage of the chain-RPC transport-status mapping on the
// knowledge-assets publish catches (#1329 review). Each route has its OWN
// catch with route-specific branches BEFORE the shared
// classifyChainRpcTransportStatus call, so a per-route regression (removing or
// misordering the call) would not be caught by the helper unit test alone.
// Driven in-process via handleKnowledgeAssetsRoutes with a stub agent — no
// daemon / storage / native deps.
import { describe, it, expect } from 'vitest';
import { ChainRpcTransportError } from '@origintrail-official/dkg-chain';
import { DKG_CHUNK_VALUE, DKG_HAS_TEXT_BODY } from '@origintrail-official/dkg-core';
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
// Direct-publish requires isPublishQuad shape (graph is REQUIRED here).
const QUADS = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: 'ex:g' }];

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
function revert() {
  const e: any = new Error('execution reverted');
  e.code = 'CALL_EXCEPTION';
  return e;
}

describe('knowledge-assets publish routes — transport-status mapping (#1329)', () => {
  describe('POST /api/knowledge-assets/publish (direct explicit-quads mint)', () => {
    it('returns literalRewrites after oversized schema:text normalization on success', async () => {
      const root = 'http://example.org/direct-oversized';
      const oversized = `"${'x'.repeat(60_000)}"`;
      let publishedQuads: any[] = [];
      const agent = publishAgent({
        publish: async (_cg: string, quads: any[]) => {
          publishedQuads = quads;
          return {
            status: 'confirmed',
            kaId: '42',
            kaManifest: [{ tokenId: '42', rootEntity: root }],
          };
        },
      });

      const { res, done } = runKaCtx('POST', '/api/knowledge-assets/publish', agent, {
        contextGraphId: 'cg-1',
        quads: [{ subject: root, predicate: 'http://schema.org/text', object: oversized, graph: '' }],
      });

      await done;
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.literalRewrites).toHaveLength(1);
      expect(body.literalRewrites[0]).toMatchObject({
        subject: root,
        predicate: 'http://schema.org/text',
        graph: '',
        originalMutf8Bytes: 60_002,
      });
      expect(publishedQuads.some((quad) => quad.predicate === 'http://schema.org/text')).toBe(false);
      expect(publishedQuads.some((quad) => quad.predicate === DKG_HAS_TEXT_BODY)).toBe(true);
      expect(publishedQuads.some((quad) => quad.predicate === DKG_CHUNK_VALUE)).toBe(true);
      expect(publishedQuads.every((quad) => quad.graph === '')).toBe(true);
    });

    it('→ 503 on RPC_ENDPOINTS_EXHAUSTED, with a sanitized body (no URL/key leak)', async () => {
      const agent = publishAgent({ publish: async () => { throw exhaustion(); } });
      const { res, done } = runKaCtx('POST', '/api/knowledge-assets/publish', agent, { contextGraphId: 'cg-1', quads: QUADS });
      await done;
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).code).toBe('RPC_ENDPOINTS_EXHAUSTED');
      expect(res.body).not.toContain('://');
      expect(res.body).not.toContain('SECRETKEY');
    });

    it('→ 504 on a bounded chain TIMEOUT', async () => {
      const agent = publishAgent({ publish: async () => { throw timeoutErr(); } });
      const { res, done } = runKaCtx('POST', '/api/knowledge-assets/publish', agent, { contextGraphId: 'cg-1', quads: QUADS });
      await done;
      expect(res.statusCode).toBe(504);
    });

    it('→ 500 (NOT down-classified) for a genuine on-chain revert', async () => {
      const agent = publishAgent({ publish: async () => { throw revert(); } });
      const { res, done } = runKaCtx('POST', '/api/knowledge-assets/publish', agent, { contextGraphId: 'cg-1', quads: QUADS });
      await done;
      expect(res.statusCode).toBe(500);
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

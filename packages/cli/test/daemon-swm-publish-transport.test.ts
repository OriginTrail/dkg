// SPDX-License-Identifier: Apache-2.0
// Route-level coverage of the chain-RPC transport-status mapping on the SWM
// publish AUTO-REGISTER catch (#1329 review follow-up). /api/shared-memory/publish
// transparently registers the context graph on-chain before publishing; the
// catch around that registration returns 400 for a genuine failure, so a
// transient RPC exhaustion there must be mapped to a retryable 503/504 FIRST —
// otherwise a flaky RPC tells retry-aware clients to give up. The shared-helper
// unit test cannot prove this catch is reached before the 400, and the KA/PCA
// tests drive different handlers. Driven in-process via handleMemoryRoutes with
// a stub agent — no daemon / storage / native deps.
import { describe, it, expect } from 'vitest';
import { ChainRpcTransportError } from '@origintrail-official/dkg-chain';
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

// trackPhase must invoke (and not swallow) the wrapped action so a thrown
// registration error reaches the route catch.
const noopTracker = {
  start() {}, fail() {}, complete() {}, setCost() {}, setTxHash() {},
  trackPhase: (_c: unknown, _n: unknown, fn: () => unknown) => fn(),
};

function runSwmPublish(agent: any, body: unknown) {
  const res = fakeRes();
  const rawPath = '/api/shared-memory/publish';
  const req: any = { method: 'POST', url: rawPath, headers: {}, __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)) };
  const url = new URL(`http://127.0.0.1${rawPath}`);
  const ctx = {
    req, res, agent, path: url.pathname, url,
    tracker: noopTracker,
    config: { chain: { type: 'mock' } },
    network: null,
  } as unknown as RequestContext;
  return { res, done: handleMemoryRoutes(ctx) };
}

// Fast-accept a public, locally-writable CG so resolveRequiredWriteContextGraphId
// returns the id without a real store scan.
const ACCEPT_PROBE = {
  exists: true, hasLocalContent: true, declarationFound: true,
  accessPolicy: 'public', callerAuthorized: true,
};
const ROOT = 'http://example.org/root1';

// Stub agent that traverses the SWM publish path up to the on-chain
// auto-registration, where registerContextGraph throws `registerThrows`.
// `selection: [ROOT]` resolves exactly one publishable root (so the empty-SWM
// and multi-root guards pass) AND skips the "all"-mode empty-SWM preflight, so
// control reaches the registration leg deterministically.
function swmPublishAgent(registerThrows: any) {
  return {
    probeContextGraphWritePreflight: async () => ACCEPT_PROBE,
    store: { query: async () => ({ type: 'quads', quads: [{ subject: ROOT, predicate: 'http://example.org/p', object: '"x"' }] }) },
    getContextGraphOnChainId: async () => null,
    getStoredContextGraphRegistrationOptions: async () => ({}),
    registerContextGraph: async () => { throw registerThrows; },
  };
}

function exhaustion() {
  const e: any = new Error('register transaction preparation failed on all configured RPC endpoints (https://rpc.example/v2/SECRETKEY, https://backup.example): boom');
  e.code = 'RPC_ENDPOINTS_EXHAUSTED';
  e.rpcUrls = ['https://rpc.example/v2/SECRETKEY', 'https://backup.example'];
  return e;
}
function timeoutErr() {
  // The adapter throws a ChainRpcTransportError instance for a receipt-wait
  // timeout; the guard recognises TIMEOUT via the instance, not a bare code.
  return new ChainRpcTransportError('RPC_TIMEOUT', 'register tx 0xabc timed out waiting for a receipt after 180000ms');
}
function insufficientFunds() {
  const e: any = new Error('insufficient funds for intrinsic transaction cost');
  e.code = 'INSUFFICIENT_FUNDS';
  return e;
}

describe('POST /api/shared-memory/publish — auto-register transport mapping (#1329)', () => {
  it('→ 503 (sanitized) when on-chain auto-registration exhausts every RPC, NOT 400', async () => {
    const { res, done } = runSwmPublish(swmPublishAgent(exhaustion()), { contextGraphId: 'cg-1', selection: [ROOT] });
    await done;
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect(res.body).not.toContain('://');
    expect(res.body).not.toContain('SECRETKEY');
  });

  it('→ 504 on a bounded chain TIMEOUT during auto-registration', async () => {
    const { res, done } = runSwmPublish(swmPublishAgent(timeoutErr()), { contextGraphId: 'cg-1', selection: [ROOT] });
    await done;
    expect(res.statusCode).toBe(504);
  });

  it('→ 400 (unchanged) for a genuine, non-transport registration failure', async () => {
    // INSUFFICIENT_FUNDS carries no transport code, so the catch must NOT
    // down-classify it to a retryable 503 — it stays the actionable 400.
    const { res, done } = runSwmPublish(swmPublishAgent(insufficientFunds()), { contextGraphId: 'cg-1', selection: [ROOT] });
    await done;
    expect(res.statusCode).toBe(400);
  });
});

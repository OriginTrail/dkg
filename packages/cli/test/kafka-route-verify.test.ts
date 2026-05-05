/**
 * Route-level tests for `POST /api/kafka/endpoint/verify`.
 *
 * These tests exercise the verify route handler with a mocked `RequestContext`,
 * because the order in which the route runs validation, fetch, and probe is
 * the surface where Bug 1 (Codex review on PR #395) lived: the rebase from
 * slice 04 had `validateKafkaAuthConsistency` running BEFORE the existing KA
 * was loaded, so a request that legitimately omitted `securityProtocol`
 * (relying on the recorded value as the documented default) was 400'd by the
 * shape-consistency check before the defaulting code had a chance to fill it
 * in. The smoke tests can't catch this — they hit a stub HTTP server, not the
 * actual route — so this file stands the route up directly.
 *
 * Mock surface: `agent.query` (for `getKafkaEndpoint` reads + the kcId
 * lookup) and `agent.update` (for the V10 update). No real chain, no real
 * publisher — the regression is in the route's orchestration, not the
 * downstream V10 plumbing.
 */
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleKafkaRoutes } from '../src/daemon/routes/kafka.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

const VALID_URI =
  'urn:dkg:kafka-endpoint:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:33b58f60595c766739f72b29e4ee417888d1a46af8339a4b5bdb1c3a5692f652';
const STORED_KA_BINDINGS = {
  endpoint: `<${VALID_URI}>`,
  broker: '"kafka.example.com:9092"',
  topic: '"orders.created"',
  messageFormat: '"application/json"',
  publisher: '<urn:dkg:agent:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd>',
  endpointUrl: '<kafka://kafka.example.com:9092/orders.created>',
  issued: '"2026-05-04T12:34:56.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
  verificationStatus: '"verified"',
  verifiedAt: '"2026-05-04T12:35:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
  securityProtocol: '"PLAINTEXT"',
};

interface CapturedResponse {
  status: number;
  body: unknown;
}

function buildMockReq(method: string, path: string, body: unknown): Readable & { method: string; url: string } {
  const stream = new Readable();
  stream.push(JSON.stringify(body));
  stream.push(null);
  Object.assign(stream, { method, url: path, headers: {} });
  return stream as Readable & { method: string; url: string };
}

function buildMockRes(): { res: any; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: undefined };
  const res: any = {
    headersSent: false,
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(payload?: string) {
      if (payload !== undefined) {
        try {
          captured.body = JSON.parse(payload);
        } catch {
          captured.body = payload;
        }
      }
    },
  };
  return { res, captured };
}

interface MockAgentOptions {
  getEndpointBindings?: Array<Record<string, string>>;
  /** When set, agent.update will be a vi.fn that records its calls. */
  recordUpdates?: boolean;
}

function buildMockAgent(opts: MockAgentOptions = {}): any {
  const updateCalls: Array<{ uri: string; cgId: string; content: unknown }> = [];
  const queryCalls: Array<{ sparql: string; cgId: string | undefined }> = [];

  const agent = {
    query: vi.fn(async (sparql: string, options?: { contextGraphId?: string }) => {
      queryCalls.push({ sparql, cgId: options?.contextGraphId });
      // The route's queryEngine adapter calls `getKafkaEndpoint`'s SELECT.
      // We return the stored KA bindings for that read.
      return { bindings: opts.getEndpointBindings ?? [] };
    }),
    update: vi.fn(
      async (uriOrKcId: string | bigint, contextGraphId: string, content: unknown) => {
        updateCalls.push({
          uri: typeof uriOrKcId === 'string' ? uriOrKcId : '',
          cgId: contextGraphId,
          content,
        });
        return {};
      },
    ),
    publish: vi.fn(async () => ({})),
  };

  return { agent, updateCalls, queryCalls };
}

function buildCtx(req: any, res: any, agent: any): RequestContext {
  // Many RequestContext fields are unused by handleKafkaRoutes; cast to any
  // so we don't need a full DKGAgent / DkgConfig / OperationTracker. The
  // route reads only `req`, `res`, `agent`, `path`, `url`,
  // `requestAgentAddress`, plus slice 06's `requestToken` + `tokenStore`
  // for the scope guard — all populated below. The store maps the test
  // bearer token to scope `'*'` so verify-route assertions are unaffected
  // by the scope check (covered separately in `daemon-auth-scopes.test.ts`).
  const url = new URL(`http://localhost${req.url}`);
  const ROOT_TOKEN = 'ROOTROOT-verify-test-token';
  const tokenStore = new Map([
    [ROOT_TOKEN.slice(0, 8), {
      prefix: ROOT_TOKEN.slice(0, 8),
      fullToken: ROOT_TOKEN,
      scopes: '*' as const,
      source: 'file' as const,
    }],
  ]);
  // Mutate req headers so extractBearerToken finds the root token. The
  // route reads `ctx.requestToken` directly when set, but the daemon
  // pipeline derives it from req.headers.authorization — populating both
  // keeps the mock honest if either path is exercised.
  if (req.headers) req.headers.authorization = `Bearer ${ROOT_TOKEN}`;
  return {
    req,
    res,
    agent,
    path: url.pathname,
    url,
    requestAgentAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    requestToken: ROOT_TOKEN,
    tokenStore,
    validTokens: new Set([ROOT_TOKEN]),
    authEnabled: true,
  } as unknown as RequestContext;
}

describe('handleVerify — Bug 1: validation must run after the existing KA is loaded', () => {
  it('verify with no securityProtocol on the body succeeds when the stored KA records PLAINTEXT (defaulting)', async () => {
    // Bug 1 regression guard: before the fix, the rebased route called
    // `validateKafkaAuthConsistency` on the body alone, with the body's
    // `securityProtocol` undefined and no `sasl`/`ssl`. The validator's
    // "no protocol declared" branch is permissive ONLY when no auth blocks
    // are set — but the verify route also invokes `hasAnyKafkaCredentials`,
    // which was relying on `securityProtocol === 'PLAINTEXT'` from the body
    // to satisfy the creds-required gate. With both undefined the request
    // 400'd as "creds required" instead of falling back to the recorded
    // PLAINTEXT and probing.
    const { agent, updateCalls } = buildMockAgent({
      getEndpointBindings: [STORED_KA_BINDINGS],
    });
    const req = buildMockReq('POST', '/api/kafka/endpoint/verify', {
      contextGraphId: 'devnet-test',
      uri: VALID_URI,
      // NO securityProtocol, NO sasl, NO ssl — relies on stored PLAINTEXT.
    });
    const { res, captured } = buildMockRes();

    await handleKafkaRoutes(buildCtx(req, res, agent));

    // The stored KA records PLAINTEXT, so the verify route must default to
    // it AND treat that as the cred-equivalent (PLAINTEXT-with-no-creds is
    // a meaningful "is the broker reachable" probe per `hasAnyKafkaCredentials`).
    // The probe will fail (no real broker `kafka.example.com:9092`) but the
    // route must REACH the probe and then call `verifyKafkaEndpoint`, which
    // records the failure on the KA via `agent.update` and returns 200.
    //
    // Codex Issue B2: the previous `expect(updateCalls.length).toBeGreaterThanOrEqual(0)`
    // was tautological (length is always ≥ 0). Pin the concrete shape: the
    // route reached the URI-keyed `agent.update` and the response is 200.
    expect(captured.status).toBe(200);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].uri).toBe(VALID_URI);
    expect(updateCalls[0].cgId).toBe('devnet-test');
    // Pin the wire-shape too — a regression that 422'd or returned the
    // bare result without the probe block would slip through a status-only
    // check. The probe outcome lands on the response body.
    const body = captured.body as { verificationStatus?: string; probe?: { status?: string } };
    expect(body.verificationStatus).toBe('failed');
    expect(body.probe?.status).toMatch(/^(failed|unreachable)$/);
  }, 30_000);

  it('verify with no securityProtocol AND no creds on body, against a stored PLAINTEXT KA → succeeds (PLAINTEXT defaulting alone)', async () => {
    // The minimum-input case the brief calls out: URI + cg only, with the
    // stored KA carrying PLAINTEXT. Must reach `agent.update` (creds-
    // required gate is satisfied by the stored PLAINTEXT after defaulting).
    const { agent, updateCalls } = buildMockAgent({
      getEndpointBindings: [STORED_KA_BINDINGS],
    });
    const req = buildMockReq('POST', '/api/kafka/endpoint/verify', {
      contextGraphId: 'devnet-test',
      uri: VALID_URI,
    });
    const { res, captured } = buildMockRes();

    await handleKafkaRoutes(buildCtx(req, res, agent));

    // Codex Issue B2: tighten beyond `not.toBe(400)`. A regression that
    // returned 500 or skipped the update would have passed that check.
    expect(captured.status).toBe(200);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].uri).toBe(VALID_URI);
  }, 30_000);

  it('verify with no creds on body AND no recorded protocol → 400 (creds-required gate still fires)', async () => {
    // Regression-bound: when neither side supplies a protocol or any creds,
    // the route MUST still reject — Bug 1's fix moves the validation order,
    // not the creds-required semantic.
    const noProtocolBindings = { ...STORED_KA_BINDINGS };
    delete (noProtocolBindings as Partial<typeof STORED_KA_BINDINGS>).securityProtocol;
    const { agent, updateCalls } = buildMockAgent({
      getEndpointBindings: [noProtocolBindings],
    });
    const req = buildMockReq('POST', '/api/kafka/endpoint/verify', {
      contextGraphId: 'devnet-test',
      uri: VALID_URI,
    });
    const { res, captured } = buildMockRes();

    await handleKafkaRoutes(buildCtx(req, res, agent));

    expect(captured.status).toBe(400);
    const body = captured.body as { error?: string };
    // Either the creds-required gate fires (no auth at all) or the missing-
    // protocol gate fires once defaulting completes — both are 400 and both
    // mention something the caller can act on.
    expect(typeof body.error).toBe('string');
    // Defence in depth: a 400 must never have written through to the update
    // path. Pin the negative side too so a regression can't 400-then-also-
    // mutate.
    expect(updateCalls).toHaveLength(0);
  }, 30_000);

  it('verify with sasl on body but no securityProtocol on body or stored KA → 400 (effective consistency check fires)', async () => {
    // The effective-values consistency check must still catch genuine
    // misconfig: sasl block with nothing to anchor it to. Without a stored
    // protocol AND without a body protocol, the validator should reject —
    // even though it ran AFTER the KA load.
    const noProtocolBindings = { ...STORED_KA_BINDINGS };
    delete (noProtocolBindings as Partial<typeof STORED_KA_BINDINGS>).securityProtocol;
    const { agent, updateCalls } = buildMockAgent({
      getEndpointBindings: [noProtocolBindings],
    });
    const req = buildMockReq('POST', '/api/kafka/endpoint/verify', {
      contextGraphId: 'devnet-test',
      uri: VALID_URI,
      sasl: { mechanism: 'plain', username: 'alice', password: 'pw' },
    });
    const { res, captured } = buildMockRes();

    await handleKafkaRoutes(buildCtx(req, res, agent));

    expect(captured.status).toBe(400);
    expect(updateCalls).toHaveLength(0);
  }, 30_000);

  it('verify against a non-existent stored KA returns 404 (not 400) — the URI shape is fine, the KA just isn\'t there', async () => {
    // Regression guard: the no-KA path must surface as 404, not as a 400
    // from a too-eager validator running on the bare body.
    const { agent, updateCalls } = buildMockAgent({
      getEndpointBindings: [], // no rows → KA not found
    });
    const req = buildMockReq('POST', '/api/kafka/endpoint/verify', {
      contextGraphId: 'devnet-test',
      uri: VALID_URI,
      securityProtocol: 'PLAINTEXT',
    });
    const { res, captured } = buildMockRes();

    await handleKafkaRoutes(buildCtx(req, res, agent));

    expect(captured.status).toBe(404);
    expect(updateCalls).toHaveLength(0);
  }, 30_000);

  it('Codex Bug B3: verify reaches agent.update for a stored bare-SSL endpoint with no body creds', async () => {
    // Bug B3: an operator who registered an SSL endpoint via the system
    // trust store (no inline ca/cert/key, just `--security-protocol SSL`)
    // could register fine — `shouldProbe` accepts bare SSL — but
    // re-verify of the same endpoint with no body creds 400'd as
    // "Re-verify requires credentials". `hasAnyKafkaCredentials` accepted
    // bare PLAINTEXT but NOT bare SSL.
    //
    // Fix: SSL is now treated the same as PLAINTEXT in the precondition
    // gate. Verify must reach the probe → reach `agent.update` → 200,
    // mirroring the PLAINTEXT no-creds test above. The probe itself
    // resolves to `unreachable`/`failed` against the synthetic broker
    // hostname (kafkajs returns KafkaJSNumberOfRetriesExceeded quickly
    // because the hostname doesn't resolve); the load-bearing assertion is
    // that the route DIDN'T 400 — agent.update was called and the response
    // is 200 with the failure recorded on the KA.
    const sslBindings = {
      ...STORED_KA_BINDINGS,
      securityProtocol: '"SSL"',
    };
    const { agent, updateCalls } = buildMockAgent({
      getEndpointBindings: [sslBindings],
    });
    const req = buildMockReq('POST', '/api/kafka/endpoint/verify', {
      contextGraphId: 'devnet-test',
      uri: VALID_URI,
      // NO securityProtocol, NO sasl, NO ssl — bare-SSL re-verify defaults
      // securityProtocol from the stored KA.
    });
    const { res, captured } = buildMockRes();

    await handleKafkaRoutes(buildCtx(req, res, agent));

    expect(captured.status).toBe(200);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].uri).toBe(VALID_URI);
    expect(updateCalls[0].cgId).toBe('devnet-test');
    const body = captured.body as { verificationStatus?: string; probe?: { status?: string } };
    expect(body.verificationStatus).toBe('failed');
    expect(body.probe?.status).toMatch(/^(failed|unreachable)$/);
  }, 30_000);
});

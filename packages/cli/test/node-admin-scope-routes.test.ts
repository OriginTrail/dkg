import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AllowedHttpAuthentication } from '../src/auth.js';
import type { DkgConfig } from '../src/config.js';
import { handleRequest, type HandleRequestInput } from '../src/daemon/handle-request.js';
import { handleAgentChatRoutes } from '../src/daemon/routes/agent-chat.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { handleLocalAgentsRoutes } from '../src/daemon/routes/local-agents.js';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import { handleStatusRoutes } from '../src/daemon/routes/status.js';
import { handleSharedMemoryTtlSettingsRequest } from '../src/daemon/shared-memory-ttl-route.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

// Node-wide operations accept only callers that can administer the node: a
// node-operator token, or any caller when daemon auth is disabled. An
// agent-scoped token is answered with 403 before the route reads its body or
// touches node state.

const AGENT = requestAuthentication({ kind: 'agent', agentAddress: '0x00000000000000000000000000000000000000a1' });
const OPERATOR = requestAuthentication({ kind: 'nodeOperator' });
const AUTH_DISABLED = requestAuthentication({ kind: 'anonymous', mode: 'disabled' });

function fakeReq(method: string, path: string, rawBody = '') {
  const req = Readable.from([]);
  Object.assign(req, {
    method,
    url: path,
    headers: { host: '127.0.0.1' },
    __dkgPrebufferedBody: Buffer.from(rawBody, 'utf8'),
  });
  return req as unknown as RequestContext['req'];
}

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writableEnded: false,
    headersSent: false,
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; },
    end(body?: string) { this.body = body ?? ''; this.writableEnded = true; return this; },
  };
}

type RouteHandler = (ctx: RequestContext) => Promise<void>;

async function callRoute(
  handler: RouteHandler,
  method: string,
  path: string,
  authentication: AllowedHttpAuthentication,
  opts: { body?: string; agent?: Record<string, unknown>; overrides?: Record<string, unknown> } = {},
) {
  const res = fakeRes();
  const url = new URL(`http://127.0.0.1${path}`);
  const ctx = {
    req: fakeReq(method, path, opts.body),
    res: res as unknown as ServerResponse,
    agent: opts.agent ?? {},
    config: {} as DkgConfig,
    validTokens: new Set<string>(),
    url,
    path: url.pathname,
    authentication,
    requestAgentAddress: '0x00000000000000000000000000000000000000a1',
    ...opts.overrides,
  } as unknown as RequestContext;
  await handler(ctx);
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) as Record<string, unknown> : {},
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('node-wide status routes require node-admin scope', () => {
  it('POST /api/shutdown: agent token → 403 and the node keeps running', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.useFakeTimers();

    const res = await callRoute(handleStatusRoutes, 'POST', '/api/shutdown', AGENT);
    vi.advanceTimersByTime(1_000);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/requires a node-level admin token/);
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([
    ['node-operator token', OPERATOR],
    ['auth disabled', AUTH_DISABLED],
  ])('POST /api/shutdown: %s → 200 and SIGTERM', async (_label, authentication) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.useFakeTimers();

    const res = await callRoute(handleStatusRoutes, 'POST', '/api/shutdown', authentication);
    vi.advanceTimersByTime(1_000);

    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  it('is enforced through the top-level dispatcher', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.useFakeTimers();
    const res = fakeRes();

    await handleRequest({
      req: fakeReq('POST', '/api/shutdown'),
      res,
      agent: { resolveAgentAddress: () => '0x00000000000000000000000000000000000000a1' },
      authentication: AGENT,
    } as unknown as HandleRequestInput);
    vi.advanceTimersByTime(1_000);

    expect(res.statusCode).toBe(403);
    expect(kill).not.toHaveBeenCalled();
  });

  it('POST /api/identity/ensure: agent token → 403 without touching the chain', async () => {
    const ensureIdentity = vi.fn(async () => 7n);
    const denied = await callRoute(handleStatusRoutes, 'POST', '/api/identity/ensure', AGENT, { agent: { ensureIdentity } });
    expect(denied.status).toBe(403);
    expect(ensureIdentity).not.toHaveBeenCalled();

    const allowed = await callRoute(handleStatusRoutes, 'POST', '/api/identity/ensure', OPERATOR, { agent: { ensureIdentity } });
    expect(allowed).toEqual({ status: 200, body: { identityId: '7', hasIdentity: true } });
    expect(ensureIdentity).toHaveBeenCalledTimes(1);
  });

  it('POST /api/register-adapter: agent token → 403; operator reaches body validation', async () => {
    const denied = await callRoute(handleStatusRoutes, 'POST', '/api/register-adapter', AGENT, { body: '{"id":"openclaw"}' });
    expect(denied.status).toBe(403);

    const allowed = await callRoute(handleStatusRoutes, 'POST', '/api/register-adapter', OPERATOR, { body: '{bad' });
    expect(allowed).toEqual({ status: 400, body: { error: 'Invalid JSON body' } });
  });

  it('POST /api/random-sampling/backfill-percgid-meta: agent token → 403 before reading subscriptions', async () => {
    const getSubscribedContextGraphs = vi.fn(() => new Map());
    const path = '/api/random-sampling/backfill-percgid-meta';
    const denied = await callRoute(handleStatusRoutes, 'POST', path, AGENT, { body: '{}', agent: { getSubscribedContextGraphs } });
    expect(denied.status).toBe(403);
    expect(getSubscribedContextGraphs).not.toHaveBeenCalled();

    const allowed = await callRoute(handleStatusRoutes, 'POST', path, OPERATOR, { body: '{bad' });
    expect(allowed).toEqual({ status: 400, body: { error: 'Invalid JSON body' } });
  });

  it('leaves the read-only status routes open to agent tokens', async () => {
    const res = await callRoute(handleStatusRoutes, 'GET', '/api/identity', AGENT, {
      agent: { publisher: { getIdentityId: () => 3n } },
    });
    expect(res).toEqual({ status: 200, body: { identityId: '3', hasIdentity: true } });
  });
});

describe('bulk publisher-queue changes require node-admin scope', () => {
  function publisherControl() {
    return { cancel: vi.fn(async () => {}), clear: vi.fn(async () => 2) };
  }

  it('POST /api/publisher/cancel: agent token → 403; operator reaches validation', async () => {
    const control = publisherControl();
    const overrides = { publisherControl: control };
    const denied = await callRoute(handlePublisherRoutes, 'POST', '/api/publisher/cancel', AGENT, { body: '{"jobId":"j1"}', overrides });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/agent-scoped tokens cannot cancel publisher jobs/);
    expect(control.cancel).not.toHaveBeenCalled();

    const allowed = await callRoute(handlePublisherRoutes, 'POST', '/api/publisher/cancel', OPERATOR, { body: '{}', overrides });
    expect(allowed).toEqual({ status: 400, body: { error: 'Missing jobId' } });
    const disabled = await callRoute(handlePublisherRoutes, 'POST', '/api/publisher/cancel', AUTH_DISABLED, { body: '{"jobId":"j2"}', overrides });
    expect(disabled).toEqual({ status: 200, body: { cancelled: 'j2' } });
  });

  it('POST /api/publisher/clear: agent token → 403; operator reaches validation', async () => {
    const control = publisherControl();
    const overrides = { publisherControl: control };
    const denied = await callRoute(handlePublisherRoutes, 'POST', '/api/publisher/clear', AGENT, { body: '{"status":"failed"}', overrides });
    expect(denied.status).toBe(403);
    expect(control.clear).not.toHaveBeenCalled();

    const allowed = await callRoute(handlePublisherRoutes, 'POST', '/api/publisher/clear', OPERATOR, { body: '{"status":"queued"}', overrides });
    expect(allowed).toEqual({ status: 400, body: { error: 'status must be failed or finalized' } });
  });

  it('POST /api/publisher/retry: agent token → 403 before any job is reaccepted; operator reaches validation', async () => {
    const retryDetailed = vi.fn(async () => ({ retried: 3, blockedPendingRecovery: 0, skipped: 0 }));
    const overrides = { publisherControl: { retryDetailed } };
    const denied = await callRoute(handlePublisherRoutes, 'POST', '/api/publisher/retry', AGENT, { body: '{"status":"failed"}', overrides });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/agent-scoped tokens cannot reaccept publisher jobs/);
    expect(retryDetailed).not.toHaveBeenCalled();

    const allowed = await callRoute(handlePublisherRoutes, 'POST', '/api/publisher/retry', OPERATOR, { body: '{"status":"queued"}', overrides });
    expect(allowed).toEqual({ status: 400, body: { error: 'Only status=failed is supported' } });
    expect(retryDetailed).not.toHaveBeenCalled();
    const disabled = await callRoute(handlePublisherRoutes, 'POST', '/api/publisher/retry', AUTH_DISABLED, { body: '{"status":"failed"}', overrides });
    expect(disabled).toEqual({ status: 200, body: { retried: 3, blockedPendingRecovery: 0, skipped: 0 } });
  });
});

describe('local agent integration changes require node-admin scope', () => {
  it.each([
    ['PUT', '/api/local-agent-integrations/openclaw'],
    ['POST', '/api/local-agent-integrations/connect'],
  ])('%s %s: agent token → 403; operator reaches body validation', async (method, path) => {
    const config = {} as DkgConfig;
    const denied = await callRoute(handleLocalAgentsRoutes, method, path, AGENT, {
      body: '{"id":"openclaw","enabled":true}',
      overrides: { config },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/requires a node-level admin token/);
    expect(config).toEqual({});

    const allowed = await callRoute(handleLocalAgentsRoutes, method, path, OPERATOR, { body: '{bad', overrides: { config } });
    expect(allowed).toEqual({ status: 400, body: { error: 'Invalid JSON body' } });
  });

  it('POST /api/local-agent-integrations/:id/refresh: agent token → 403; operator reaches id validation', async () => {
    const config = {} as DkgConfig;
    const path = '/api/local-agent-integrations/does-not-exist/refresh';
    const denied = await callRoute(handleLocalAgentsRoutes, 'POST', path, AGENT, { overrides: { config } });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/agent-scoped tokens cannot refresh local agent integrations/);

    const allowed = await callRoute(handleLocalAgentsRoutes, 'POST', path, OPERATOR, { overrides: { config } });
    expect(allowed).toEqual({ status: 404, body: { error: 'Unknown integration' } });
  });

  it('keeps integration reads open to agent tokens', async () => {
    const res = await callRoute(handleLocalAgentsRoutes, 'GET', '/api/local-agent-integrations/not-installed', AGENT);
    expect(res).toEqual({ status: 404, body: { error: 'Unknown integration: not-installed' } });
  });
});

describe('agent registration requires node-admin scope', () => {
  it('POST /api/agent/register: agent token → 403 and no token is minted', async () => {
    const registerAgent = vi.fn();
    const validTokens = new Set<string>();
    const res = await callRoute(handleAgentChatRoutes, 'POST', '/api/agent/register', AGENT, {
      body: '{"name":"second-agent"}',
      agent: { registerAgent },
      overrides: { validTokens },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/agent-scoped tokens cannot register agents/);
    expect(registerAgent).not.toHaveBeenCalled();
    expect(validTokens.size).toBe(0);
  });

  it('POST /api/agent/register: node-operator token registers the agent', async () => {
    const registerAgent = vi.fn(async () => ({
      agentAddress: '0x00000000000000000000000000000000000000b2',
      authToken: 'minted-agent-token',
      mode: 'self-sovereign',
    }));
    const validTokens = new Set<string>();
    const res = await callRoute(handleAgentChatRoutes, 'POST', '/api/agent/register', OPERATOR, {
      body: '{"name":"second-agent","publicKey":"0x02ab"}',
      agent: { registerAgent },
      overrides: { validTokens },
    });
    expect(res.status).toBe(200);
    expect(res.body.authToken).toBe('minted-agent-token');
    expect(registerAgent).toHaveBeenCalledWith('second-agent', { publicKey: '0x02ab', framework: undefined });
    expect(validTokens.has('minted-agent-token')).toBe(true);

    const invalid = await callRoute(handleAgentChatRoutes, 'POST', '/api/agent/register', OPERATOR, { body: '{}' });
    expect(invalid).toEqual({ status: 400, body: { error: 'Missing required field "name"' } });
  });
});

describe('shared memory TTL setting', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  async function ttl(
    method: string,
    pathname: string,
    authentication: AllowedHttpAuthentication,
    body = '',
    config: DkgConfig = {} as DkgConfig,
  ) {
    const res = fakeRes();
    const setSharedMemoryTtlMs = vi.fn();
    const saveConfig = vi.fn(async () => {});
    const handled = await handleSharedMemoryTtlSettingsRequest({
      req: fakeReq(method, pathname, body),
      res: res as unknown as ServerResponse,
      pathname,
      authentication,
      config,
      setSharedMemoryTtlMs,
      saveConfig,
    });
    return {
      handled,
      status: res.statusCode,
      body: res.body ? JSON.parse(res.body) as Record<string, unknown> : {},
      setSharedMemoryTtlMs,
      saveConfig,
      config,
    };
  }

  it.each(['/api/settings/shared-memory-ttl', '/api/settings/workspace-ttl'])(
    'PUT %s: agent token → 403 and the setting is unchanged',
    async (path) => {
      const r = await ttl('PUT', path, AGENT, '{"ttlDays":1}');
      expect(r.handled).toBe(true);
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/agent-scoped tokens cannot change node settings/);
      expect(r.config).toEqual({});
      expect(r.setSharedMemoryTtlMs).not.toHaveBeenCalled();
      expect(r.saveConfig).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['node-operator token', OPERATOR],
    ['auth disabled', AUTH_DISABLED],
  ])('PUT: %s updates and persists the setting', async (_label, authentication) => {
    const r = await ttl('PUT', '/api/settings/shared-memory-ttl', authentication, '{"ttlDays":7}');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, ttlMs: 7 * DAY_MS, ttlDays: 7 });
    expect(r.config.sharedMemoryTtlMs).toBe(7 * DAY_MS);
    expect(r.config.workspaceTtlMs).toBe(7 * DAY_MS);
    expect(r.setSharedMemoryTtlMs).toHaveBeenCalledWith(7 * DAY_MS);
    expect(r.saveConfig).toHaveBeenCalledWith(r.config);
  });

  it('PUT: rejects an invalid value from a node-operator token', async () => {
    const r = await ttl('PUT', '/api/settings/shared-memory-ttl', OPERATOR, '{"ttlDays":-1}');
    expect(r.status).toBe(400);
    expect(r.saveConfig).not.toHaveBeenCalled();
    const malformed = await ttl('PUT', '/api/settings/shared-memory-ttl', OPERATOR, '{bad');
    expect(malformed.status).toBe(500);
    expect(malformed.saveConfig).not.toHaveBeenCalled();
  });

  it('GET stays open to agent tokens and reports the configured value', async () => {
    const r = await ttl('GET', '/api/settings/workspace-ttl', AGENT, '', { sharedMemoryTtlMs: 2 * DAY_MS } as DkgConfig);
    expect(r.body).toEqual({ ttlMs: 2 * DAY_MS, ttlDays: 2 });
    const unset = await ttl('GET', '/api/settings/shared-memory-ttl', AGENT);
    expect(unset.body).toEqual({ ttlMs: 30 * DAY_MS, ttlDays: 30 });
  });

  it('leaves other methods and paths to later handlers', async () => {
    expect((await ttl('POST', '/api/settings/shared-memory-ttl', OPERATOR)).handled).toBe(false);
    expect((await ttl('PUT', '/api/settings/retention', OPERATOR)).handled).toBe(false);
  });
});

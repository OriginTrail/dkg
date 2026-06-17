/**
 * Daemon shared-model route validation (PR #1158, #4 + #5).
 *
 * #4 — the native `/model/invoke` route must reject structurally-broken
 *      `messages` with a clear 400 (not a 500 deep in the provider call); the
 *      OpenAI `/v1/chat/completions` route must return an `openAiErrorBody`
 *      400 for a malformed body.
 * #5 — `invite-with-model` must return 200 with `modelShared:false` +
 *      `modelShareError` when the invite SUCCEEDED but the share step failed,
 *      so callers don't retry against partially-applied membership state.
 */
import { describe, it, expect } from 'vitest';
import { handleSharedModelRoutes } from '../src/daemon/routes/shared-model.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.end = (body: string) => { res.body = body; };
  return res;
}

function fakeReq(method: string, path: string, body?: unknown, rawBody?: string) {
  const req: any = { method, url: path };
  if (rawBody !== undefined) {
    req.__dkgPrebufferedBody = Buffer.from(rawBody);
  } else if (body !== undefined) {
    req.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  }
  return req;
}

function runCtx(method: string, rawPath: string, agent: any, opts: { body?: unknown; rawBody?: string; requestAgentAddress?: string } = {}) {
  const res = fakeRes();
  const url = new URL(`http://127.0.0.1${rawPath}`);
  const ctx = {
    req: fakeReq(method, rawPath, opts.body, opts.rawBody),
    res,
    agent,
    path: url.pathname,
    url,
    requestAgentAddress: opts.requestAgentAddress,
  } as unknown as RequestContext;
  return { res, done: handleSharedModelRoutes(ctx) };
}

const INVOKE = '/api/context-graph/cg1/model/invoke';
const OPENAI = '/api/context-graph/cg1/model/v1/chat/completions';
const INVITE = '/api/context-graph/cg1/invite-with-model';

describe('native /model/invoke message validation (#4)', () => {
  // The agent must NOT be reached for invalid bodies — fail loudly if it is.
  const agent = { invokeContextGraphModel: async () => { throw new Error('agent should not be called for invalid body'); } };

  it('rejects a message missing content → 400', async () => {
    const { res, done } = runCtx('POST', INVOKE, agent, { body: { messages: [{ role: 'user' }] } });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/content must be a string/i);
  });

  it('rejects non-string content → 400', async () => {
    const { res, done } = runCtx('POST', INVOKE, agent, { body: { messages: [{ role: 'user', content: 1 }] } });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/content must be a string/i);
  });

  it('rejects an unknown role → 400', async () => {
    const { res, done } = runCtx('POST', INVOKE, agent, { body: { messages: [{ role: 'tool', content: 'x' }] } });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/role must be one of/i);
  });

  it('rejects an empty array → 400', async () => {
    const { res, done } = runCtx('POST', INVOKE, agent, { body: { messages: [] } });
    await done;
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-JSON body → 400 (not 500)', async () => {
    const { res, done } = runCtx('POST', INVOKE, agent, { rawBody: 'not json{' });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/valid JSON/i);
  });

  it('accepts a well-formed body and reaches the agent', async () => {
    const okAgent = { invokeContextGraphModel: async () => ({ ok: true, content: 'hi', model: 'm' }) };
    const { res, done } = runCtx('POST', INVOKE, okAgent, { body: { messages: [{ role: 'user', content: 'hi' }] } });
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).content).toBe('hi');
  });
});

describe('OpenAI /v1/chat/completions validation (#4)', () => {
  const agent = { invokeContextGraphModel: async () => { throw new Error('agent should not be called for invalid body'); } };

  it('returns an OpenAI-shaped 400 for a non-JSON body (not 500)', async () => {
    const { res, done } = runCtx('POST', OPENAI, agent, { rawBody: '{broken' });
    await done;
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.type).toBe('invalid_request_error');
    expect(parsed.error.message).toMatch(/valid JSON/i);
  });

  it('returns an OpenAI-shaped 400 when no usable messages remain', async () => {
    // role-only / non-string-content elements are dropped by the mapper → empty.
    const { res, done } = runCtx('POST', OPENAI, agent, { body: { messages: [{ role: 'user' }] } });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.type).toBe('invalid_request_error');
  });
});

describe('invite-with-model partial success (#5)', () => {
  it('returns 200 modelShared:false + modelShareError when invite OK but share throws', async () => {
    let invited = false;
    const agent = {
      inviteAgentToContextGraph: async () => { invited = true; },
      setContextGraphModelSharing: async () => { throw new Error('share write failed'); },
    };
    const { res, done } = runCtx('POST', INVITE, agent, {
      body: { agentAddress: '0xabc', shareModel: true },
    });
    await done;
    expect(invited).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.modelShared).toBe(false);
    expect(body.modelShareError).toMatch(/share write failed/);
  });

  it('returns 400 when the invite ITSELF fails (nothing applied)', async () => {
    const agent = {
      inviteAgentToContextGraph: async () => { throw new Error('not the curator'); },
      setContextGraphModelSharing: async () => { throw new Error('should not be reached'); },
    };
    const { res, done } = runCtx('POST', INVITE, agent, {
      body: { agentAddress: '0xabc', shareModel: true },
    });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/not the curator/);
  });

  it('returns 200 modelShared:true on full success', async () => {
    const agent = {
      inviteAgentToContextGraph: async () => {},
      setContextGraphModelSharing: async () => {},
    };
    const { res, done } = runCtx('POST', INVITE, agent, {
      body: { agentAddress: '0xabc', shareModel: true },
    });
    await done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.modelShared).toBe(true);
    expect(body.modelShareError).toBeUndefined();
  });

  it('returns 200 modelShared:false (no error) when shareModel not requested', async () => {
    const agent = {
      inviteAgentToContextGraph: async () => {},
      setContextGraphModelSharing: async () => { throw new Error('should not be reached'); },
    };
    const { res, done } = runCtx('POST', INVITE, agent, {
      body: { agentAddress: '0xabc' },
    });
    await done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.modelShared).toBe(false);
    expect(body.modelShareError).toBeUndefined();
  });
});

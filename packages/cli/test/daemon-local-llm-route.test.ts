import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleLocalLlmRoutes } from '../src/daemon/routes/local-llm.js';
import { DaemonLocalLlmError } from '../src/daemon/local-llm-service.js';

describe('daemon local LLM routes', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function request(
    service: Record<string, any>,
    path: string,
    body?: unknown,
    auth: {
      enabled?: boolean;
      requestToken?: string;
      validTokens?: string[];
      agentTokens?: Record<string, string>;
    } = {},
  ) {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      await handleLocalLlmRoutes({
        req,
        res,
        url,
        path: url.pathname,
        localLlm: service,
        config: { auth: { enabled: auth.enabled ?? false } },
        validTokens: new Set(auth.validTokens ?? []),
        requestToken: auth.requestToken,
        requestPrincipal: auth.enabled === false
          ? (auth.requestToken && auth.agentTokens?.[auth.requestToken]
            ? { kind: 'agent', agentAddress: auth.agentTokens[auth.requestToken] }
            : { kind: 'anonymous' })
          : (auth.requestToken && auth.agentTokens?.[auth.requestToken]
            ? { kind: 'agent', agentAddress: auth.agentTokens[auth.requestToken] }
            : { kind: 'nodeOperator' }),
        requestAuthorization: {
          nodeOperator: auth.enabled === false
            || !auth.requestToken
            || !auth.agentTokens?.[auth.requestToken],
        },
        agent: {
          resolveAgentByToken: (token: string) => auth.agentTokens?.[token],
        },
      } as any);
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const url = `http://127.0.0.1:${address.port}${path}`;
    const response = body === undefined
      ? await fetch(url, { method: 'GET' })
      : await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
    const result = { status: response.status, body: await response.json() };
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    return result;
  }

  const service = () => ({
    health: vi.fn(async () => ({ ok: true, ready: true, reachable: true, offline: false })),
    chat: vi.fn(async () => ({
      text: 'answer', sessionId: 'local-llm:dkg-ui', contextGraphId: 'testing',
      profile: 'catalog', toolCalls: [], traceFile: '/tmp/trace.log', readOnly: true,
    })),
    clear: vi.fn(async () => ({ ok: true, sessionId: 'local-llm:dkg-ui', readOnly: true })),
  });

  it('serves health and the complete successful chat envelope', async () => {
    const fake = service();
    expect(await request(fake, '/api/local-llm/health')).toEqual(expect.objectContaining({ status: 200 }));
    const result = await request(fake, '/api/local-llm/chat', {
      message: 'List saved queries', sessionId: 'local-llm:dkg-ui', contextGraphId: 'testing',
    });
    expect(result).toEqual({
      status: 200,
      body: {
        text: 'answer', sessionId: 'local-llm:dkg-ui', contextGraphId: 'testing',
        profile: 'catalog', toolCalls: [], traceFile: '/tmp/trace.log', readOnly: true,
      },
    });
    expect(fake.chat).toHaveBeenCalledWith(expect.objectContaining({
      message: 'List saved queries',
      contextGraphId: 'testing',
      signal: expect.anything(),
    }));
  });

  it('rejects agent-scoped callers before they can start or clear the node-admin session', async () => {
    const fake = service();
    const agentAuth = {
      enabled: true,
      requestToken: 'agent-token',
      validTokens: ['node-admin-token', 'agent-token'],
      agentTokens: { 'agent-token': 'did:dkg:agent:limited' },
    };

    expect(await request(fake, '/api/local-llm/chat', {
      message: 'Read graph-b',
      contextGraphId: 'graph-b',
    }, agentAuth)).toEqual({
      status: 403,
      body: expect.objectContaining({ code: 'LOCAL_LLM_FORBIDDEN' }),
    });
    expect(await request(fake, '/api/local-llm/session/clear', {}, agentAuth)).toEqual({
      status: 403,
      body: expect.objectContaining({ code: 'LOCAL_LLM_FORBIDDEN' }),
    });
    expect(fake.chat).not.toHaveBeenCalled();
    expect(fake.clear).not.toHaveBeenCalled();
  });

  it('preserves node-admin access when HTTP authentication is enabled', async () => {
    const fake = service();
    const result = await request(fake, '/api/local-llm/chat', {
      message: 'Read the selected graph',
      contextGraphId: 'graph-a',
    }, {
      enabled: true,
      requestToken: 'node-admin-token',
      validTokens: ['node-admin-token'],
    });

    expect(result.status).toBe(200);
    expect(fake.chat).toHaveBeenCalledOnce();
  });

  it('propagates a disconnected HTTP caller into the daemon turn signal', async () => {
    let aborted!: () => void;
    const observedAbort = new Promise<void>((resolve) => { aborted = resolve; });
    const fake = service();
    fake.chat.mockImplementationOnce(async (input: { signal?: AbortSignal }) => {
      await new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => {
          aborted();
          reject(input.signal?.reason);
        }, { once: true });
      });
    });
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      await handleLocalLlmRoutes({
        req,
        res,
        url,
        path: url.pathname,
        localLlm: fake,
        config: { auth: { enabled: false } },
        validTokens: new Set(),
        requestToken: undefined,
        requestPrincipal: { kind: 'nodeOperator' },
        requestAuthorization: { nodeOperator: true },
        agent: { resolveAgentByToken: () => undefined },
      } as any);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const client = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      path: '/api/local-llm/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    client.on('error', () => undefined);
    client.end(JSON.stringify({ message: 'slow', contextGraphId: 'graph-a' }));
    await vi.waitFor(() => expect(fake.chat).toHaveBeenCalledOnce());

    client.destroy();
    await observedAbort;
    expect(fake.chat.mock.calls[0][0].signal.aborted).toBe(true);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it.each([
    [{}, /message/i],
    [{ message: '' }, /message/i],
    [{ message: 'x'.repeat(16_001) }, /exceeds/i],
    [{ message: 'hello', sessionId: 'another-session' }, /sessionId/i],
    [{ message: 'hello', contextGraphId: '../bad' }, /contextGraphId/i],
    [{ message: 'hello', allowWrite: true }, /unsupported/i],
  ])('rejects invalid chat input %#', async (body, error) => {
    const result = await request(service(), '/api/local-llm/chat', body);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('LOCAL_LLM_INVALID_REQUEST');
    expect(result.body.error).toMatch(error);
  });

  it('maps busy/project/offline/runtime service errors without leaking options', async () => {
    for (const [code, status] of [
      ['LOCAL_LLM_BUSY', 409],
      ['LOCAL_LLM_PROJECT_MISMATCH', 409],
      ['LOCAL_LLM_OFFLINE', 503],
      ['LOCAL_LLM_RUNTIME_ERROR', 502],
    ] as const) {
      const fake = service();
      fake.chat.mockRejectedValueOnce(new DaemonLocalLlmError(code, status, code));
      const result = await request(fake, '/api/local-llm/chat', { message: 'hello' });
      expect(result).toEqual({ status, body: { error: code, code } });
    }
  });

  it('clears only with an empty request body', async () => {
    const fake = service();
    expect(await request(fake, '/api/local-llm/session/clear', {})).toEqual({
      status: 200,
      body: { ok: true, sessionId: 'local-llm:dkg-ui', readOnly: true },
    });
    expect(fake.clear).toHaveBeenCalledOnce();
    expect((await request(service(), '/api/local-llm/session/clear', { project: 'x' })).status).toBe(400);
  });
});

import { createServer, type Server } from 'node:http';
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
  ) {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      await handleLocalLlmRoutes({
        req, res, url, path: url.pathname, localLlm: service,
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
    expect(fake.chat).toHaveBeenCalledWith({ message: 'List saved queries', contextGraphId: 'testing' });
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

import { describe, expect, it, vi } from 'vitest';
import { handleAgentChatRoutes } from '../src/daemon/routes/agent-chat.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.end = (body: string) => { res.body = body; };
  return res;
}

function runConnect(agent: any, body: unknown) {
  const path = '/api/connect';
  const req: any = {
    method: 'POST',
    url: path,
    headers: {},
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)),
  };
  const res = fakeRes();
  const url = new URL(`http://127.0.0.1${path}`);
  const ctx = {
    req,
    res,
    agent,
    path,
    url,
    validTokens: new Set<string>(),
    requestToken: undefined,
    requestAgentAddress: '',
  } as unknown as RequestContext;
  return { res, done: handleAgentChatRoutes(ctx) };
}

describe('POST /api/connect', () => {
  it('maps retryable network-admission probe failures to HTTP 503', async () => {
    const error = Object.assign(new Error('probe backed off'), {
      code: 'NETWORK_ADMISSION_PROBE_FAILED',
    });
    const agent = {
      connectToPeerId: vi.fn(async () => { throw error; }),
      connectTo: vi.fn(async () => undefined),
    };

    const { res, done } = runConnect(agent, { peerId: '12D3KooWfixture' });
    await done;

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      error: 'probe backed off',
      code: 'NETWORK_ADMISSION_PROBE_FAILED',
    });
    expect(agent.connectToPeerId).toHaveBeenCalledWith('12D3KooWfixture');
    expect(agent.connectTo).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { classifyAgentConnectError } from '../src/daemon/routes/agent-connect-error.js';
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
  it.each([
    ['INVALID_PEER_ID', 400],
    ['SELF_DIAL', 400],
    ['NETWORK_ADMISSION_REJECTED', 403],
    ['PEER_NOT_FOUND', 404],
    ['DIAL_FAILED', 502],
    ['DHT_UNAVAILABLE', 503],
    ['PEER_ROUTING_UNAVAILABLE', 503],
    ['NETWORK_ADMISSION_PROBE_FAILED', 503],
    ['DHT_TIMEOUT', 504],
    ['CONNECT_TIMEOUT', 504],
  ])('maps agent connect error %s to HTTP %i', (code, status) => {
    expect(classifyAgentConnectError(Object.assign(new Error('connect failed'), { code })))
      .toEqual({
        status,
        body: { error: 'connect failed', code },
      });
  });

  it.each([
    'UNKNOWN_CONNECT_ERROR',
    'toString',
    'constructor',
    '__proto__',
  ])('preserves the legacy fallback for unknown code %s', (code) => {
    expect(classifyAgentConnectError({ code, message: 'unknown' })).toEqual({
        status: 400,
        body: { error: 'unknown', code },
      });
  });

  it('preserves legacy fallback behavior for a missing error code', () => {
    expect(classifyAgentConnectError({ message: undefined })).toEqual({
      status: 400,
      body: { error: 'Failed to connect' },
    });
  });

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

  it('uses the same classifier for multiaddr connects', async () => {
    const error = Object.assign(new Error('wrong network'), {
      code: 'NETWORK_ADMISSION_REJECTED',
    });
    const agent = {
      connectToPeerId: vi.fn(async () => undefined),
      connectTo: vi.fn(async () => { throw error; }),
    };

    const multiaddr = '/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWfixture';
    const { res, done } = runConnect(agent, { multiaddr });
    await done;

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'wrong network',
      code: 'NETWORK_ADMISSION_REJECTED',
    });
    expect(agent.connectTo).toHaveBeenCalledWith(multiaddr);
    expect(agent.connectToPeerId).not.toHaveBeenCalled();
  });

  it.each([
    [{ peerId: '12D3KooWfixture' }, 'connectToPeerId'],
    [{ multiaddr: '/ip4/127.0.0.1/tcp/9090' }, 'connectTo'],
  ] as const)('preserves successful %s dispatch', async (body, expectedMethod) => {
    const agent = {
      connectToPeerId: vi.fn(async () => undefined),
      connectTo: vi.fn(async () => undefined),
    };

    const { res, done } = runConnect(agent, body);
    await done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ connected: true });
    expect(agent[expectedMethod]).toHaveBeenCalledOnce();
    const otherMethod = expectedMethod === 'connectToPeerId' ? 'connectTo' : 'connectToPeerId';
    expect(agent[otherMethod]).not.toHaveBeenCalled();
  });
});

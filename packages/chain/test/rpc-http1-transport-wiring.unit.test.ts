import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchRequest } from 'ethers';

const HTTP1_DISPATCHER = Object.freeze({ kind: 'http1-dispatcher-sentinel' });
const boundaryInits: RequestInit[] = [];

vi.mock('../src/rpc-http1-dispatcher.js', () => ({
  chainRpcFetchInit: (init: RequestInit) => {
    boundaryInits.push(init);
    return { ...init, dispatcher: HTTP1_DISPATCHER };
  },
}));

const { cancellableRpcGetUrl } = await import('../src/rpc-request-transport.js');
const { postStrictFinalizedJsonRpcV1 } = await import('../src/strict-current-finalized-evm-rpc-client.js');

function captureFetch(result: unknown): { calls: Array<{ url: string; init: Record<string, unknown> }> } {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', async (url: string, init: Record<string, unknown>) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  boundaryInits.length = 0;
});

describe('chain RPC fetches go through chainRpcFetchInit (#2828)', () => {
  it('the ethers RPC transport does, on every request', async () => {
    const { calls } = captureFetch('0x1');
    const request = new FetchRequest('https://rpc.example.invalid/');
    request.body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });

    const response = await cancellableRpcGetUrl(request);

    expect(response.statusCode).toBe(200);
    expect(boundaryInits).toHaveLength(1);
    expect(boundaryInits[0]).toMatchObject({ method: 'POST' });
    expect(boundaryInits[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init).toEqual({ ...boundaryInits[0], dispatcher: HTTP1_DISPATCHER });
  });

  it('the strict finalized RPC client does too', async () => {
    const { calls } = captureFetch('0x1');

    await postStrictFinalizedJsonRpcV1(
      'https://rpc.example.invalid/',
      1,
      'eth_blockNumber',
      [],
      64 * 1024,
      new AbortController().signal,
    );

    expect(boundaryInits).toHaveLength(1);
    expect(boundaryInits[0]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init).toEqual({ ...boundaryInits[0], dispatcher: HTTP1_DISPATCHER });
  });
});

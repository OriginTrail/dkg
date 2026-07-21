import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAgentChatRoutes } from '../src/daemon/routes/agent-chat.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { daemonState } from '../src/daemon/state.js';

function fakeResponse() {
  const response: any = { statusCode: 0, body: '', headers: {} };
  response.writeHead = (statusCode: number, headers?: Record<string, string>) => {
    response.statusCode = statusCode;
    Object.assign(response.headers, headers);
    return response;
  };
  response.end = (body = '') => {
    response.body = body;
  };
  return response;
}

async function request(rawPath: string): Promise<{ statusCode: number; body: unknown }> {
  const url = new URL(`http://127.0.0.1${rawPath}`);
  const response = fakeResponse();
  await handleAgentChatRoutes({
    req: { method: 'GET', url: rawPath } as RequestContext['req'],
    res: response,
    path: url.pathname,
    url,
  } as unknown as RequestContext);
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body),
  };
}

afterEach(() => {
  daemonState.walRuntime = null;
  daemonState.walWireRuntime = null;
  vi.restoreAllMocks();
});

describe('GET /api/wal/capabilities', () => {
  it('rejects a request without a peer identity', async () => {
    expect(await request('/api/wal/capabilities')).toEqual({
      statusCode: 400,
      body: { error: 'Missing "peerId" query param' },
    });
  });

  it('fails closed when the daemon has not registered the raw WAL protocols', async () => {
    expect(await request('/api/wal/capabilities?peerId=peer-b')).toEqual({
      statusCode: 503,
      body: {
        error: 'WAL raw protocols are not active',
        code: 'WAL_PROTOCOLS_NOT_ACTIVE',
      },
    });
  });

  it('returns decimal strings from a real runtime capability probe', async () => {
    const getCapabilities = vi.fn(async () => [
      [1n], [1n], 1_048_576n, 4_096n, 4_096n, 1_048_576n,
      8_589_934_592n, 16n,
    ] as const);
    daemonState.walRuntime = {
      status: () => ({ protocolsRegistered: true }),
    } as unknown as NonNullable<typeof daemonState.walRuntime>;
    daemonState.walWireRuntime = {
      getCapabilities,
    } as unknown as NonNullable<typeof daemonState.walWireRuntime>;

    expect(await request('/api/wal/capabilities?peerId=peer-b')).toEqual({
      statusCode: 200,
      body: {
        peerId: 'peer-b',
        protocolVersions: ['1'],
        adapterVersions: ['1'],
        maximumControlFrameBytes: '1048576',
        maximumSymbolsPerResponse: '4096',
        maximumFallbackIdsPerPage: '4096',
        maximumObjectRangeBytes: '1048576',
        maximumWalObjectBytes: '8589934592',
        maximumConcurrentRanges: '16',
      },
    });
    expect(getCapabilities).toHaveBeenCalledWith('peer-b');
  });
});

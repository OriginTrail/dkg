import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DkgConfig } from '../src/config.js';
import {
  getPrimeAgentChannelTargets,
  isPrimeAgentLoopbackUrl,
  normalizePrimeAgentChatPayload,
  normalizePrimeAgentPersistTurnPayload,
  probePrimeAgentChannelHealth,
  readPrimeAgentSessions,
  transportPatchFromPrimeAgentTarget,
} from '../src/daemon/prime-agent.js';
import { handlePrimeAgentRoutes } from '../src/daemon/routes/prime-agent.js';
import { handleLocalAgentsRoutes } from '../src/daemon/routes/local-agents.js';
import {
  connectLocalAgentIntegrationFromUi,
  refreshLocalAgentIntegrationFromUi,
} from '../src/daemon/local-agents.js';

// The setup entry pulls in the adapter's runtime; the daemon only ever calls it
// on disconnect, and none of these tests exercise that path.
vi.mock('@origintrail-official/dkg-adapter-prime-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@origintrail-official/dkg-adapter-prime-agent')>()),
  restorePrimeAgentProfile: vi.fn(async () => ({ ok: true })),
}));

let agentDir: string;
let sessionsDir: string;
let bridges: Server[] = [];

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'dkg-prime-agent-test-'));
  sessionsDir = join(agentDir, '.dkg-adapter-prime-agent', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
  delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
  await Promise.all(bridges.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  bridges = [];
  rmSync(agentDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<DkgConfig> = {}): DkgConfig {
  return {
    name: 'test-node',
    apiPort: 9200,
    listenPort: 0,
    nodeRole: 'edge',
    ...overrides,
  } as DkgConfig;
}

function enabledConfig(): DkgConfig {
  return makeConfig({
    localAgentIntegrations: {
      'prime-agent': {
        enabled: true,
        capabilities: { localChat: true },
        transport: { kind: 'prime-agent-channel' },
      },
    },
  } as Partial<DkgConfig>);
}

function makeJsonRequest(method: string, path: string, payload?: unknown) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = {};
  setTimeout(() => {
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  }, 0);
  return req;
}

function makeJsonResponse() {
  const res = new EventEmitter() as any;
  res.statusCode = 0;
  res.headers = {};
  res.body = '';
  res.writableEnded = false;
  res.headersSent = false;
  res.writeHead = (status: number, headers: Record<string, string>) => {
    res.statusCode = status;
    res.headers = headers;
    res.headersSent = true;
  };
  res.write = (chunk: string | Uint8Array) => {
    // The stream pump forwards raw Uint8Array chunks, not Node Buffers.
    res.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  res.end = (chunk?: string | Buffer) => {
    if (chunk) res.write(chunk);
    res.writableEnded = true;
  };
  return res;
}

function makeMemoryManager() {
  const stored: any[] = [];
  const transitions: any[] = [];
  return {
    stored,
    transitions,
    getChatTurnPersistenceState: vi.fn(async () => null),
    storeChatExchange: vi.fn(async (...args: any[]) => {
      stored.push(args);
    }),
    recordChatTurnPersistenceTransition: vi.fn(async (...args: any[]) => {
      transitions.push(args);
    }),
  };
}

/**
 * A stand-in for the extension-hosted bridge. Real one, on a real ephemeral
 * loopback port, so the descriptor -> target -> fetch path is exercised end to
 * end rather than mocked at the fetch boundary.
 */
async function startStubBridge(opts: {
  sessionId: string;
  sendStatus?: number;
  sendBody?: unknown;
  healthSessionId?: string;
  healthState?: Record<string, unknown>;
  /** SSE frames served from `/stream`, verbatim. */
  streamFrames?: string[];
} ): Promise<{ url: string; seen: { headers: Record<string, string | undefined>; body: any } | null }> {
  const seen: { headers: Record<string, string | undefined>; body: any } | null = null as any;
  const state = { value: seen };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          sessionId: opts.healthSessionId ?? opts.sessionId,
          pid: process.pid,
          ...(opts.healthState ?? {}),
        }));
        return;
      }
      state.value = { headers: req.headers as any, body: raw ? JSON.parse(raw) : null };
      if (req.url === '/stream' && opts.streamFrames) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        for (const frame of opts.streamFrames) res.write(frame);
        // Deliberately NOT ending: the real extension bridge holds the socket
        // open after the final frame, which is the condition under test.
        return;
      }
      const status = opts.sendStatus ?? 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(opts.sendBody ?? { text: 'pong', correlationId: 'c1' }));
    });
  });
  bridges.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, get seen() { return state.value; } } as any;
}

function writeDescriptor(
  sessionId: string,
  bridgeUrl: string,
  pid = process.pid,
  activeAt = new Date().toISOString(),
): void {
  writeFileSync(
    join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({ sessionId, bridgeUrl, pid, startedAt: activeAt, lastActiveAt: activeAt }),
  );
}

describe('prime-agent session discovery', () => {
  it('ignores a descriptor pointing off-box', () => {
    writeDescriptor('remote', 'http://10.0.0.5:9999');
    expect(readPrimeAgentSessions()).toEqual([]);
    expect(isPrimeAgentLoopbackUrl('http://10.0.0.5:9999')).toBe(false);
    expect(isPrimeAgentLoopbackUrl('http://127.0.0.1:1234')).toBe(true);
    expect(isPrimeAgentLoopbackUrl('http://127.evil.example.com:1234')).toBe(false);
  });

  it('prunes a descriptor whose process is gone', () => {
    // PID 1 exists; a very high PID reliably does not.
    writeDescriptor('dead', 'http://127.0.0.1:1234', 4_194_303);
    expect(readPrimeAgentSessions()).toEqual([]);
  });

  it('returns no target for an unknown explicit session rather than falling back', () => {
    writeDescriptor('live-one', 'http://127.0.0.1:1234');
    expect(getPrimeAgentChannelTargets({ sessionId: 'live-one' })).toHaveLength(1);
    expect(getPrimeAgentChannelTargets({ sessionId: 'not-a-session' })).toEqual([]);
  });

  it('maps a target back to a transport patch without the route suffix', () => {
    const [target] = (() => {
      writeDescriptor('s1', 'http://127.0.0.1:4321');
      return getPrimeAgentChannelTargets({});
    })();
    expect(transportPatchFromPrimeAgentTarget(target)).toEqual({
      kind: 'prime-agent-channel',
      bridgeUrl: 'http://127.0.0.1:4321',
      healthUrl: 'http://127.0.0.1:4321/health',
    });
  });
});

describe('prime-agent chat payload', () => {
  it('rejects a session id that could escape the descriptor directory', () => {
    const result = normalizePrimeAgentChatPayload({ text: 'hi', correlationId: 'c', sessionId: '../../etc/passwd' });
    expect(result).toEqual({ error: 'Invalid "sessionId"' });
  });

  it('requires text and correlationId', () => {
    expect(normalizePrimeAgentChatPayload({ correlationId: 'c' })).toEqual({ error: 'Missing "text"' });
    expect(normalizePrimeAgentChatPayload({ text: 'hi' })).toEqual({ error: 'Missing "correlationId"' });
  });
});

describe('/api/prime-agent-channel/health', () => {
  it('reports zero sessions as idle, not as a server error', async () => {
    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('GET', '/api/prime-agent-channel/health'),
      res,
      config: makeConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/health',
    } as any);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, sessionCount: 0 });
  });

  it('reports ok once a live bridge answers', async () => {
    const bridge = await startStubBridge({ sessionId: 's1' });
    writeDescriptor('s1', bridge.url);

    const report = await probePrimeAgentChannelHealth('bridge-token');
    expect(report).toMatchObject({ ok: true, sessionCount: 1, target: 's1' });
  });

  it('surfaces a recoverable disconnected-client turn state from the selected session', async () => {
    const bridge = await startStubBridge({
      sessionId: 's-working',
      healthState: {
        busy: true,
        turnState: 'running',
        clientConnected: false,
        clientDisconnectedAt: '2026-08-07T12:34:56.000Z',
      },
    });
    writeDescriptor('s-working', bridge.url);
    const res = makeJsonResponse();

    await handlePrimeAgentRoutes({
      req: makeJsonRequest('GET', '/api/prime-agent-channel/health'),
      res,
      config: makeConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/health',
    } as any);

    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      target: 's-working',
      busy: true,
      turnState: 'running',
      clientConnected: false,
      clientDisconnectedAt: '2026-08-07T12:34:56.000Z',
    });
  });

  it('rejects a bridge whose session id does not match the descriptor', async () => {
    // A recycled port: some other process now owns it and reports its own id.
    const bridge = await startStubBridge({ sessionId: 's1', healthSessionId: 'someone-else' });
    writeDescriptor('s1', bridge.url);

    const report = await probePrimeAgentChannelHealth('bridge-token');
    expect(report.ok).toBe(false);
    expect(report.error).toContain('someone-else');
  });
});

describe('/api/prime-agent-channel/send', () => {
  it('refuses when the integration is not enabled', async () => {
    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', { text: 'hi', correlationId: 'c1' }),
      res,
      config: makeConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
    } as any);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('INTEGRATION_DISABLED');
  });

  it('returns a session-specific 409 when nothing is live', async () => {
    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', { text: 'hi', correlationId: 'c1' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
    } as any);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('PRIME_AGENT_NO_SESSION');
  });

  it('forwards to the live session with the bridge token', async () => {
    const bridge = await startStubBridge({ sessionId: 's1', sendBody: { text: 'pong', correlationId: 'c1' } });
    writeDescriptor('s1', bridge.url);
    const memoryManager = makeMemoryManager();

    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', { text: 'hi', correlationId: 'c1' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
      requestAgentAddress: '0x0000000000000000000000000000000000000001',
      memoryManager,
    } as any);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      text: 'pong',
      sessionId: 'prime-agent:dkg-ui:s1',
      correlationId: 'c1',
      turnId: 'c1',
    });
    expect(bridge.seen?.headers['x-dkg-bridge-token']).toBe('bridge-token');
    expect(bridge.seen?.body).toMatchObject({ text: 'hi', sessionId: 's1' });
    expect(memoryManager.storeChatExchange).toHaveBeenCalledWith(
      'prime-agent:dkg-ui:s1',
      'hi',
      'pong',
      undefined,
      expect.objectContaining({ turnId: 'c1', persistenceState: 'stored' }),
    );
  });

  it('does not silently reroute when the addressed session is gone', async () => {
    // The safety property: a message addressed to session A must never land in
    // session B just because B happens to be alive.
    const bridge = await startStubBridge({ sessionId: 'other' });
    writeDescriptor('other', bridge.url);

    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', {
        text: 'hi',
        correlationId: 'c1',
        sessionId: 'gone',
      }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
    } as any);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('PRIME_AGENT_NO_SESSION');
    expect(bridge.seen).toBeNull();
  });

  it('503s instead of delivering when the health echo names another session', async () => {
    // A recycled port whose new owner answers ok:true would pass a gate that
    // only reads `ok` — and the chat would land in the wrong conversation.
    const bridge = await startStubBridge({ sessionId: 's1', healthSessionId: 'someone-else' });
    writeDescriptor('s1', bridge.url);

    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', { text: 'hi', correlationId: 'c1' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
    } as any);

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('PRIME_AGENT_BRIDGE_OFFLINE');
    expect(body.details).toContain('someone-else');
    expect(body.details).toContain('s1');
    // The gate must refuse BEFORE delivery: no /send reached the bridge.
    expect(bridge.seen).toBeNull();
  });

  it('surfaces the bridge one-turn guard as busy rather than as a fault', async () => {
    const bridge = await startStubBridge({ sessionId: 's1', sendStatus: 429, sendBody: { error: 'turn in progress' } });
    writeDescriptor('s1', bridge.url);

    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', { text: 'hi', correlationId: 'c1' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
    } as any);

    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).code).toBe('PRIME_AGENT_SESSION_BUSY');
  });

  it('preserves an allowlisted provider-auth code without forwarding raw provider details', async () => {
    const bridge = await startStubBridge({
      sessionId: 's1',
      sendStatus: 503,
      sendBody: {
        error: 'Unauthorized: provider key sk-must-not-leak',
        code: 'PRIME_AGENT_PROVIDER_UNAUTHORIZED',
        details: { providerToken: 'must-not-leak' },
      },
    });
    writeDescriptor('s1', bridge.url);

    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', { text: 'hi', correlationId: 'c-auth' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
    } as any);

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      code: 'PRIME_AGENT_PROVIDER_UNAUTHORIZED',
      error: 'Prime Agent provider authentication failed. Check the configured provider credentials.',
      source: 'prime-agent-channel',
      correlationId: 'c-auth',
      retryable: false,
    });
    expect(res.body).not.toContain('must-not-leak');
    expect(res.body).not.toContain('sk-');
  });

  it('forwards the partial transcript with a terminal code while replacing the bridge message', async () => {
    const bridge = await startStubBridge({
      sessionId: 's1',
      sendStatus: 503,
      sendBody: {
        error: 'Prime Agent turn exceeded the 3300000ms hard limit.',
        code: 'PRIME_AGENT_TURN_TIMEOUT',
        text: 'partial answer so far',
        details: { providerToken: 'must-not-leak' },
      },
    });
    writeDescriptor('s1', bridge.url);

    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', { text: 'hi', correlationId: 'c-hard' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
    } as any);

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      code: 'PRIME_AGENT_TURN_TIMEOUT',
      error: 'Prime Agent turn exceeded its hard limit.',
      // The partial transcript is deltas-only output and reaches the UI, just
      // like the idle-timeout 504 below preserves it.
      text: 'partial answer so far',
      source: 'prime-agent-channel',
      correlationId: 'c-hard',
      retryable: false,
    });
    // The daemon substitutes its own message and never forwards bridge details.
    expect(res.body).not.toContain('must-not-leak');
    expect(res.body).not.toContain('3300000');
  });

  it('treats a prototype-key bridge code as a generic bridge error, not an allowlist hit', async () => {
    const bridge = await startStubBridge({
      sessionId: 's1',
      sendStatus: 503,
      sendBody: { error: 'boom', code: 'constructor' },
    });
    writeDescriptor('s1', bridge.url);

    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', { text: 'hi', correlationId: 'c-proto' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
    } as any);

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).code).toBe('BRIDGE_ERROR');
  });

  it('propagates the bridge idle timeout with its partial text instead of a generic 502', async () => {
    const bridge = await startStubBridge({
      sessionId: 's1',
      sendStatus: 504,
      sendBody: { error: 'idle', text: 'partial answer', timedOut: true, correlationId: 'c-t' },
    });
    writeDescriptor('s1', bridge.url);

    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/send', { text: 'hi', correlationId: 'c-t' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/send',
    } as any);

    expect(res.statusCode).toBe(504);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('PRIME_AGENT_BRIDGE_RESPONSE_TIMEOUT');
    expect(body.text).toBe('partial answer');
    expect(body.timedOut).toBe(true);
  });
});

describe('/api/prime-agent-channel/stream', () => {
  it('declares text/event-stream before the first byte and closes on the final frame', async () => {
    // Both halves of the browser-side bug in one test: without the header the
    // client misclassifies the body and throws "The string did not match the
    // expected pattern"; without terminal-frame handling the response never
    // closes, because this stub bridge — like the real one — keeps its socket
    // open after the final frame.
    const bridge = await startStubBridge({
      sessionId: 's1',
      streamFrames: [
        'data: {"type":"delta","text":"Hel"}\n\n',
        'data: {"type":"delta","text":"lo!"}\n\n',
        'data: {"type":"final","text":"Hello!","correlationId":"c1"}\n\n',
        'data: {"type":"delta","text":"must-be-dropped"}\n\n',
      ],
    });
    writeDescriptor('s1', bridge.url);
    const memoryManager = makeMemoryManager();

    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/stream', { text: 'hi', correlationId: 'c1' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/stream',
      memoryManager,
    } as any);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['Cache-Control']).toBe('no-cache, no-transform');
    expect(res.headers['X-Accel-Buffering']).toBe('no');
    expect(res.headers.Connection).toBe('keep-alive');
    // Keepalive comments only defeat proxy idle timeouts if fronting proxies
    // flush them; nginx-family buffering is disabled per response.
    expect(res.headers['X-Accel-Buffering']).toBe('no');
    expect(res.writableEnded).toBe(true);
    expect(res.body).toContain('"type":"final"');
    expect(res.body).toContain('Hello!');
    expect(res.body).not.toContain('must-be-dropped');
    expect(memoryManager.storeChatExchange).toHaveBeenCalledWith(
      'prime-agent:dkg-ui:s1',
      'hi',
      'Hello!',
      undefined,
      expect.objectContaining({ turnId: 'c1', persistenceState: 'stored' }),
    );
  });

  it('persists a bridge error followed by final as failed before releasing terminal frames', async () => {
    const bridge = await startStubBridge({
      sessionId: 's1',
      streamFrames: [
        'data: {"type":"delta","text":"partial"}\n\n',
        'data: {"type":"error","error":"provider failed","code":"PRIME_AGENT_PROVIDER_ERROR"}\n\n',
        'data: {"type":"final","text":"partial","correlationId":"c-fail"}\n\n',
      ],
    });
    writeDescriptor('s1', bridge.url);
    let persisted = false;
    const memoryManager = makeMemoryManager();
    memoryManager.storeChatExchange.mockImplementation(async (...args: any[]) => {
      persisted = true;
      memoryManager.stored.push(args);
    });
    const res = makeJsonResponse();
    const writes: string[] = [];
    const originalWrite = res.write;
    res.write = (chunk: string | Uint8Array) => {
      const value = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      if (value.includes('"type":"error"') || value.includes('"type":"final"')) {
        expect(persisted).toBe(true);
      }
      writes.push(value);
      return originalWrite(chunk);
    };

    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/stream', { text: 'hi', correlationId: 'c-fail' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/stream',
      memoryManager,
    } as any);

    expect(memoryManager.storeChatExchange).toHaveBeenCalledWith(
      'prime-agent:dkg-ui:s1',
      'hi',
      'partial',
      undefined,
      expect.objectContaining({
        turnId: 'c-fail',
        persistenceState: 'failed',
        failureReason: 'provider failed',
      }),
    );
    expect(res.body.indexOf('"type":"error"')).toBeLessThan(res.body.indexOf('"type":"final"'));
    expect(writes.join('')).toContain('prime-agent:dkg-ui:s1');
  });

  it('emits a persistence error instead of final when durable storage fails', async () => {
    const bridge = await startStubBridge({
      sessionId: 's1',
      streamFrames: [
        'data: {"type":"delta","text":"answer"}\n\n',
        'data: {"type":"final","text":"answer","correlationId":"c-store-fail"}\n\n',
      ],
    });
    writeDescriptor('s1', bridge.url);
    const memoryManager = makeMemoryManager();
    memoryManager.storeChatExchange.mockRejectedValueOnce(new Error('write failed'));
    const res = makeJsonResponse();

    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/stream', { text: 'hi', correlationId: 'c-store-fail' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/stream',
      memoryManager,
    } as any);

    expect(res.body).toContain('PRIME_AGENT_UI_PERSISTENCE_ERROR');
    expect(res.body).not.toContain('"type":"final"');
  });

  it('persists an adapter-reported turn through the shared chat memory manager', async () => {
    const memoryManager = makeMemoryManager();
    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/persist-turn', {
        sessionId: 's1',
        userMessage: 'hello',
        assistantReply: 'hi there',
        turnId: 'turn-1',
      }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/persist-turn',
      memoryManager,
    } as any);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      sessionId: 'prime-agent:dkg-ui:s1',
      turnId: 'turn-1',
    });
    expect(memoryManager.storeChatExchange).toHaveBeenCalledWith(
      'prime-agent:dkg-ui:s1',
      'hello',
      'hi there',
      undefined,
      expect.objectContaining({ turnId: 'turn-1', persistenceState: 'stored' }),
    );
  });

  it('serializes concurrent persistence reports for the same turn', async () => {
    let state: 'stored' | null = null;
    let releaseStore!: () => void;
    let markStoreStarted!: () => void;
    const storeGate = new Promise<void>((resolve) => { releaseStore = resolve; });
    const storeStarted = new Promise<void>((resolve) => { markStoreStarted = resolve; });
    const memoryManager = {
      getChatTurnPersistenceState: vi.fn(async () => state),
      storeChatExchange: vi.fn(async () => {
        markStoreStarted();
        await storeGate;
        state = 'stored';
      }),
      recordChatTurnPersistenceTransition: vi.fn(async () => {}),
    };
    const payload = {
      sessionId: 's1',
      userMessage: 'hello',
      assistantReply: 'hi there',
      turnId: 'turn-race',
    };
    const invoke = (res: ReturnType<typeof makeJsonResponse>) => handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/persist-turn', payload),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/persist-turn',
      memoryManager,
    } as any);
    const firstRes = makeJsonResponse();
    const secondRes = makeJsonResponse();
    const first = invoke(firstRes);
    await storeStarted;
    const second = invoke(secondRes);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(memoryManager.getChatTurnPersistenceState).toHaveBeenCalledTimes(1);
    expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(1);
    releaseStore();
    await Promise.all([first, second]);

    expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(1);
    expect(memoryManager.getChatTurnPersistenceState).toHaveBeenCalledTimes(2);
    expect([JSON.parse(firstRes.body), JSON.parse(secondRes.body)]).toContainEqual(
      expect.objectContaining({ duplicate: true, turnId: 'turn-race' }),
    );
  });

  it('rejects an explicit unknown persistence state', async () => {
    expect(normalizePrimeAgentPersistTurnPayload({
      sessionId: 's1',
      userMessage: 'hello',
      assistantReply: 'hi',
      persistenceState: 'complete',
    })).toEqual({ error: 'Invalid "persistenceState"' });

    const memoryManager = makeMemoryManager();
    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/persist-turn', {
        sessionId: 's1',
        userMessage: 'hello',
        assistantReply: 'hi',
        persistenceState: 'complete',
      }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/persist-turn',
      memoryManager,
    } as any);

    expect(res.statusCode).toBe(400);
    expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
  });
});

describe('connect from the Node UI', () => {
  it('installs the extension first, then reports idle when no session is live', async () => {
    const runPrimeAgentSetup = vi.fn(async () => ({ ok: true, errors: [], warnings: [] }));
    const config = makeConfig();

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'prime-agent' } as any,
      'bridge-token',
      { runPrimeAgentSetup } as any,
    );

    expect(runPrimeAgentSetup).toHaveBeenCalledOnce();
    // No session yet is expected right after install, so this must not read as
    // a failure to the operator.
    expect(result.integration.runtime?.status).toBe('degraded');
    expect(result.notice).toContain('Start a Prime Agent session');
  });

  it('reports ready and records the routed session once a bridge answers', async () => {
    const bridge = await startStubBridge({ sessionId: 's1' });
    writeDescriptor('s1', bridge.url);
    const runPrimeAgentSetup = vi.fn(async () => ({ ok: true, errors: [], warnings: [] }));

    const result = await connectLocalAgentIntegrationFromUi(
      makeConfig(),
      { id: 'prime-agent' } as any,
      'bridge-token',
      { runPrimeAgentSetup } as any,
    );

    expect(result.integration.runtime?.status).toBe('ready');
    expect(result.integration.metadata).toMatchObject({ sessionCount: 1, activeSessionId: 's1' });
    expect(result.integration.transport).toMatchObject({ kind: 'prime-agent-channel', bridgeUrl: bridge.url });
  });

  it('pins the routing head even when the health probe falls through to an older survivor', async () => {
    const head = await startStubBridge({ sessionId: 'head', healthSessionId: 'recycled-port' });
    const survivor = await startStubBridge({ sessionId: 'survivor' });
    writeDescriptor('head', head.url, process.pid, '2026-08-07T12:00:00.000Z');
    writeDescriptor('survivor', survivor.url, process.pid, '2026-08-07T11:00:00.000Z');

    const result = await connectLocalAgentIntegrationFromUi(
      makeConfig(),
      { id: 'prime-agent' } as any,
      'bridge-token',
      { runPrimeAgentSetup: vi.fn(async () => ({ ok: true, errors: [], warnings: [] })) } as any,
    );

    expect(result.integration.metadata).toMatchObject({
      sessionCount: 2,
      activeSessionId: 'head',
    });
    expect(result.integration.transport?.bridgeUrl).toBe(survivor.url);
  });

  it('refreshes the Prime session pin and clears it after the last session exits', async () => {
    const bridge = await startStubBridge({ sessionId: 'current' });
    writeDescriptor('current', bridge.url);
    const config = enabledConfig();
    config.localAgentIntegrations!['prime-agent'].metadata = {
      sessionCount: 1,
      activeSessionId: 'stale',
    };

    const live = await refreshLocalAgentIntegrationFromUi(config, 'prime-agent', 'bridge-token');
    expect(live.metadata).toMatchObject({ sessionCount: 1, activeSessionId: 'current' });

    rmSync(join(sessionsDir, 'current.json'));
    const idle = await refreshLocalAgentIntegrationFromUi(config, 'prime-agent', 'bridge-token');
    expect(idle.metadata).toMatchObject({ sessionCount: 0, activeSessionId: null });
  });

  it('does not claim to be connected when setup itself failed', async () => {
    const runPrimeAgentSetup = vi.fn(async () => ({
      ok: false,
      errors: ['settings.json is not writable'],
      warnings: [],
    }));

    const result = await connectLocalAgentIntegrationFromUi(
      makeConfig(),
      { id: 'prime-agent' } as any,
      'bridge-token',
      { runPrimeAgentSetup } as any,
    );

    expect(result.integration.runtime?.status).toBe('error');
    expect(result.integration.runtime?.lastError).toContain('not writable');
  });
});

describe('local-agent integrations listing', () => {
  it('reports live Prime Agent session counts so the UI can tell idle from absent', async () => {
    const bridge = await startStubBridge({ sessionId: 's1' });
    writeDescriptor('s1', bridge.url);

    const res = makeJsonResponse();
    await handleLocalAgentsRoutes({
      req: makeJsonRequest('GET', '/api/local-agent-integrations'),
      res,
      config: makeConfig(),
      path: '/api/local-agent-integrations',
      url: new URL('http://127.0.0.1:9200/api/local-agent-integrations'),
    } as any);

    expect(res.statusCode).toBe(200);
    const integrations = JSON.parse(res.body).integrations as Array<{ id: string; metadata?: any }>;
    const primeAgent = integrations.find((entry) => entry.id === 'prime-agent');
    expect(primeAgent?.metadata).toMatchObject({ sessionCount: 1, activeSessionId: 's1' });

    // Single-session agents must not grow a phantom counter.
    expect(integrations.find((entry) => entry.id === 'hermes')?.metadata?.sessionCount).toBeUndefined();
  });

  it('drops a stale persisted activeSessionId when no session is live', async () => {
    // node-ui pins chat to activeSessionId. A zero-session listing that keeps
    // advertising the connect-time id routes every send into a guaranteed 409.
    const config = makeConfig({
      localAgentIntegrations: {
        'prime-agent': {
          enabled: true,
          capabilities: { localChat: true },
          transport: { kind: 'prime-agent-channel' },
          metadata: { sessionCount: 1, activeSessionId: 'stale-connect-time-uuid' },
        },
      },
    } as Partial<DkgConfig>);

    const res = makeJsonResponse();
    await handleLocalAgentsRoutes({
      req: makeJsonRequest('GET', '/api/local-agent-integrations'),
      res,
      config,
      path: '/api/local-agent-integrations',
      url: new URL('http://127.0.0.1:9200/api/local-agent-integrations'),
    } as any);

    expect(res.statusCode).toBe(200);
    const integrations = JSON.parse(res.body).integrations as Array<{ id: string; metadata?: any }>;
    const primeAgent = integrations.find((entry) => entry.id === 'prime-agent');
    expect(primeAgent?.metadata?.sessionCount).toBe(0);
    expect(primeAgent?.metadata?.activeSessionId).toBeUndefined();
    expect(res.body).not.toContain('stale-connect-time-uuid');
  });

  it('applies the session overlay to the single-integration GET as well as the listing', async () => {
    const bridge = await startStubBridge({ sessionId: 's-live' });
    writeDescriptor('s-live', bridge.url);
    // Both persisted fields are deliberately wrong so each overlay half fails
    // independently if the single-integration path bypasses it.
    const config = makeConfig({
      localAgentIntegrations: {
        'prime-agent': {
          enabled: true,
          capabilities: { localChat: true },
          transport: { kind: 'prime-agent-channel' },
          metadata: { sessionCount: 5, activeSessionId: 'stale-connect-time-uuid' },
        },
      },
    } as Partial<DkgConfig>);

    const res = makeJsonResponse();
    await handleLocalAgentsRoutes({
      req: makeJsonRequest('GET', '/api/local-agent-integrations/prime-agent'),
      res,
      config,
      path: '/api/local-agent-integrations/prime-agent',
      url: new URL('http://127.0.0.1:9200/api/local-agent-integrations/prime-agent'),
    } as any);

    expect(res.statusCode).toBe(200);
    const integration = JSON.parse(res.body).integration as { metadata?: any };
    expect(integration.metadata).toMatchObject({ sessionCount: 1, activeSessionId: 's-live' });
  });
});

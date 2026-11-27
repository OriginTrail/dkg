import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DkgConfig } from '../src/config.js';
import { normalizePrimeAgentPersistTurnPayload } from '../src/daemon/prime-agent.js';
import { handlePrimeAgentRoutes } from '../src/daemon/routes/prime-agent.js';

let agentDir: string;
let sessionsDir: string;
let bridges: Server[] = [];

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'dkg-prime-agent-persistence-test-'));
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

function enabledConfig(): DkgConfig {
  return {
    name: 'test-node',
    apiPort: 9200,
    listenPort: 0,
    nodeRole: 'edge',
    localAgentIntegrations: {
      'prime-agent': {
        enabled: true,
        capabilities: { localChat: true },
        transport: { kind: 'prime-agent-channel' },
      },
    },
  } as DkgConfig;
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

async function startStubBridge(opts: {
  sessionId: string;
  streamFrames: string[];
}): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId: opts.sessionId, pid: process.pid }));
      return;
    }
    if (req.url === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      for (const frame of opts.streamFrames) res.write(frame);
    }
  });
  bridges.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, requests };
}

function writeDescriptor(sessionId: string, bridgeUrl: string): void {
  const activeAt = new Date().toISOString();
  writeFileSync(
    join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      bridgeUrl,
      pid: process.pid,
      startedAt: activeAt,
      lastActiveAt: activeAt,
    }),
  );
}

describe('/api/prime-agent-channel/stream', () => {
  it('rejects a prefix-only explicit session without dispatching to the active bridge', async () => {
    const bridge = await startStubBridge({ sessionId: 's1', streamFrames: [] });
    writeDescriptor('s1', bridge.url);
    const memoryManager = makeMemoryManager();
    const res = makeJsonResponse();

    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/stream', {
        text: 'hi',
        correlationId: 'c-prefix-only',
        sessionId: 'prime-agent:dkg-ui:',
      }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/stream',
      memoryManager,
    } as any);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'INVALID_SESSION_ID' });
    expect(bridge.requests).toEqual([]);
    expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
  });

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
    let releaseStore!: () => void;
    let markStoreStarted!: () => void;
    const storeGate = new Promise<void>((resolve) => { releaseStore = resolve; });
    const storeStarted = new Promise<void>((resolve) => { markStoreStarted = resolve; });
    const memoryManager = makeMemoryManager();
    memoryManager.storeChatExchange.mockImplementation(async (...args: any[]) => {
      memoryManager.stored.push(args);
      markStoreStarted();
      await storeGate;
    });
    const res = makeJsonResponse();

    const routePromise = handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/stream', { text: 'hi', correlationId: 'c-fail' }),
      res,
      config: enabledConfig(),
      bridgeAuthToken: 'bridge-token',
      path: '/api/prime-agent-channel/stream',
      memoryManager,
    } as any);

    await storeStarted;
    expect(res.body).toContain('"type":"delta"');
    expect(res.body).not.toContain('"type":"error"');
    expect(res.body).not.toContain('"type":"final"');
    releaseStore();
    await routePromise;

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
    expect(res.body).toContain('prime-agent:dkg-ui:s1');
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

  it.each(['pending', 'failed'] as const)(
    'transitions an existing %s turn to stored without appending another exchange',
    async (existingState) => {
      const memoryManager = makeMemoryManager();
      memoryManager.getChatTurnPersistenceState.mockResolvedValueOnce(existingState);
      const toolCalls = [{ name: 'search', args: { query: 'dkg' }, result: { hits: 1 } }];
      const res = makeJsonResponse();

      await handlePrimeAgentRoutes({
        req: makeJsonRequest('POST', '/api/prime-agent-channel/persist-turn', {
          sessionId: 's1',
          userMessage: 'hello',
          assistantReply: 'completed reply',
          turnId: 'turn-transition',
          persistenceState: 'stored',
          failureReason: 'recovered',
          toolCalls,
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
        transitioned: true,
        sessionId: 'prime-agent:dkg-ui:s1',
        turnId: 'turn-transition',
      });
      expect(memoryManager.recordChatTurnPersistenceTransition).toHaveBeenCalledWith(
        'prime-agent:dkg-ui:s1',
        'turn-transition',
        'stored',
        expect.objectContaining({
          failureReason: 'recovered',
          assistantReply: 'completed reply',
          toolCalls,
        }),
      );
      expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
    },
  );

  it.each([
    { existing: 'failed', incoming: 'failed' },
    { existing: 'failed', incoming: 'pending' },
    { existing: 'stored', incoming: 'failed' },
  ] as const)(
    'keeps an $incoming retry duplicate when the durable state is $existing',
    async ({ existing, incoming }) => {
      const memoryManager = makeMemoryManager();
      memoryManager.getChatTurnPersistenceState.mockResolvedValueOnce(existing);
      const res = makeJsonResponse();

      await handlePrimeAgentRoutes({
        req: makeJsonRequest('POST', '/api/prime-agent-channel/persist-turn', {
          sessionId: 's1',
          userMessage: 'hello',
          assistantReply: 'reply',
          turnId: 'turn-duplicate-rank',
          persistenceState: incoming,
        }),
        res,
        config: enabledConfig(),
        bridgeAuthToken: 'bridge-token',
        path: '/api/prime-agent-channel/persist-turn',
        memoryManager,
      } as any);

      expect(JSON.parse(res.body)).toMatchObject({
        ok: true,
        duplicate: true,
        turnId: 'turn-duplicate-rank',
      });
      expect(memoryManager.recordChatTurnPersistenceTransition).not.toHaveBeenCalled();
      expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    { turnId: 'bad turn' },
    { correlationId: 'bad/turn' },
    { turnId: 'x'.repeat(201) },
  ])('rejects unsafe durable turn identifiers before persistence', async (ids) => {
    const memoryManager = makeMemoryManager();
    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/persist-turn', {
        sessionId: 's1',
        userMessage: 'hello',
        assistantReply: 'hi',
        ...ids,
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

  it.each(['/api/prime-agent-channel/send', '/api/prime-agent-channel/stream'])(
    'rejects an unsafe correlation id before bridge selection on %s',
    async (path) => {
      const res = makeJsonResponse();
      await handlePrimeAgentRoutes({
        req: makeJsonRequest('POST', path, { text: 'hello', correlationId: 'bad turn' }),
        res,
        config: enabledConfig(),
        bridgeAuthToken: 'bridge-token',
        path,
      } as any);

      // With no live descriptor, reaching target selection would return 409.
      // A 400 proves validation happened before any bridge could be dispatched.
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('Invalid "correlationId"');
    },
  );

  it('rejects malformed tool-call args instead of silently casting them', async () => {
    const raw = {
      sessionId: 's1',
      userMessage: 'hello',
      assistantReply: 'hi',
      turnId: 'turn-tools',
      toolCalls: [{ name: 'search', args: 'not-an-object' }],
    };
    expect(normalizePrimeAgentPersistTurnPayload(raw)).toEqual({ error: 'Invalid "toolCalls"' });

    const memoryManager = makeMemoryManager();
    const res = makeJsonResponse();
    await handlePrimeAgentRoutes({
      req: makeJsonRequest('POST', '/api/prime-agent-channel/persist-turn', raw),
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
